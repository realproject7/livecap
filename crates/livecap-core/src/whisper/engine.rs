//! The whisper transcription engine.
//!
//! Ported from Meetily `src/whisper_engine/whisper_engine.rs` (MIT) and
//! reduced to what LiveCap needs: load one model, transcribe 16 kHz mono
//! segments, detect the language, and clean repetitive output. Model
//! discovery/downloading lives in [`crate::model`].

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use super::acceleration::whisper_context_acceleration;

/// Minimum audio length accepted by whisper.cpp; shorter input is padded
/// with trailing silence (Meetily logged a warning and let it fail instead).
const MIN_SAMPLES: usize = 16000 + 1600; // 1.1 s at 16 kHz

/// The pair of confidence floors an utterance must clear to be emitted
/// (#92/#93). Both on the real per-token-probability scale (`0.0..=1.0`, see
/// [`WhisperEngine::transcribe`]).
///
/// whisper.cpp hallucinates plausible-looking captions on silence / ambient
/// noise (the VAD lets a faint segment through and the decoder fills it with a
/// phantom sentence). These floors drop those low-confidence utterances before
/// they pollute the feed, summary, and coaching list. Real speech averages
/// ~0.85+; silence/noise hallucinations score lower.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ConfidenceFloors {
    /// Floor for a FORCED source language (#92). 0.5 keeps confident speech
    /// (including short real phrases) and drops weak phantoms.
    forced: f32,
    /// Stricter floor required to TRUST an AUTO-detected language (#93).
    ///
    /// In Auto mode whisper picks the language per utterance and is unreliable
    /// on noise / short audio — it has emitted CJK for English-only audio. An
    /// auto-detected utterance whose confidence sits in `[forced, auto_detect)`
    /// is dropped rather than emitted with a possibly-wrong language label
    /// (which would mis-route the channel and translate the wrong direction).
    /// Always `>= forced`.
    auto_detect: f32,
}

/// Historical seed floors (#92/#93): every model family starts here.
///
/// EMPIRICALLY TUNED against `tiny` — but production defaults to `small` and
/// token-probability distributions differ per model family, so [`ModelFamily`]
/// exists to let the calibration ticket (#111) set real per-family values
/// against live captures. Until then all families share this seed, so behavior
/// is unchanged from the previous two hardcoded consts.
const SEED_FLOORS: ConfidenceFloors = ConfidenceFloors {
    forced: 0.5,
    auto_detect: 0.6,
};

/// Whisper model families the confidence floors are calibrated against (#109).
/// Quantized variants (e.g. `small-q5_1`) share their family's floors, and the
/// `large-v3-turbo` distillation shares the `large-v3` floors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelFamily {
    Tiny,
    Base,
    Small,
    Medium,
    LargeV3,
}

/// Map a model name (from [`crate::model::MODEL_NAMES`], possibly quantized) to
/// its [`ModelFamily`]. The quantization suffix (`-q5_1`, `-q5_0`, …) is not a
/// family, so it is stripped first. Unknown/future names fall back to the
/// `small` family — the production default (all families are seeded
/// identically today, so the fallback is behavior-preserving).
fn model_family(model_name: &str) -> ModelFamily {
    // Everything before the first "-q" is the size/architecture; the rest is
    // the quantization tag (none of the family stems contain "-q").
    let stem = model_name.split("-q").next().unwrap_or(model_name);
    match stem {
        "tiny" => ModelFamily::Tiny,
        "base" => ModelFamily::Base,
        "small" => ModelFamily::Small,
        "medium" => ModelFamily::Medium,
        // large-v3 and its turbo distillation share the large-v3 floors.
        _ if stem.starts_with("large-v3") => ModelFamily::LargeV3,
        _ => ModelFamily::Small,
    }
}

/// The per-family confidence-floor table (#109). Seeded uniformly with
/// [`SEED_FLOORS`]; the calibration ticket (#111) replaces these arms
/// per-family with real-audio evidence. Every arm keeps `auto_detect >= forced`.
fn family_floors(family: ModelFamily) -> ConfidenceFloors {
    match family {
        ModelFamily::Tiny => SEED_FLOORS,
        ModelFamily::Base => SEED_FLOORS,
        ModelFamily::Small => SEED_FLOORS,
        ModelFamily::Medium => SEED_FLOORS,
        ModelFamily::LargeV3 => SEED_FLOORS,
    }
}

