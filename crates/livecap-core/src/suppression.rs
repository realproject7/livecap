//! Cross-channel speaker-bleed suppression (issue #56).
//!
//! In speaker mode (no headphones) the microphone re-hears the system audio, so
//! the mic channel produces a flood of duplicate — often garbled — captions: in
//! the #13 66-min E2E, Me=318 vs Them=60, doubling translation spend and
//! polluting the archive. Meetily's mixer ducked/echo-cancelled this, but we
//! dropped the mixer to keep mic and system as SEPARATE channels (#4). This
//! restores suppression WITHOUT remixing, using the fact that both streams are
//! already in one process, via two complementary, channel-separation-preserving
//! signals:
//!
//! 1. **Energy gate** — the system channel publishes a short-term energy
//!    envelope. A mic segment whose own energy is *attenuated* relative to the
//!    concurrent system energy is the speaker bleeding into the mic (a foreground
//!    voice into the mic is at least as loud as the cross-room bleed), so it is
//!    gated before transcription. This catches the garbled bleed the text check
//!    can't (228 of the 318 mic captions in #13 were low-confidence).
//! 2. **Near-duplicate text drop** — recent system finalizations are kept in a
//!    short window; a mic finalization whose normalized text matches one is the
//!    speaker re-heard clearly, and is dropped before the event leaves the
//!    pipeline. This catches the clean bleed that is loud enough to pass the gate.
//!
//! Genuinely distinct mic speech is preserved: it is either louder than the
//! concurrent system audio (passes the gate) or arrives while the system is
//! quiet (no concurrent energy), and its text does not match a system final.
//!
//! Pure and clock-injected — every method takes an explicit `now_ms`, so the
//! decision logic unit-tests deterministically with no audio or real time.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Tunables for [`CrossChannelSuppressor`]. Defaults are chosen for the #13
/// speaker-at-volume-25 case and are conservative — they only suppress mic audio
/// that is *both* concurrent with and quieter than the system channel, or a
/// textual duplicate of it.
#[derive(Debug, Clone)]
pub struct SuppressionConfig {
    /// RMS above which the system channel counts as "active" (speaking).
    pub speech_floor_rms: f32,
    /// A mic segment is treated as bleed when its RMS is at or below this
    /// fraction of the concurrent system RMS (i.e. clearly the attenuated copy).
    pub atten_ratio: f32,
    /// Extra look-back (ms) added to a mic segment's own duration when scanning
    /// the system energy envelope, to tolerate the mic-vs-system capture offset.
    pub energy_window_ms: u64,
    /// How long (ms) system energy frames are retained for the gate.
    pub energy_retain_ms: u64,
    /// How long (ms) a system finalization stays comparable for the dedup check.
    pub dedup_window_ms: u64,
    /// Token-overlap (Jaccard) at or above which two normalized texts are
    /// considered the same utterance.
    pub dedup_similarity: f32,
    /// Token *coverage* at or above which a mic finalization is treated as bleed:
    /// the fraction of the mic line's tokens that also appear in a recent system
    /// final. Catches a mic line that is a FRAGMENT of (or a re-hearing of part
    /// of) a longer system line — where symmetric Jaccard stays low but nearly
    /// every mic token came from the system audio. Only applied to mic lines of
    /// at least [`Self::dedup_coverage_min_tokens`] tokens, so a one-word echo
    /// can't trip it on coincidental overlap.
    pub dedup_coverage: f32,
    /// Minimum mic-line token count for the coverage check to apply.
    pub dedup_coverage_min_tokens: usize,
}

