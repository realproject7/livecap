//! Streaming-translation unit extraction (#195).
//!
//! During continuous speech the caption keeps scrolling but no translation
//! appears, because translation only starts when an utterance FINALIZES — which
//! needs an ~800 ms pause or a 30 s force-cut. A speaker who does not pause gets
//! nothing for up to half a minute.
//!
//! The fix is to translate *stable prefixes* of the in-flight utterance. The
//! mechanism is LocalAgreement: consecutive partials of the same utterance are
//! compared, and the longest prefix on which two successive partials AGREE is
//! treated as settled — the recognizer is no longer revising it, so it can be
//! translated early and will not need translating again.
//!
//! # Why this is discrete, not a slider
//!
//! The operator asked for a control from "loose" to simultaneous. The underlying
//! mechanism does not vary continuously — there are three genuinely distinct
//! behaviours, and a continuous slider would imply a precision that cannot be
//! implemented honestly. See [`TranslationMode`].
//!
//! # The invariant that keeps this affordable
//!
//! **No text is ever translated twice.** The tracker remembers how much of the
//! utterance it has already released as units; a growing partial can only ever
//! contribute the part beyond that watermark, and [`StablePrefixTracker::on_finalize`]
//! releases only the remaining tail. The finalized line the archive stores is
//! assembled by the host from units already translated plus that tail, so the
//! archive contract (#137's 1:1 mapping) is untouched.

/// How eagerly translation should follow the speaker (#195).
///
/// Ordered loosest → tightest. Each step maps to a real mechanism rather than a
/// tuning knob, which is why these are discrete named steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TranslationMode {
    /// Today's behaviour, and the default: translate only when the utterance
    /// finalizes. No partial ever produces a unit, so token spend is unchanged
    /// for anyone who does not opt in.
    #[default]
    Relaxed,
    /// Release a unit when the settled prefix reaches a clause boundary —
    /// sentence-final punctuation inside the agreed prefix.
    Balanced,
    /// Release at a clause boundary, or after the settled text has stopped
    /// growing for a dwell period, whichever comes first. Follows the speaker
    /// closely even when they never punctuate.
    Live,
}

impl TranslationMode {
    /// Parse a persisted value. Unknown input falls back to the default, which
    /// is the mode that costs nothing extra — a corrupt setting must never
    /// silently upgrade a user's spend.
    pub fn from_str_or_default(value: &str) -> Self {
        match value.trim() {
            "balanced" => Self::Balanced,
            "live" => Self::Live,
            _ => Self::Relaxed,
        }
    }

    /// The persisted wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Relaxed => "relaxed",
            Self::Balanced => "balanced",
            Self::Live => "live",
        }
    }

    /// Whether this mode releases units from partials at all.
    pub fn streams(self) -> bool {
        !matches!(self, Self::Relaxed)
    }
}

/// Minimum words in a released unit. Below this a turn is not worth spending —
/// "So —" costs the same engine turn as a full clause.
pub const MIN_UNIT_WORDS: usize = 8;

/// How long the settled text must stop growing before [`TranslationMode::Live`]
/// releases a unit that has no clause boundary.
pub const LIVE_DWELL_MS: u64 = 1_500;

/// Sentence-final punctuation, including the CJK forms, since the source
/// language is whatever the speaker used.
const CLAUSE_ENDINGS: [char; 7] = ['.', '!', '?', '。', '！', '？', '…'];

/// A unit of source text released for early translation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationUnit {
    /// The newly-settled text — never the whole growing utterance.
    pub text: String,
    /// Why it was released, for the cadence measurements the PR reports.
    pub reason: UnitReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitReason {
    /// Settled text reached sentence-final punctuation.
    Clause,
    /// Settled text stopped growing for [`LIVE_DWELL_MS`] (Live only).
    Dwell,
    /// The utterance finalized; this is the remaining untranslated tail.
    Finalize,
}

/// Longest common prefix of two partials, in whole words.
///
/// Word-granular rather than character-granular on purpose: a recognizer that
/// revises "recogni" → "recognize" has not settled that word, and releasing a
/// half-word would produce a unit no translator can use.
fn agreed_prefix_words(previous: &str, current: &str) -> usize {
    previous
        .split_whitespace()
        .zip(current.split_whitespace())
        .take_while(|(a, b)| a == b)
        .count()
}