/// Env var overriding the FORCED-language confidence floor (#109) — a
/// recompile-free live-tuning knob for the calibration loop. Parsed as `f32`
/// and clamped to `0.0..=1.0`; unset / empty / invalid falls back to the table.
const CONFIDENCE_FLOOR_ENV: &str = "LIVECAP_CONFIDENCE_FLOOR";

/// Env var overriding the AUTO-detect confidence floor (#109). Same parsing and
/// clamping rules as [`CONFIDENCE_FLOOR_ENV`].
const AUTO_DETECT_CONFIDENCE_FLOOR_ENV: &str = "LIVECAP_AUTO_DETECT_CONFIDENCE_FLOOR";

/// Read an `f32` floor override from environment variable `var`, clamped to
/// `0.0..=1.0`. Returns `None` when the var is unset, empty, unparseable, or
/// non-finite — the caller then uses the per-family table value. Not caption
/// content, so this is a tuning knob in all builds, not a security surface.
fn env_floor_override(var: &str) -> Option<f32> {
    parse_floor_override(&std::env::var(var).ok()?)
}

/// Parse and clamp a raw floor-override string to `0.0..=1.0`. Returns `None`
/// for empty, unparseable, or non-finite (`inf`/`nan`) input so the caller
/// falls back to the table value. Pure (no environment access).
fn parse_floor_override(raw: &str) -> Option<f32> {
    let value: f32 = raw.trim().parse().ok()?;
    value.is_finite().then(|| value.clamp(0.0, 1.0))
}

/// A transcribed utterance.
#[derive(Debug, Clone)]
pub struct Utterance {
    pub text: String,
    /// ISO-639-1 code detected by whisper, or "unknown".
    pub lang: String,
    /// Heuristic confidence in `0.0..=1.0`.
    pub confidence: f32,
}

/// A loaded whisper.cpp model. Cheap to share behind an `Arc`.
///
/// The `WhisperState` (KV caches, a ~93 MB logits buffer, the CoreML/Metal
/// encoder binding) is created ONCE at load and reused across every call (#140)
/// rather than re-allocated per transcription — a fresh state per call also
/// re-initialised the Metal backend and re-attempted the CoreML load, ~180–450 MB
/// of alloc/free plus tens–hundreds of ms of setup on EVERY partial. The
/// transcribe worker serializes calls (`pipeline::transcribe_worker`), so the
/// `Mutex` only provides interior mutability for `&self` + never actually
/// contends.
///
/// The `WhisperContext` wrapper is dropped once the state exists: the state
/// holds its own `Arc<WhisperInnerContext>` (from `create_state`), so the loaded
/// model stays alive for the engine's lifetime and is freed after the state.
pub struct WhisperEngine {
    state: Mutex<WhisperState>,
    model_name: String,
}

impl WhisperEngine {
    /// Load a ggml/gguf model from `model_path`. Blocking and slow (seconds)
    /// — call from a blocking context.
    pub fn load(model_path: &Path, model_name: &str) -> Result<Self> {
        // Route whisper.cpp / ggml C-library logs into the Rust `log` crate
        // (#141). The old `GGML_METAL_LOG_LEVEL`/`WHISPER_LOG_LEVEL` env vars were
        // placebos — neither is read by the vendored whisper.cpp — so real errors
        // (and, crucially, the backend-init line that reports whether Metal
        // ACTUALLY engaged vs a silent CPU fallback) were lost to stderr. The
        // trampoline is process-global and idempotent; installing it before
        // context creation means whisper.cpp's own "using Metal backend" init log
        // is the runtime truth, not the compile-time `cfg!` guess below.
        whisper_rs::install_whisper_log_trampoline();

        // `status_label()` is the COMPILE-TIME backend guess. The routed
        // whisper.cpp init logs above report what actually loaded.
        let acceleration = whisper_context_acceleration();
        log::info!(
            "Loading whisper model '{}' from {} — compiled for {} (see whisper.cpp init logs for the runtime backend)",
            model_name,
            model_path.display(),
            acceleration.status_label()
        );

        let context_param = WhisperContextParameters {
            use_gpu: acceleration.use_gpu,
            gpu_device: acceleration.gpu_device,
            flash_attn: acceleration.flash_attn,
            ..Default::default()
        };

        let ctx = WhisperContext::new_with_params(
            &model_path.to_string_lossy(),
            context_param,
        )
        .map_err(|e| anyhow!("Failed to load model {}: {}", model_name, e))?;

        // Create the reusable state once (#140). `whisper_full` overwrites its
        // results each call, so a single long-lived state serves every
        // transcription; only the KV/logits buffers and encoder binding are
        // amortised.
        let state = ctx
            .create_state()
            .map_err(|e| anyhow!("Failed to create whisper state for {}: {}", model_name, e))?;

        log::info!("Whisper model '{}' loaded", model_name);
        Ok(Self {
            state: Mutex::new(state),
            model_name: model_name.to_string(),
        })
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }

