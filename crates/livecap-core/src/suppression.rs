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
}

impl Default for SuppressionConfig {
    fn default() -> Self {
        Self {
            speech_floor_rms: 0.012,
            atten_ratio: 0.7,
            energy_window_ms: 1_500,
            energy_retain_ms: 12_000,
            dedup_window_ms: 8_000,
            dedup_similarity: 0.6,
        }
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
        let threshold = self.cfg.dedup_similarity;
        inner
            .finals
            .iter()
            .any(|f| f.norm == norm || token_jaccard(&f.norm, &norm) >= threshold)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn suppressor() -> CrossChannelSuppressor {
        CrossChannelSuppressor::new(SuppressionConfig::default())
    }

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
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
    fn dedup_forgets_system_finals_after_the_window() {
        let s = suppressor();
        s.record_system_final(2_000, "the quick brown fox");
        // Same text long after the dedup window → no longer a duplicate.
        assert!(!s.mic_text_is_duplicate(2_000 + 8_001, "the quick brown fox"));
    }
}