/// The word index just past the last clause ending within `words` words, or
/// `None` when the settled text contains no clause boundary.
fn last_clause_boundary(text: &str, words: usize) -> Option<usize> {
    text.split_whitespace()
        .take(words)
        .enumerate()
        .filter(|(_, word)| word.ends_with(CLAUSE_ENDINGS))
        .map(|(index, _)| index + 1)
        .last()
}

/// Tracks one channel's in-flight utterance and releases translation units.
///
/// One tracker per channel; the caller resets it at every utterance boundary.
#[derive(Debug)]
pub struct StablePrefixTracker {
    mode: TranslationMode,
    /// The previous partial, for the LocalAgreement comparison.
    previous: String,
    /// Words already released as units — the never-translate-twice watermark.
    released_words: usize,
    /// When settled-but-unreleased text FIRST appeared, for the Live dwell.
    ///
    /// Deliberately not "when settled text last changed": during continuous
    /// speech the settled prefix grows on every partial, so a last-changed timer
    /// resets forever and Live never fires — which is precisely the case Live
    /// exists for. Measuring how long text has been WAITING to be released is
    /// what makes the dwell fire mid-speech.
    unreleased_since_ms: Option<u64>,
}

impl Default for StablePrefixTracker {
    fn default() -> Self {
        Self::new(TranslationMode::default())
    }
}

impl StablePrefixTracker {
    pub fn new(mode: TranslationMode) -> Self {
        Self {
            mode,
            previous: String::new(),
            released_words: 0,
            unreleased_since_ms: None,
        }
    }

    /// Clear per-utterance state. Call at every utterance boundary — a new
    /// utterance must never inherit the previous one's watermark.
    pub fn reset(&mut self) {
        self.previous.clear();
        self.released_words = 0;
        self.unreleased_since_ms = None;
    }

    /// Feed a partial. Returns a unit when one is due under the current mode.
    ///
    /// Relaxed never returns anything here: that is what makes opting out free.
    pub fn on_partial(&mut self, text: &str, now_ms: u64) -> Option<TranslationUnit> {
        if !self.mode.streams() {
            // Still track the text so a later mode change mid-struct is sane,
            // but never release. Relaxed is byte-compatible with today.
            self.previous = text.to_string();
            return None;
        }

        let settled = agreed_prefix_words(&self.previous, text);
        self.previous = text.to_string();

        if settled <= self.released_words {
            // Nothing new has settled; no text is waiting.
            self.unreleased_since_ms = None;
            return None;
        }
        // Text is waiting to be released — start the clock at the moment it
        // first became available, and let it RUN even as more text settles.
        self.unreleased_since_ms.get_or_insert(now_ms);

        // Prefer a clause boundary inside the settled region.
        let boundary = last_clause_boundary(text, settled).filter(|end| *end > self.released_words);
        let (end, reason) = match boundary {
            Some(end) => (end, UnitReason::Clause),
            None if self.mode == TranslationMode::Live => {
                // Live also releases text that has been waiting long enough,
                // even though the speaker never punctuated it.
                let waiting_ms = now_ms.saturating_sub(self.unreleased_since_ms.unwrap_or(now_ms));
                if waiting_ms < LIVE_DWELL_MS {
                    return None;
                }
                (settled, UnitReason::Dwell)
            }
            None => return None,
        };

        if end - self.released_words < MIN_UNIT_WORDS {
            return None; // too small to be worth a turn
        }

        let unit = words_between(text, self.released_words, end);
        self.released_words = end;
        // Anything still settled-but-unreleased starts a fresh wait from now.
        self.unreleased_since_ms = if settled > end { Some(now_ms) } else { None };
        Some(TranslationUnit { text: unit, reason })
    }

    /// Release the untranslated tail when the utterance finalizes.
    ///
    /// Returns `None` when every word was already released, so a fully-streamed
    /// utterance costs no extra turn. The caller still archives ONE finalized
    /// line per utterance — assembly is the host's job, not this tracker's.
    pub fn on_finalize(&mut self, text: &str) -> Option<TranslationUnit> {
        let total = text.split_whitespace().count();
        let released = self.take_released_on_finalize(text);
        if total == 0 || released >= total {
            return None;
        }
        Some(TranslationUnit {
            text: words_between(text, released, total),
            reason: UnitReason::Finalize,
        })
    }