    /// Transcribe a 16 kHz mono segment. `language`: `None`/`"auto"` for
    /// per-utterance auto-detection, `"auto-translate"` to translate to
    /// English, or an ISO-639-1 code to force a language. `partial` marks a
    /// throwaway preview transcription (superseded by the eventual final):
    /// partials decode greedily and over a reduced audio context to cut cost,
    /// finals keep beam search for best accuracy (#140). `session_auto` is true
    /// when the session did not force a language (auto-detect mode) — the
    /// confidence floor uses it, NOT the per-call `language`, so a partial whose
    /// language was pinned from auto-detection still gets the stricter auto-mode
    /// floor (#92/#93) rather than the laxer forced-language one.
    ///
    /// CPU/GPU-heavy and blocking — call via `spawn_blocking` from async code.
    pub fn transcribe(
        &self,
        audio_16k: &[f32],
        language: Option<&str>,
        partial: bool,
        session_auto: bool,
    ) -> Result<Utterance> {
        // Beam search beats greedy on accuracy and is used for FINALS (the
        // archived/translated text). PARTIALS are superseded within ~1.2 s, so
        // they decode greedily — roughly half the decode cost for a preview the
        // final will replace (#140).
        let mut params = if partial {
            FullParams::new(SamplingStrategy::Greedy { best_of: 1 })
        } else {
            FullParams::new(SamplingStrategy::BeamSearch {
                beam_size: 2,
                patience: 1.0,
            })
        };

        let (language_code, should_translate) = match language {
            Some("auto") | None => (None, false),
            Some("auto-translate") => (None, true),
            Some(lang) => (Some(lang), false),
        };
        params.set_language(language_code);
        params.set_translate(should_translate);

        // From Meetily: disable timestamp tokens to keep whisper.cpp's
        // "single timestamp ending" chunking heuristic from discarding
        // complete, valid transcriptions. Utterance timestamps come from VAD.
        params.set_no_timestamps(true);
        params.set_token_timestamps(true);

        // Disable all whisper.cpp internal printing.
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        params.set_suppress_blank(true);
        params.set_suppress_non_speech_tokens(true);
        params.set_temperature(0.0);
        params.set_max_initial_ts(1.0);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        // From Meetily: 0.55 balances hallucination suppression against
        // quiet-speech detection (0.75 rejected valid quiet speech).
        params.set_no_speech_thold(0.55);
        params.set_max_len(200);
        params.set_single_segment(false);

        // whisper.cpp rejects very short inputs — pad with trailing silence.
        let padded;
        let audio: &[f32] = if audio_16k.len() < MIN_SAMPLES {
            padded = {
                let mut v = audio_16k.to_vec();
                v.resize(MIN_SAMPLES, 0.0);
                v
            };
            &padded
        } else {
            audio_16k
        };

        // NOTE: a per-partial `set_audio_ctx` reduction was intentionally NOT
        // added (#140). With flash attention (enabled on every macOS build) and
        // a REUSED state, shrinking `audio_ctx` is unsafe: whisper.cpp zeroes the
        // cross-attention KV cache (`kv_cross`) only at state init, never between
        // `full()` calls, and the flash-attn cross graph writes only `n_ctx`
        // columns. So a reduced-window partial after a full-window call would
        // cross-attend to the PREVIOUS utterance's stale encoder features —
        // corrupt partial text, distorted token probs (feeding the #92 gate),
        // and a wrong detected language. Keeping every call at the full
        // 1500-frame layout makes state reuse exactly equivalent to a fresh
        // state. Greedy decoding for partials (above) is the safe half of the
        // partial speed-up.

        // Reuse the long-lived state (#140). The transcribe worker is
        // single-threaded so this lock never contends; `.full` overwrites the
        // state's previous results. Recover a poisoned lock rather than erroring
        // forever: `whisper_full` self-resets, and the context was dropped so a
        // fresh state cannot be created — bricking transcription on one panic
        // would be worse than reusing the (still-valid) state.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.full(params, audio)?;

        // Detected language for this utterance.
        let lang = match state.full_lang_id_from_state() {
            Ok(id) => whisper_rs::get_lang_str(id).unwrap_or("unknown").to_string(),
            Err(_) => "unknown".to_string(),
        };

        let num_segments = state.full_n_segments()?;
        let mut result = String::new();
        let mut total_confidence = 0.0f32;
        let mut segment_count = 0u32;

        for i in 0..num_segments {
            let segment_text = match state.full_get_segment_text_lossy(i) {
                Ok(text) => text,
                Err(_) => continue,
            };

            // Real per-token confidence (#92): average whisper's token
            // probabilities for this segment. Hallucinations on silence/noise
            // score low here; real speech is high (~0.85+). This replaces the
            // old text-length heuristic, which only measured length and so
            // dropped legitimate SHORT phrases while passing long phantoms.
            let n_tokens = state.full_n_tokens(i).unwrap_or(0);
            let mut seg_prob_sum = 0.0f32;
            let mut tok_count = 0u32;
            for t in 0..n_tokens {
                if let Ok(p) = state.full_get_token_prob(i, t) {
                    seg_prob_sum += p;
                    tok_count += 1;
                }
            }
            let segment_confidence = if tok_count > 0 {
                seg_prob_sum / tok_count as f32
            } else {
                0.0
            };
            total_confidence += segment_confidence;
            segment_count += 1;

            let cleaned_text = segment_text.trim();
            if !cleaned_text.is_empty() {
                if !result.is_empty() {
                    result.push(' ');
                }
                result.push_str(cleaned_text);
            }
        }

        let final_result = result.trim().to_string();
        let cleaned_result = clean_repetitive_text(&final_result);

        let avg_confidence = if segment_count > 0 {
            (total_confidence / segment_count as f32).min(1.0)
        } else {
            0.0
        };

        // Confidence-floor gate (#92): drop low-confidence utterances — these
        // are whisper hallucinations on silence / ambient noise. Empty text is
        // the pipeline's "nothing to emit" signal (it `continue`s past it), so
        // this is additive to VAD, not a replacement. No caption content in
        // logs (SECURITY.md / EPIC #1) — length + score only.
        //
        // Use `session_auto`, NOT the per-call `language`: a partial whose
        // language was pinned from auto-detection (#140, M1) still ran in an
        // auto session and must get the stricter auto-mode floor, even though it
        // now passes a concrete language code to skip re-detection.
        let auto_detect = session_auto;
        if is_low_confidence_drop(&self.model_name, &cleaned_result, avg_confidence, auto_detect) {
            log::debug!(
                "Dropping low-confidence utterance ({} chars, conf {:.2} < {:.2}, auto={})",
                cleaned_result.chars().count(),
                avg_confidence,
                confidence_floor(&self.model_name, auto_detect),
                auto_detect
            );
            return Ok(Utterance {
                text: String::new(),
                lang,
                confidence: avg_confidence,
            });
        }

        Ok(Utterance {
            text: cleaned_result,
            lang,
            confidence: avg_confidence,
        })
    }
}