impl Default for SuppressionConfig {
    /// Tuned against the #64 real two-channel speaker-bleed fixtures (208 s,
    /// captured via #70's dump). Energy analysis of those fixtures drove every
    /// change from the #56 synthetic baseline:
    /// - `speech_floor_rms` 0.012 → 0.008: real system RMS was ~0.029, so 0.012
    ///   was ~0.4× the system level and missed moderate system activity (the gate
    ///   needs the system "active" to fire); 0.008 (~0.27×) detects it.
    /// - `atten_ratio` 0.7 → 0.8: the concurrent mic/system ratio was p50 0.17
    ///   but p90 0.71 / p95 0.98 — louder bleed moments (reverb/AGC) slipped past
    ///   0.7; 0.8 catches through ~p93 while genuine mic speech (ratio > 1) passes.
    /// - `dedup_window_ms` 8s → 20s and `dedup_similarity` 0.6 → 0.5: ~13 s of the
    ///   clip was gap-bleed (mic re-hearing while the system was momentarily quiet
    ///   → the energy gate is blind, dedup must catch it), arriving seconds later
    ///   and transcribing with real acoustic divergence.
    /// - wider energy window/retain to match.
    ///
    /// All fields stay `LIVECAP_BLEED_*`-overridable (see [`from_env`]) for
    /// fixture-specific dial-in; final acceptance is operator E2E verified.
    fn default() -> Self {
        Self {
            // More aggressive than the prior #64 tune: the operator's v1.1 live
            // test still saw clean system lines escape onto the mic side
            // ("And Justin's talk", "어떻게 합격할까요?"). The bleed is loud and
            // clean enough to pass the energy gate, so the text check must do the
            // work: a wider dedup window, a lower similarity threshold, and a new
            // token-coverage rule for fragment re-hearings.
            speech_floor_rms: 0.008,
            atten_ratio: 0.85,
            energy_window_ms: 3_000,
            energy_retain_ms: 30_000,
            dedup_window_ms: 30_000,
            dedup_similarity: 0.4,
            dedup_coverage: 0.7,
            dedup_coverage_min_tokens: 3,
        }
    }
}

/// Parse an environment override `name` as `T`, ignoring an unset/blank/malformed
/// value (so a typo can never wedge suppression — it just keeps the default).
fn env_override<T: std::str::FromStr>(
    get: &impl Fn(&str) -> Option<String>,
    name: &str,
) -> Option<T> {
    get(name).and_then(|raw| raw.trim().parse::<T>().ok())
}

impl SuppressionConfig {
    /// The tuned defaults overlaid with any `LIVECAP_BLEED_*` env overrides (#64)
    /// — `SPEECH_FLOOR`, `ATTEN_RATIO`, `ENERGY_WINDOW_MS`, `ENERGY_RETAIN_MS`,
    /// `DEDUP_WINDOW_MS`, `DEDUP_SIMILARITY` — so an operator can tune against
    /// captured fixtures (see the gated WAV dump) without recompiling.
    pub fn from_env() -> Self {
        Self::default().with_overrides(|name| std::env::var(name).ok())
    }

    fn with_overrides(mut self, get: impl Fn(&str) -> Option<String>) -> Self {
        if let Some(v) = env_override::<f32>(&get, "LIVECAP_BLEED_SPEECH_FLOOR").filter(|v| v.is_finite()) {
            self.speech_floor_rms = v;
        }
        if let Some(v) = env_override::<f32>(&get, "LIVECAP_BLEED_ATTEN_RATIO").filter(|v| v.is_finite()) {
            self.atten_ratio = v;
        }
        if let Some(v) = env_override::<u64>(&get, "LIVECAP_BLEED_ENERGY_WINDOW_MS") {
            self.energy_window_ms = v;
        }
        if let Some(v) = env_override::<u64>(&get, "LIVECAP_BLEED_ENERGY_RETAIN_MS") {
            self.energy_retain_ms = v;
        }
        if let Some(v) = env_override::<u64>(&get, "LIVECAP_BLEED_DEDUP_WINDOW_MS") {
            self.dedup_window_ms = v;
        }
        if let Some(v) = env_override::<f32>(&get, "LIVECAP_BLEED_DEDUP_SIMILARITY").filter(|v| v.is_finite()) {
            self.dedup_similarity = v;
        }
        if let Some(v) = env_override::<f32>(&get, "LIVECAP_BLEED_DEDUP_COVERAGE").filter(|v| v.is_finite()) {
            self.dedup_coverage = v;
        }
        if let Some(v) = env_override::<usize>(&get, "LIVECAP_BLEED_DEDUP_COVERAGE_MIN_TOKENS") {
            self.dedup_coverage_min_tokens = v;
        }
        // Clamp the fractional overrides into their valid domains (#64 / RE2) so a
        // typo can't wedge suppression — e.g. a stray DEDUP_SIMILARITY > 1 (never
        // a match → no dedup) or < 0 (every match → drops all concurrent mic).
        self.speech_floor_rms = self.speech_floor_rms.clamp(0.0, 1.0);
        self.atten_ratio = self.atten_ratio.clamp(0.0, 4.0);
        self.dedup_similarity = self.dedup_similarity.clamp(0.0, 1.0);
        self.dedup_coverage = self.dedup_coverage.clamp(0.0, 1.0);
        self
    }
}