    /// How many leading words of the finalized utterance were already released,
    /// then reset for the next utterance.
    ///
    /// This is what the pipeline reports on the finalized event: the consumer
    /// keeps archiving the FULL text and translates only the tail beyond this
    /// count. Clamped to the utterance's own word count, because a recognizer
    /// that revises text downward at finalize could otherwise report a prefix
    /// longer than the text and cause real words to be skipped.
    pub fn take_released_on_finalize(&mut self, text: &str) -> usize {
        let released = self.released_words.min(text.split_whitespace().count());
        self.reset();
        released
    }

    /// Words released so far for the current utterance (measurement/testing).
    pub fn released_words(&self) -> usize {
        self.released_words
    }
}

/// The words of `text` in `[start, end)`, joined.
fn words_between(text: &str, start: usize, end: usize) -> String {
    text.split_whitespace()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eight words is the minimum unit, so fixtures need real clauses.
    const C1: &str = "we are committed to the dual mandate of maximum employment.";
    const C2: &str = "inflation has moderated over the past year considerably.";

    #[test]
    fn mode_parses_and_round_trips_with_a_safe_default() {
        assert_eq!(
            TranslationMode::from_str_or_default("relaxed"),
            TranslationMode::Relaxed
        );
        assert_eq!(
            TranslationMode::from_str_or_default("balanced"),
            TranslationMode::Balanced
        );
        assert_eq!(
            TranslationMode::from_str_or_default("live"),
            TranslationMode::Live
        );
        // Anything unknown falls back to the FREE mode, never an expensive one.
        for junk in ["", "  ", "simultaneous", "LIVE", "aggressive"] {
            assert_eq!(
                TranslationMode::from_str_or_default(junk),
                TranslationMode::Relaxed,
                "unknown mode {junk:?} must fall back to Relaxed"
            );
        }
        for mode in [
            TranslationMode::Relaxed,
            TranslationMode::Balanced,
            TranslationMode::Live,
        ] {
            assert_eq!(TranslationMode::from_str_or_default(mode.as_str()), mode);
        }
        assert_eq!(TranslationMode::default(), TranslationMode::Relaxed);
    }

    #[test]
    fn relaxed_never_releases_from_partials() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Relaxed);
        let mut now = 0;
        for _ in 0..5 {
            now += 5_000; // long past any dwell window
            assert_eq!(tracker.on_partial(C1, now), None);
        }
        // The whole utterance arrives at finalize, exactly as today.
        let tail = tracker
            .on_finalize(C1)
            .expect("relaxed must release at finalize");
        assert_eq!(tail.text, C1);
        assert_eq!(tail.reason, UnitReason::Finalize);
    }

    #[test]
    fn agreement_requires_two_partials_to_settle_text() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        // First partial has nothing to agree WITH, so nothing settles.
        assert_eq!(tracker.on_partial(C1, 0), None);
        // A revision means the tail was never settled.
        assert_eq!(
            tracker.on_partial("we are committed to the dual manner", 1_200),
            None
        );
    }

    #[test]
    fn balanced_releases_at_a_clause_boundary_only() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let growing = format!("{C1} inflation has moderated");
        tracker.on_partial(&growing, 0);
        let unit = tracker
            .on_partial(&growing, 1_200)
            .expect("agreed text ending in a clause must release");
        assert_eq!(unit.text, C1);
        assert_eq!(unit.reason, UnitReason::Clause);
        // The un-punctuated tail is NOT released, however long it sits.
        assert_eq!(tracker.on_partial(&growing, 30_000), None);
    }

    #[test]
    fn balanced_never_releases_text_without_punctuation() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let text = "we are committed to the dual mandate of maximum employment and stable prices";
        tracker.on_partial(text, 0);
        // Settled and well over the minimum size, but no clause ending: Balanced
        // waits. This is the whole difference between Balanced and Live.
        assert_eq!(tracker.on_partial(text, 60_000), None);
    }

    #[test]
    fn live_releases_settled_text_after_the_dwell_even_without_punctuation() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Live);
        let text = "we are committed to the dual mandate of maximum employment and stable prices";
        tracker.on_partial(text, 0);
        // Settled at t=1200, but the dwell has not elapsed yet.
        assert_eq!(tracker.on_partial(text, 1_200), None);
        let unit = tracker
            .on_partial(text, 1_200 + LIVE_DWELL_MS)
            .expect("live must release settled text after the dwell");
        assert_eq!(unit.reason, UnitReason::Dwell);
        assert_eq!(unit.text, text);
    }

    #[test]
    fn a_unit_below_the_minimum_size_is_never_released() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Live);
        let text = "so we think."; // 3 words, clause-final
        tracker.on_partial(text, 0);
        assert_eq!(tracker.on_partial(text, 10_000), None);
        assert_eq!(tracker.released_words(), 0);
    }

    /// The cost invariant the whole feature rests on.
    #[test]
    fn no_word_is_ever_released_twice() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Live);
        let mut released: Vec<String> = Vec::new();
        let mut now = 0;
        // A speaker who never pauses: the partial keeps growing.
        let mut text = String::new();
        for chunk in [
            C1,
            C2,
            "the committee will remain data dependent going forward.",
        ] {
            for _ in 0..3 {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(chunk);
                now += 1_200;
                if let Some(unit) = tracker.on_partial(&text, now) {
                    released.push(unit.text);
                }
                now += LIVE_DWELL_MS;
                if let Some(unit) = tracker.on_partial(&text, now) {
                    released.push(unit.text);
                }
            }
        }
        if let Some(tail) = tracker.on_finalize(&text) {
            released.push(tail.text);
        }

        // Concatenating everything released reproduces the utterance EXACTLY
        // once: no gaps (nothing untranslated) and no repeats (nothing paid for
        // twice).
        assert_eq!(released.join(" "), text);
    }

    #[test]
    fn finalize_releases_only_the_untranslated_tail() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let full = format!("{C1} and we will adjust policy as appropriate");
        tracker.on_partial(&full, 0);
        let first = tracker.on_partial(&full, 1_200).expect("clause releases");
        assert_eq!(first.text, C1);

        let tail = tracker.on_finalize(&full).expect("tail must be released");
        assert_eq!(tail.text, "and we will adjust policy as appropriate");
        assert_eq!(tail.reason, UnitReason::Finalize);
        // Released + tail reconstructs the utterance exactly.
        assert_eq!(format!("{} {}", first.text, tail.text), full);
    }

    #[test]
    fn a_fully_streamed_utterance_costs_no_extra_turn_at_finalize() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        tracker.on_partial(C1, 0);
        let unit = tracker.on_partial(C1, 1_200).expect("clause releases");
        assert_eq!(unit.text, C1);
        // Everything was already translated, so finalize must NOT spend a turn.
        assert_eq!(tracker.on_finalize(C1), None);
    }

    #[test]
    fn reset_prevents_one_utterance_inheriting_anothers_watermark() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        tracker.on_partial(C1, 0);
        tracker.on_partial(C1, 1_200).expect("clause releases");
        assert_eq!(tracker.released_words(), 10);
        // Finalize resets, so the next utterance starts from zero and its own
        // first words are not silently skipped as "already translated".
        tracker.on_finalize(C1);
        assert_eq!(tracker.released_words(), 0);
        tracker.on_partial(C2, 5_000);
        let unit = tracker
            .on_partial(C2, 6_200)
            .expect("second utterance releases");
        assert_eq!(unit.text, C2);
    }

    #[test]
    fn an_empty_or_whitespace_utterance_releases_nothing() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Live);
        assert_eq!(tracker.on_partial("", 0), None);
        assert_eq!(tracker.on_partial("   ", 10_000), None);
        assert_eq!(tracker.on_finalize("   "), None);
    }

    #[test]
    fn cjk_sentence_endings_count_as_clause_boundaries() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        // Spaced so the word-granular agreement has something to work with.
        let text = "우리는 이중 책무에 전념하고 최대 고용과 물가 안정을 추구하고 있습니다。 그리고 정책을 조정할 것입니다";
        tracker.on_partial(text, 0);
        let unit = tracker
            .on_partial(text, 1_200)
            .expect("CJK clause must release");
        assert!(unit.text.ends_with('。'));
        assert_eq!(unit.reason, UnitReason::Clause);
    }
}