/// The effective confidence floors for `model_name` (#92/#93/#109): the
/// per-family table values, each overridable by its env knob
/// (`LIVECAP_[AUTO_DETECT_]CONFIDENCE_FLOOR`, clamped `0.0..=1.0`), with the #93
/// invariant `auto_detect >= forced` re-established AFTER overrides.
///
/// The two env knobs are independent, so an operator can raise the FORCED floor
/// above the (table or env) auto floor. That would make auto-detected language
/// LESS strict than a forced one — the opposite of #93's intent — so the
/// resolved auto floor is lifted to at least the resolved forced floor rather
/// than trusted as-is.
fn resolved_floors(model_name: &str) -> ConfidenceFloors {
    let table = family_floors(model_family(model_name));
    let forced = env_floor_override(CONFIDENCE_FLOOR_ENV).unwrap_or(table.forced);
    let auto_detect = env_floor_override(AUTO_DETECT_CONFIDENCE_FLOOR_ENV).unwrap_or(table.auto_detect);
    ConfidenceFloors {
        forced,
        auto_detect: auto_detect.max(forced),
    }
}

/// The confidence floor an utterance must clear to be emitted (#92/#93/#109).
/// Auto-detected language gets the stricter auto-detect floor; a forced source
/// language gets the plain floor. See [`resolved_floors`] for env resolution
/// and the `auto_detect >= forced` guarantee.
fn confidence_floor(model_name: &str, auto_detect: bool) -> f32 {
    let floors = resolved_floors(model_name);
    if auto_detect {
        floors.auto_detect
    } else {
        floors.forced
    }
}

