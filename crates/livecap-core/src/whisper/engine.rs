//! The whisper transcription engine.
//!
//! Ported from Meetily `src/whisper_engine/whisper_engine.rs` (MIT) and
//! reduced to what LiveCap needs: load one model, transcribe 16 kHz mono
//! segments, detect the language, and clean repetitive output. Model
//! discovery/downloading lives in [`crate::model`].

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{anyhow, Result};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::acceleration::whisper_context_acceleration;

/// Minimum audio length accepted by whisper.cpp; shorter input is padded
/// with trailing silence (Meetily logged a warning and let it fail instead).
const MIN_SAMPLES: usize = 16000 + 1600; // 1.1 s at 16 kHz

/// A transcribed utterance.
#[derive(Debug, Clone)]
pub struct Utterance {
    pub text: String,
    /// ISO-639-1 code detected by whisper, or "unknown".
    pub lang: String,
    /// Heuristic confidence in `0.0..=1.0`.
    pub confidence: f32,
}

/// A loaded whisper.cpp model. Cheap to share behind an `Arc`; create one
/// `WhisperState` per transcription call (states are independent).
pub struct WhisperEngine {
    ctx: WhisperContext,
    model_name: String,
}

impl WhisperEngine {
    /// Load a ggml/gguf model from `model_path`. Blocking and slow (seconds)
    /// — call from a blocking context.
    pub fn load(model_path: &Path, model_name: &str) -> Result<Self> {
        // Suppress verbose whisper.cpp / Metal C-library logs that bypass
        // Rust logging.
        std::env::set_var("GGML_METAL_LOG_LEVEL", "1"); // 0=off, 1=error
        std::env::set_var("WHISPER_LOG_LEVEL", "1");

        let acceleration = whisper_context_acceleration();
        log::info!(
            "Loading whisper model '{}' from {} with {}",
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

        log::info!("Whisper model '{}' loaded", model_name);
        Ok(Self {
            ctx,
            model_name: model_name.to_string(),
        })
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }

    /// Transcribe a 16 kHz mono segment. `language`: `None`/`"auto"` for
    /// per-utterance auto-detection, `"auto-translate"` to translate to
    /// English, or an ISO-639-1 code to force a language.
    ///
    /// CPU/GPU-heavy and blocking — call via `spawn_blocking` from async code.
    pub fn transcribe(&self, audio_16k: &[f32], language: Option<&str>) -> Result<Utterance> {
        // Beam search with a small beam keeps latency low while beating
        // greedy decoding on accuracy (Meetily sized the beam per hardware
        // tier; live captioning favors the low end).
        let mut params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 2,
            patience: 1.0,
        });

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

        let mut state = self.ctx.create_state()?;
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

            // Heuristic confidence based on segment text length (from
            // Meetily; whisper-rs does not expose token probabilities here).
            let segment_length = segment_text.len() as f32;
            let segment_confidence = if segment_length > 0.0 {
                (segment_length / 100.0).min(0.9) + 0.1
            } else {
                0.1
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

        Ok(Utterance {
            text: cleaned_result,
            lang,
            confidence: avg_confidence,
        })
    }
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
}