struct EnergyFrame {
    t_ms: u64,
    rms: f32,
}

struct SystemFinal {
    recorded_ms: u64,
    norm: String,
}

#[derive(Default)]
struct Inner {
    energy: VecDeque<EnergyFrame>,
    finals: VecDeque<SystemFinal>,
}

impl Inner {
    fn prune_energy(&mut self, now_ms: u64, retain_ms: u64) {
        let cutoff = now_ms.saturating_sub(retain_ms);
        while self.energy.front().is_some_and(|f| f.t_ms < cutoff) {
            self.energy.pop_front();
        }
    }

    fn prune_finals(&mut self, now_ms: u64, window_ms: u64) {
        let cutoff = now_ms.saturating_sub(window_ms);
        while self.finals.front().is_some_and(|f| f.recorded_ms < cutoff) {
            self.finals.pop_front();
        }
    }
}

/// Shared cross-channel suppression state. One instance is held by both channel
/// workers and the transcription worker (behind an `Arc`); all methods take
/// `&self` and lock internally.
pub struct CrossChannelSuppressor {
    cfg: SuppressionConfig,
    inner: Mutex<Inner>,
}

impl CrossChannelSuppressor {
    pub fn new(cfg: SuppressionConfig) -> Self {
        Self {
            cfg,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Record the system channel's energy for the chunk processed at `now_ms`.
    pub fn record_system_energy(&self, now_ms: u64, rms: f32) {
        let mut inner = self.inner.lock().expect("suppressor mutex poisoned");
        inner.energy.push_back(EnergyFrame { t_ms: now_ms, rms });
        inner.prune_energy(now_ms, self.cfg.energy_retain_ms);
    }

    /// Record a system finalization's text for the dedup window.
    pub fn record_system_final(&self, now_ms: u64, text: &str) {
        let norm = normalize_text(text);
        if norm.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().expect("suppressor mutex poisoned");
        inner.finals.push_back(SystemFinal { recorded_ms: now_ms, norm });
        inner.prune_finals(now_ms, self.cfg.dedup_window_ms);
    }

    /// Whether a mic segment ending around `now_ms`, of `duration_ms` and RMS
    /// `mic_rms`, is attenuated speaker bleed (energy gate). True only when the
    /// system channel was active across the overlapping window AND the mic copy
    /// is clearly quieter than it.
    pub fn mic_segment_is_energy_bleed(&self, now_ms: u64, duration_ms: u64, mic_rms: f32) -> bool {
        let inner = self.inner.lock().expect("suppressor mutex poisoned");
        let lo = now_ms.saturating_sub(duration_ms + self.cfg.energy_window_ms);

        let mut total = 0u32;
        let mut active = 0u32;
        let mut active_sum = 0.0f32;
        for frame in inner
            .energy
            .iter()
            .filter(|f| f.t_ms >= lo && f.t_ms <= now_ms)
        {
            total += 1;
            if frame.rms >= self.cfg.speech_floor_rms {
                active += 1;
                active_sum += frame.rms;
            }
        }

        // No concurrent system audio, or the system was active for under half the
        // window → not bleed (distinct mic speech with a quiet system passes).
        if total == 0 || (active as f32) < 0.5 * (total as f32) {
            return false;
        }
        let system_rms = active_sum / active as f32;
        mic_rms <= self.cfg.atten_ratio * system_rms
    }

    /// Whether `text`, a mic finalization at `now_ms`, near-duplicates a recent
    /// system finalization (text dedup).
    pub fn mic_text_is_duplicate(&self, now_ms: u64, text: &str) -> bool {
        let norm = normalize_text(text);
        if norm.is_empty() {
            return false;
        }
        let mut inner = self.inner.lock().expect("suppressor mutex poisoned");
        inner.prune_finals(now_ms, self.cfg.dedup_window_ms);
        let similarity = self.cfg.dedup_similarity;
        let coverage = self.cfg.dedup_coverage;
        // The mic line is long enough that a high token-coverage isn't coincidence.
        let mic_tokens = norm.split_whitespace().count();
        let coverage_eligible = mic_tokens >= self.cfg.dedup_coverage_min_tokens;
        inner.finals.iter().any(|f| {
            // 1) exact normalized match, 2) symmetric Jaccard (full re-hearing),
            // 3) one-directional coverage: nearly all the mic tokens came from a
            //    recent system line (a fragment / partial re-hearing of it).
            f.norm == norm
                || token_jaccard(&f.norm, &norm) >= similarity
                || (coverage_eligible && token_coverage(&norm, &f.norm) >= coverage)
        })
    }
}

/// RMS amplitude of a sample slice (0.0 for empty).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Lowercase, drop punctuation, and collapse whitespace so two transcriptions of
/// the same utterance compare equal. Alphanumeric runs (including CJK) are kept;
/// every other run becomes a single space.
fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_space = true; // collapse any leading separators
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Jaccard overlap of the whitespace-token sets of two normalized strings.
fn token_jaccard(a: &str, b: &str) -> f32 {
    use std::collections::HashSet;
    let sa: HashSet<&str> = a.split_whitespace().collect();
    let sb: HashSet<&str> = b.split_whitespace().collect();
    if sa.is_empty() && sb.is_empty() {
        return 1.0;
    }
    let union = sa.union(&sb).count();
    if union == 0 {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count();
    inter as f32 / union as f32
}

/// Fraction of `query`'s distinct tokens that also appear in `corpus` (directional
/// coverage). Unlike symmetric Jaccard this stays high when `query` is a short
/// FRAGMENT of a much longer `corpus` line — the speaker-bleed case where the mic
/// re-hears only part of a long system utterance. Returns 0.0 for an empty query.
fn token_coverage(query: &str, corpus: &str) -> f32 {
    use std::collections::HashSet;
    let sq: HashSet<&str> = query.split_whitespace().collect();
    if sq.is_empty() {
        return 0.0;
    }
    let sc: HashSet<&str> = corpus.split_whitespace().collect();
    let present = sq.iter().filter(|t| sc.contains(*t)).count();
    present as f32 / sq.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed config so the algorithm tests below are pinned to known thresholds,
    /// independent of the tunable production defaults (#64).
    fn suppressor() -> CrossChannelSuppressor {
        CrossChannelSuppressor::new(SuppressionConfig {
            speech_floor_rms: 0.012,
            atten_ratio: 0.7,
            energy_window_ms: 1_500,
            energy_retain_ms: 12_000,
            dedup_window_ms: 8_000,
            dedup_similarity: 0.6,
            dedup_coverage: 0.7,
            dedup_coverage_min_tokens: 3,
        })
    }

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn env_overrides_apply_over_defaults_and_ignore_malformed() {
        use std::collections::HashMap;
        let base = SuppressionConfig::default();
        let env: HashMap<&str, &str> = [
            ("LIVECAP_BLEED_ATTEN_RATIO", "0.9"),
            ("LIVECAP_BLEED_DEDUP_WINDOW_MS", "45000"),
            ("LIVECAP_BLEED_DEDUP_SIMILARITY", "0.35"),
            ("LIVECAP_BLEED_DEDUP_COVERAGE", "0.6"),
            ("LIVECAP_BLEED_DEDUP_COVERAGE_MIN_TOKENS", "4"),
            ("LIVECAP_BLEED_ENERGY_WINDOW_MS", "not-a-number"),
        ]
        .into_iter()
        .collect();
        let cfg = SuppressionConfig::default()
            .with_overrides(|name| env.get(name).map(|s| (*s).to_string()));

        assert!(approx(cfg.atten_ratio, 0.9));
        assert_eq!(cfg.dedup_window_ms, 45_000);
        assert!(approx(cfg.dedup_similarity, 0.35));
        assert!(approx(cfg.dedup_coverage, 0.6));
        assert_eq!(cfg.dedup_coverage_min_tokens, 4);
        // A malformed value is ignored — the field keeps its default.
        assert_eq!(cfg.energy_window_ms, base.energy_window_ms);
        // An unset field keeps its default.
        assert!(approx(cfg.speech_floor_rms, base.speech_floor_rms));
    }

    #[test]
    fn out_of_range_and_non_finite_overrides_are_clamped_or_ignored() {
        use std::collections::HashMap;
        let env: HashMap<&str, &str> = [
            ("LIVECAP_BLEED_DEDUP_SIMILARITY", "5"), // > 1 → clamp to 1
            ("LIVECAP_BLEED_ATTEN_RATIO", "-1"),     // < 0 → clamp to 0
            ("LIVECAP_BLEED_SPEECH_FLOOR", "NaN"),   // non-finite → ignored (keeps default)
        ]
        .into_iter()
        .collect();
        let base = SuppressionConfig::default();
        let cfg = SuppressionConfig::default()
            .with_overrides(|name| env.get(name).map(|s| (*s).to_string()));
        assert!(approx(cfg.dedup_similarity, 1.0));
        assert!(approx(cfg.atten_ratio, 0.0));
        assert!(approx(cfg.speech_floor_rms, base.speech_floor_rms)); // NaN rejected
    }

    #[test]
    fn rms_of_empty_is_zero() {
        assert!(approx(rms(&[]), 0.0));
    }

    #[test]
    fn rms_of_constant_signal() {
        assert!(approx(rms(&[0.5, -0.5, 0.5, -0.5]), 0.5));
    }

    #[test]
    fn normalize_collapses_punctuation_and_case() {
        assert_eq!(normalize_text("  Hello, WORLD!! "), "hello world");
        assert_eq!(normalize_text("the  quick\nbrown"), "the quick brown");
        assert_eq!(normalize_text("!!!"), "");
    }

    #[test]
    fn jaccard_overlap() {
        assert!(approx(token_jaccard("a b c", "a b c"), 1.0));
        assert!(approx(token_jaccard("", ""), 1.0));
        // {quick,brown,fox} vs {the,quick,brown,fox,jumps} = 3/5
        assert!(approx(token_jaccard("quick brown fox", "the quick brown fox jumps"), 0.6));
        assert!(approx(token_jaccard("a b", "c d"), 0.0));
    }

    #[test]
    fn energy_gate_flags_attenuated_concurrent_mic_as_bleed() {
        let s = suppressor();
        for t in [1_000u64, 1_100, 1_200, 1_300] {
            s.record_system_energy(t, 0.2); // system clearly active
        }
        // Mic segment ending at 1_350, attenuated (0.05 <= 0.7 * 0.2) → bleed.
        assert!(s.mic_segment_is_energy_bleed(1_350, 300, 0.05));
    }

    #[test]
    fn energy_gate_passes_foreground_mic_over_active_system() {
        let s = suppressor();
        for t in [1_000u64, 1_100, 1_200, 1_300] {
            s.record_system_energy(t, 0.2);
        }
        // Mic is louder than the system (user speaking over it) → not bleed.
        assert!(!s.mic_segment_is_energy_bleed(1_350, 300, 0.3));
    }

    #[test]
    fn energy_gate_passes_mic_when_system_quiet_or_absent() {
        let s = suppressor();
        // No system energy at all → not bleed.
        assert!(!s.mic_segment_is_energy_bleed(1_350, 300, 0.05));
        // System present but below the speech floor → not bleed.
        for t in [1_000u64, 1_100, 1_200] {
            s.record_system_energy(t, 0.002);
        }
        assert!(!s.mic_segment_is_energy_bleed(1_350, 300, 0.001));
    }

    #[test]
    fn energy_gate_ignores_system_energy_outside_the_window() {
        let s = suppressor();
        for t in [100u64, 200, 300] {
            s.record_system_energy(t, 0.2);
        }
        // Mic segment far later: the old system energy is outside the look-back.
        assert!(!s.mic_segment_is_energy_bleed(6_000, 300, 0.05));
    }

    #[test]
    fn dedup_drops_normalized_duplicate_mic_text() {
        let s = suppressor();
        s.record_system_final(2_000, "The quick brown fox.");
        assert!(s.mic_text_is_duplicate(2_300, "the quick brown fox"));
        assert!(s.mic_text_is_duplicate(2_300, "Quick brown fox jumps")); // 3/5 ≥ 0.6
    }

    #[test]
    fn dedup_keeps_distinct_mic_text() {
        let s = suppressor();
        s.record_system_final(2_000, "The quick brown fox.");
        assert!(!s.mic_text_is_duplicate(2_300, "let us discuss the budget"));
        assert!(!s.mic_text_is_duplicate(2_300, ""));
    }

    #[test]
    fn dedup_drops_mic_fragment_of_a_longer_system_line() {
        // #2: clean speaker bleed where the mic re-hears only PART of a long
        // system utterance. Symmetric Jaccard is low (the system line is much
        // longer), but every mic token came from the system line → coverage
        // catches it. Mirrors the operator's "And Justin's talk" report.
        let s = suppressor();
        s.record_system_final(
            2_000,
            "And Justin's talk really set the tone for the whole panel today",
        );
        // 3 tokens, all present in the system line, but Jaccard ≈ 3/11 < 0.6.
        assert!(token_jaccard("and justins talk", &normalize_text("And Justin's talk really set the tone for the whole panel today")) < 0.6);
        assert!(s.mic_text_is_duplicate(2_400, "And Justin's talk"));
    }

    #[test]
    fn dedup_coverage_ignores_too_short_a_mic_line() {
        // A one/two-word mic line must NOT be coverage-suppressed on coincidental
        // overlap — genuine short interjections ("Right.", "I agree") survive even
        // if their words happen to appear in a recent system line.
        let s = suppressor();
        s.record_system_final(2_000, "I agree we should ship it this week for sure");
        // "I agree" — only 2 tokens (< dedup_coverage_min_tokens = 3) → kept,
        // even though both tokens are in the system line.
        assert!(!s.mic_text_is_duplicate(2_300, "I agree"));
    }

    #[test]
    fn dedup_keeps_distinct_long_mic_line_over_active_system() {
        // A genuinely distinct mic utterance with only incidental shared words is
        // below both the Jaccard and the coverage thresholds → preserved.
        let s = suppressor();
        s.record_system_final(2_000, "the budget review is scheduled for next quarter");
        assert!(!s.mic_text_is_duplicate(
            2_300,
            "can we revisit the hiring plan instead"
        ));
    }

    #[test]
    fn dedup_forgets_system_finals_after_the_window() {
        let s = suppressor();
        s.record_system_final(2_000, "the quick brown fox");
        // Same text long after the dedup window → no longer a duplicate.
        assert!(!s.mic_text_is_duplicate(2_000 + 8_001, "the quick brown fox"));
    }
}