/// Whether an utterance should be dropped as a low-confidence hallucination
/// (#92). Empty text is never "dropped" here (it carried nothing to begin
/// with); non-empty text below the floor is.
fn is_low_confidence_drop(
    model_name: &str,
    text: &str,
    avg_confidence: f32,
    auto_detect: bool,
) -> bool {
    !text.is_empty() && avg_confidence < confidence_floor(model_name, auto_detect)
}

// ---------------------------------------------------------------------------
// Output cleaning (ported from Meetily's WhisperEngine helpers)
// ---------------------------------------------------------------------------

/// Clean repetitive text patterns and meaningless outputs.
fn clean_repetitive_text(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    if is_meaningless_output(text) {
        // No caption content in logs (SECURITY.md / EPIC #1) — length only.
        log::debug!("Detected meaningless output ({} chars), returning empty", text.chars().count());
        return String::new();
    }

    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 3 {
        return text.to_string();
    }

    let cleaned_words = remove_word_repetitions(&words);
    let cleaned_words = remove_phrase_repetitions(&cleaned_words);

    let final_text = cleaned_words.join(" ");
    if calculate_repetition_ratio(&final_text) > 0.7 {
        log::debug!("High repetition ratio, filtering out ({} chars)", final_text.chars().count());
        return String::new();
    }

    final_text
}

/// Check for obviously meaningless patterns (whisper hallucinations on
/// silence/music).
fn is_meaningless_output(text: &str) -> bool {
    let text_lower = text.to_lowercase();

    let meaningless_patterns = [
        "thank you for watching",
        "thanks for watching",
        "like and subscribe",
        "music playing",
        "applause",
        "laughter",
        "um um um",
        "uh uh uh",
        "ah ah ah",
    ];

    for pattern in &meaningless_patterns {
        if text_lower.contains(pattern) {
            return true;
        }
    }

    // Mostly the same character repeated.
    let unique_chars: HashSet<char> = text.chars().collect();
    if unique_chars.len() <= 3 && text.len() > 10 {
        return true;
    }

    false
}

/// Collapse consecutive repetitions of the same word.
fn remove_word_repetitions<'a>(words: &[&'a str]) -> Vec<&'a str> {
    let mut cleaned_words = Vec::new();
    let mut i = 0;

    while i < words.len() {
        let current_word = words[i];
        let mut repeat_count = 1;

        while i + repeat_count < words.len() && words[i + repeat_count] == current_word {
            repeat_count += 1;
        }

        cleaned_words.push(current_word);
        i += repeat_count.max(1);
    }

    cleaned_words
}

/// Collapse repeated 2–5 word phrases.
fn remove_phrase_repetitions<'a>(words: &[&'a str]) -> Vec<&'a str> {
    if words.len() < 4 {
        return words.to_vec();
    }

    let mut final_words = Vec::new();
    let mut i = 0;

    while i < words.len() {
        let mut phrase_found = false;

        for phrase_len in 2..=std::cmp::min(5, (words.len() - i) / 2) {
            if i + phrase_len * 2 <= words.len() {
                let phrase1 = &words[i..i + phrase_len];
                let phrase2 = &words[i + phrase_len..i + phrase_len * 2];

                if phrase1 == phrase2 {
                    final_words.extend_from_slice(phrase1);
                    i += phrase_len * 2;
                    phrase_found = true;
                    break;
                }
            }
        }

        if !phrase_found {
            final_words.push(words[i]);
            i += 1;
        }
    }

    final_words
}

