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

/// How long settled text may wait with **no clause boundary in sight** before
/// [`TranslationMode::Balanced`] escalates to dwell releases for that stretch
/// (#211).
///
/// # This must clear the inter-boundary interval, not the dwell
///
/// The obvious reading — "it only has to exceed [`LIVE_DWELL_MS`]" — is wrong,
/// and wrong in the expensive direction. The wait clock starts as soon as ANY
/// word settles past the watermark, which happens partway through every clause,
/// so on ordinary punctuated speech this timer is running the whole time a
/// clause is being spoken. A threshold below the gap between boundaries fires
/// mid-clause, spends a dwell turn, and is then de-escalated by the boundary
/// that was about to arrive anyway — roughly two turns per clause instead of
/// one, which is Live's cost with none of Live's benefit.
///
/// #195's fixtures put a boundary every ~2–5 s in ordinary speech
/// (`clause_release_gaps` measures it directly). The floor is therefore the
/// upper tail of that interval, and [`LIVE_DWELL_MS`] is a necessary but badly
/// insufficient bound. The ceiling is Balanced's unpunctuated p95 of ~24 s: any
/// higher and escalation cannot beat the behaviour it exists to replace.
pub const ESCALATE_AFTER_MS: u64 = 8_000;

// Bounds on ESCALATE_AFTER_MS, enforced by the COMPILER rather than by a test,
// because the failure mode is someone retuning the constant later. Below the
// dwell, Balanced silently becomes Live (measured: an identical 2.0x on the
// mixed fixture). Above ~20s it can no longer beat the ~24s wait it exists to
// replace. Neither bound is sufficient on its own — the binding constraint is
// the inter-boundary interval, which only a measurement can supply
// (`escalation_threshold_clears_the_inter_boundary_interval`).
const _: () = assert!(ESCALATE_AFTER_MS > LIVE_DWELL_MS);
const _: () = assert!(ESCALATE_AFTER_MS < 20_000);

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
    /// Whether this stretch has escalated to dwell releases (#211).
    ///
    /// Balanced only. Set when settled text has waited [`ESCALATE_AFTER_MS`]
    /// with no clause boundary; cleared the moment a boundary reappears. The
    /// two triggers are deliberately different KINDS — elapsed time to escalate,
    /// an observed event to de-escalate — so the state cannot flip twice inside
    /// one `ESCALATE_AFTER_MS` window. That asymmetry IS the hysteresis; there
    /// is no damping constant to tune.
    escalated: bool,
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
            escalated: false,
        }
    }

    /// Clear per-utterance state. Call at every utterance boundary — a new
    /// utterance must never inherit the previous one's watermark.
    pub fn reset(&mut self) {
        self.previous.clear();
        self.released_words = 0;
        self.unreleased_since_ms = None;
        self.escalated = false;
    }

    /// Whether this stretch is currently escalated (#211). Test/measurement
    /// accessor: escalation is an internal behaviour of Balanced, never a
    /// setting, so nothing user-facing reads it.
    pub fn is_escalated(&self) -> bool {
        self.escalated
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
        if boundary.is_some() {
            // Punctuation is back, so this stretch is over — whether or not the
            // boundary is large enough to release below. De-escalating on the
            // OBSERVATION rather than on the release keeps the rule "is the
            // speaker punctuating?", which is the condition escalation is for.
            self.escalated = false;
        }
        let (end, reason) = match boundary {
            Some(end) => (end, UnitReason::Clause),
            None => {
                // No boundary in the settled text. Live always falls back to the
                // dwell; Balanced does so only once this stretch has gone long
                // enough without punctuation to escalate (#211).
                let waiting_ms = now_ms.saturating_sub(self.unreleased_since_ms.unwrap_or(now_ms));
                if self.mode == TranslationMode::Balanced && !self.escalated {
                    if waiting_ms < ESCALATE_AFTER_MS {
                        return None;
                    }
                    self.escalated = true;
                }
                if waiting_ms < LIVE_DWELL_MS {
                    return None;
                }
                (settled, UnitReason::Dwell)
            }
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

    /// Settle `text` and return the moment its wait clock started.
    ///
    /// LocalAgreement needs two AGREEING partials, so nothing settles on the
    /// first one and the clock starts at the SECOND. Every timing test here
    /// depends on that offset, and getting it wrong makes escalation look like
    /// it fires late rather than the test measuring from the wrong instant.
    fn settle_unpunctuated(tracker: &mut StablePrefixTracker, text: &str) -> u64 {
        tracker.on_partial(text, 0);
        assert_eq!(tracker.on_partial(text, 1_200), None, "nothing is due yet");
        1_200
    }

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

    /// CHANGED BY #211. This asserted Balanced waits FOREVER without punctuation
    /// (it probed at t=60s). That was the defect: an unpunctuated speaker got
    /// nothing from Balanced at all. It now waits only until the stretch has
    /// proven itself unpunctuated.
    #[test]
    fn balanced_holds_unpunctuated_text_until_the_stretch_proves_itself() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let text = "we are committed to the dual mandate of maximum employment and stable prices";
        let since = settle_unpunctuated(&mut tracker, text);
        // Settled and well over the minimum size, but no clause ending. Balanced
        // still waits — for a whole clause's worth of time, not the mere dwell.
        assert_eq!(tracker.on_partial(text, since + LIVE_DWELL_MS + 1), None);
        assert_eq!(
            tracker.on_partial(text, since + ESCALATE_AFTER_MS - 1),
            None
        );
        assert!(!tracker.is_escalated());

        let unit = tracker
            .on_partial(text, since + ESCALATE_AFTER_MS)
            .expect("balanced must escalate once the stretch is proven unpunctuated");
        assert_eq!(unit.reason, UnitReason::Dwell);
        assert!(tracker.is_escalated());
    }

    #[test]
    fn punctuated_speech_never_escalates_however_long_it_runs() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        // A speaker who punctuates every ~5s — the widest inter-boundary gap the
        // fixtures produce — for a minute. The wait clock is running the whole
        // time, so this is the case a threshold set against LIVE_DWELL_MS alone
        // would charge a turn per clause for.
        let mut text = String::new();
        let mut at = 0;
        for _ in 0..12 {
            text.push_str(C1);
            text.push(' ');
            tracker.on_partial(&text, at);
            at += 5_000;
            let unit = tracker.on_partial(&text, at).expect("a clause is due");
            assert_eq!(unit.reason, UnitReason::Clause);
            assert!(
                !tracker.is_escalated(),
                "punctuated speech must not escalate"
            );
        }
    }

    #[test]
    fn a_returning_boundary_de_escalates_the_stretch() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let bare = "we are committed to the dual mandate of maximum employment and stable prices";
        let since = settle_unpunctuated(&mut tracker, bare);
        tracker
            .on_partial(bare, since + ESCALATE_AFTER_MS)
            .expect("escalates on an unpunctuated stretch");
        assert!(tracker.is_escalated());

        // Punctuation returns.
        let punctuated =
            format!("{bare} and the committee will act accordingly as conditions warrant.");
        tracker.on_partial(&punctuated, since + ESCALATE_AFTER_MS + 1_200);
        let unit = tracker
            .on_partial(&punctuated, since + ESCALATE_AFTER_MS + 2_400)
            .expect("the new clause is due");
        assert_eq!(unit.reason, UnitReason::Clause);
        assert!(!tracker.is_escalated(), "a boundary ends the stretch");
    }

    /// The no-oscillation property, asserted as a PROPERTY rather than by
    /// counting flips on one fixture.
    ///
    /// Escalation is triggered by elapsed time and de-escalation by an observed
    /// event, so the two directions can never be satisfied by the same input.
    /// The consequence is a hard floor on the flip period: after de-escalating,
    /// nothing can re-escalate until another full ESCALATE_AFTER_MS of
    /// boundary-free waiting has passed. There is no damping constant here —
    /// the asymmetry is the hysteresis.
    #[test]
    fn escalation_cannot_flip_twice_inside_one_window() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let bare = "we are committed to the dual mandate of maximum employment and stable prices";
        let since = settle_unpunctuated(&mut tracker, bare);
        tracker
            .on_partial(bare, since + ESCALATE_AFTER_MS)
            .expect("escalates");
        assert!(tracker.is_escalated());

        // A boundary arrives and de-escalates.
        let punctuated =
            format!("{bare} and the committee will act accordingly as conditions warrant.");
        tracker.on_partial(&punctuated, since + ESCALATE_AFTER_MS + 1_200);
        tracker
            .on_partial(&punctuated, since + ESCALATE_AFTER_MS + 2_400)
            .expect("clause release");
        let de_escalated_at = since + ESCALATE_AFTER_MS + 2_400;
        assert!(!tracker.is_escalated());

        // Now speech goes unpunctuated again. Probe every 500ms across the whole
        // window: it must not re-escalate anywhere inside it.
        let mut text = punctuated.clone();
        text.push_str(" and the committee will continue to monitor incoming data closely");
        let mut at = de_escalated_at + 500;
        while at < de_escalated_at + ESCALATE_AFTER_MS {
            tracker.on_partial(&text, at);
            assert!(
                !tracker.is_escalated(),
                "re-escalated at {at}, only {}ms after de-escalating",
                at - de_escalated_at
            );
            at += 500;
        }
    }

    #[test]
    fn relaxed_and_live_are_untouched_by_escalation() {
        // Relaxed never streams, so it can never escalate.
        let mut relaxed = StablePrefixTracker::new(TranslationMode::Relaxed);
        let bare = "we are committed to the dual mandate of maximum employment and stable prices";
        relaxed.on_partial(bare, 0);
        assert_eq!(relaxed.on_partial(bare, 10 * ESCALATE_AFTER_MS), None);
        assert!(!relaxed.is_escalated());

        // Live still dwells immediately — escalation is Balanced's way of
        // REACHING Live's behaviour, not a change to Live itself.
        let mut live = StablePrefixTracker::new(TranslationMode::Live);
        let since = settle_unpunctuated(&mut live, bare);
        let unit = live
            .on_partial(bare, since + LIVE_DWELL_MS)
            .expect("live dwells without waiting for escalation");
        assert_eq!(unit.reason, UnitReason::Dwell);
        assert!(!live.is_escalated(), "live does not need to escalate");
    }

    #[test]
    fn a_new_utterance_starts_unescalated() {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let bare = "we are committed to the dual mandate of maximum employment and stable prices";
        let since = settle_unpunctuated(&mut tracker, bare);
        tracker
            .on_partial(bare, since + ESCALATE_AFTER_MS)
            .expect("escalates");
        assert!(tracker.is_escalated());
        // Finalizing resets the tracker; the next utterance must earn its own
        // escalation rather than inherit one.
        tracker.on_finalize(bare);
        assert!(!tracker.is_escalated());
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