/// Share of repeated words in the text.
fn calculate_repetition_ratio(text: &str) -> f32 {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 4 {
        return 0.0;
    }

    let mut word_counts = HashMap::new();
    for word in &words {
        *word_counts.entry(word.to_lowercase()).or_insert(0u32) += 1;
    }

    let total_words = words.len() as f32;
    let repeated_words: u32 = word_counts
        .values()
        .map(|&count| count.saturating_sub(1))
        .sum();

    repeated_words as f32 / total_words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_repeated_words() {
        let cleaned = clean_repetitive_text("hello hello hello world today");
        assert_eq!(cleaned, "hello world today");
    }

    #[test]
    fn collapses_repeated_phrases() {
        let cleaned = clean_repetitive_text("we are live we are live and recording now");
        assert_eq!(cleaned, "we are live and recording now");
    }

    #[test]
    fn filters_hallucination_patterns() {
        assert_eq!(clean_repetitive_text("Thanks for watching everyone"), "");
        assert_eq!(clean_repetitive_text("aaaaaaaaaaaaaa"), "");
    }

    #[test]
    fn keeps_normal_sentences() {
        let s = "The quick brown fox jumps over the lazy dog";
        assert_eq!(clean_repetitive_text(s), s);
    }

    // ---- confidence-floor gate (#92/#93/#109) ----

    // Reference model for the floor tests: the production default (#109). All
    // families are seeded identically, so any name yields the seed floors.
    const TEST_MODEL: &str = "small";

    // The floor env vars are process-global, so serialize every test that reads
    // or writes them; parallel execution must never observe a half-set override.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    #[test]
    fn confidence_floor_is_stricter_in_auto_mode() {
        let _guard = env_lock();
        // #93: auto-detected language demands a higher margin than a forced one.
        assert_eq!(confidence_floor(TEST_MODEL, false), SEED_FLOORS.forced);
        assert_eq!(confidence_floor(TEST_MODEL, true), SEED_FLOORS.auto_detect);
        const { assert!(SEED_FLOORS.auto_detect >= SEED_FLOORS.forced) };
    }

    #[test]
    fn low_confidence_utterance_is_dropped() {
        let _guard = env_lock();
        // #92: below the floor → drop (whisper hallucination on silence).
        // Expressed relative to the table so it tracks live tuning.
        let below_plain = SEED_FLOORS.forced - 0.05;
        assert!(is_low_confidence_drop(
            TEST_MODEL,
            "scarf off the popcorn",
            below_plain,
            false
        ));
        let below_auto = SEED_FLOORS.auto_detect - 0.05;
        assert!(is_low_confidence_drop(
            TEST_MODEL,
            "這一點是我的建議",
            below_auto,
            true
        ));
    }

    #[test]
    fn confident_utterance_is_kept() {
        let _guard = env_lock();
        // Real speech that clears the floor is emitted (the floor is inclusive).
        assert!(!is_low_confidence_drop(
            TEST_MODEL,
            "a clear confident sentence",
            0.95,
            false
        ));
        assert!(!is_low_confidence_drop(
            TEST_MODEL,
            "a clear confident sentence",
            SEED_FLOORS.forced,
            false
        ));
        assert!(!is_low_confidence_drop(
            TEST_MODEL,
            "a clear confident sentence",
            SEED_FLOORS.auto_detect,
            true
        ));
    }

    #[test]
    fn borderline_auto_detection_is_dropped_but_forced_is_kept() {
        let _guard = env_lock();
        // #93: confidence between the two floors — trusted when the source
        // language was forced, dropped when it was auto-detected. (When the two
        // floors are equal this still holds: the forced case sits AT its floor,
        // which is kept; the auto case below its floor is dropped.)
        let between = (SEED_FLOORS.forced + SEED_FLOORS.auto_detect) / 2.0;
        assert!(!is_low_confidence_drop(
            TEST_MODEL,
            "forced language text",
            between,
            false
        ));
        if SEED_FLOORS.auto_detect > SEED_FLOORS.forced {
            assert!(is_low_confidence_drop(
                TEST_MODEL,
                "auto language text",
                between,
                true
            ));
        }
    }

    #[test]
    fn empty_text_is_never_a_low_confidence_drop() {
        // Empty text carried nothing — the gate is only for non-empty phantoms.
        assert!(!is_low_confidence_drop(TEST_MODEL, "", 0.0, false));
        assert!(!is_low_confidence_drop(TEST_MODEL, "", 0.0, true));
    }

    // ---- per-model-family floor table (#109) ----

    #[test]
    fn model_family_maps_names_and_quantized_variants() {
        // Base families.
        assert_eq!(model_family("tiny"), ModelFamily::Tiny);
        assert_eq!(model_family("base"), ModelFamily::Base);
        assert_eq!(model_family("small"), ModelFamily::Small);
        assert_eq!(model_family("medium"), ModelFamily::Medium);
        assert_eq!(model_family("large-v3"), ModelFamily::LargeV3);
        // Quantized variants (from crate::model::MODEL_NAMES) map to their
        // family, not to a distinct floor.
        assert_eq!(model_family("tiny-q5_1"), ModelFamily::Tiny);
        assert_eq!(model_family("base-q5_1"), ModelFamily::Base);
        assert_eq!(model_family("small-q5_1"), ModelFamily::Small);
        assert_eq!(model_family("medium-q5_0"), ModelFamily::Medium);
        assert_eq!(model_family("large-v3-q5_0"), ModelFamily::LargeV3);
        // The large-v3 turbo distillation (and its quant) share large-v3.
        assert_eq!(model_family("large-v3-turbo"), ModelFamily::LargeV3);
        assert_eq!(model_family("large-v3-turbo-q5_0"), ModelFamily::LargeV3);
        // Every shipped model name resolves without panicking.
        for name in crate::model::MODEL_NAMES {
            let _ = model_family(name);
        }
        // Unknown/future names fall back to the production-default family.
        assert_eq!(model_family("nonexistent-9000"), ModelFamily::Small);
    }

    #[test]
    fn every_family_seeded_with_historical_floors() {
        // #109 acceptance: no behavior change with no env set — all families
        // still carry the historical (0.5, 0.6) floors, and each upholds the
        // auto >= forced invariant.
        for family in [
            ModelFamily::Tiny,
            ModelFamily::Base,
            ModelFamily::Small,
            ModelFamily::Medium,
            ModelFamily::LargeV3,
        ] {
            let floors = family_floors(family);
            assert_eq!(floors.forced, 0.5);
            assert_eq!(floors.auto_detect, 0.6);
            assert!(floors.auto_detect >= floors.forced);
        }
    }

    // ---- env override (#109) ----

    #[test]
    fn parse_floor_override_clamps_and_rejects_invalid() {
        // In-range values pass through.
        assert_eq!(parse_floor_override("0.42"), Some(0.42));
        assert_eq!(parse_floor_override("  0.75  "), Some(0.75)); // trimmed
        assert_eq!(parse_floor_override("0"), Some(0.0));
        assert_eq!(parse_floor_override("1"), Some(1.0));
        // Out-of-range clamps into 0.0..=1.0.
        assert_eq!(parse_floor_override("1.5"), Some(1.0));
        assert_eq!(parse_floor_override("-0.3"), Some(0.0));
        // Invalid / non-finite → None (caller uses the table value).
        assert_eq!(parse_floor_override(""), None);
        assert_eq!(parse_floor_override("high"), None);
        assert_eq!(parse_floor_override("0.5x"), None);
        assert_eq!(parse_floor_override("inf"), None);
        assert_eq!(parse_floor_override("NaN"), None);
    }

    #[test]
    fn env_var_names_are_the_documented_knobs() {
        assert_eq!(CONFIDENCE_FLOOR_ENV, "LIVECAP_CONFIDENCE_FLOOR");
        assert_eq!(
            AUTO_DETECT_CONFIDENCE_FLOOR_ENV,
            "LIVECAP_AUTO_DETECT_CONFIDENCE_FLOOR"
        );
    }

    #[test]
    fn env_override_replaces_table_value_and_is_clamped() {
        let _guard = env_lock();
        // Snapshot then clear, so this test starts from a known-unset state
        // regardless of the ambient environment.
        let prev_forced = std::env::var(CONFIDENCE_FLOOR_ENV).ok();
        let prev_auto = std::env::var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV).ok();

        // Valid override wins over the table value.
        std::env::set_var(CONFIDENCE_FLOOR_ENV, "0.8");
        std::env::set_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV, "0.9");
        assert_eq!(confidence_floor(TEST_MODEL, false), 0.8);
        assert_eq!(confidence_floor(TEST_MODEL, true), 0.9);

        // Out-of-range override is clamped, not discarded.
        std::env::set_var(CONFIDENCE_FLOOR_ENV, "2.0");
        assert_eq!(confidence_floor(TEST_MODEL, false), 1.0);

        // Invalid override falls back to the per-family table value.
        std::env::set_var(CONFIDENCE_FLOOR_ENV, "not-a-number");
        assert_eq!(confidence_floor(TEST_MODEL, false), SEED_FLOORS.forced);

        // Unset → table value.
        std::env::remove_var(CONFIDENCE_FLOOR_ENV);
        std::env::remove_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV);
        assert_eq!(confidence_floor(TEST_MODEL, false), SEED_FLOORS.forced);
        assert_eq!(confidence_floor(TEST_MODEL, true), SEED_FLOORS.auto_detect);

        // Restore the ambient environment for any other consumer.
        match prev_forced {
            Some(v) => std::env::set_var(CONFIDENCE_FLOOR_ENV, v),
            None => std::env::remove_var(CONFIDENCE_FLOOR_ENV),
        }
        match prev_auto {
            Some(v) => std::env::set_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV, v),
            None => std::env::remove_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV),
        }
    }

    #[test]
    fn env_override_preserves_auto_ge_forced_invariant() {
        let _guard = env_lock();
        // The two env knobs are independent (#109/#93): a forced override above
        // the auto floor must NOT make auto-detect less strict than forced. The
        // resolved auto floor is lifted to at least the resolved forced floor.
        let prev_forced = std::env::var(CONFIDENCE_FLOOR_ENV).ok();
        let prev_auto = std::env::var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV).ok();

        // Forced override above the (unset → table 0.6) auto floor: auto is
        // lifted to the forced value, and the forced floor itself is unchanged.
        std::env::set_var(CONFIDENCE_FLOOR_ENV, "0.9");
        std::env::remove_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV);
        assert_eq!(confidence_floor(TEST_MODEL, false), 0.9);
        assert_eq!(confidence_floor(TEST_MODEL, true), 0.9);
        assert!(confidence_floor(TEST_MODEL, true) >= confidence_floor(TEST_MODEL, false));

        // Forced override above an explicit LOWER auto override: auto is still
        // lifted to the forced value (the override can't invert the invariant).
        std::env::set_var(CONFIDENCE_FLOOR_ENV, "0.8");
        std::env::set_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV, "0.3");
        assert_eq!(confidence_floor(TEST_MODEL, false), 0.8);
        assert_eq!(confidence_floor(TEST_MODEL, true), 0.8);

        // A higher auto override is honored as-is (invariant already holds).
        std::env::set_var(CONFIDENCE_FLOOR_ENV, "0.4");
        std::env::set_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV, "0.7");
        assert_eq!(confidence_floor(TEST_MODEL, false), 0.4);
        assert_eq!(confidence_floor(TEST_MODEL, true), 0.7);

        // Resolved floors always satisfy the invariant.
        let floors = resolved_floors(TEST_MODEL);
        assert!(floors.auto_detect >= floors.forced);

        match prev_forced {
            Some(v) => std::env::set_var(CONFIDENCE_FLOOR_ENV, v),
            None => std::env::remove_var(CONFIDENCE_FLOOR_ENV),
        }
        match prev_auto {
            Some(v) => std::env::set_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV, v),
            None => std::env::remove_var(AUTO_DETECT_CONFIDENCE_FLOOR_ENV),
        }
    }
}
