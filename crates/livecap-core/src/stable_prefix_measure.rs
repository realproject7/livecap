//! Cadence measurement for the three translation modes (#195).
//!
//! The operator's requirement is that each mode's Settings copy carries a
//! **measured** multiplier — "about 2× the translation requests of Relaxed" —
//! rather than a vague "may use more tokens". This module produces those
//! numbers from a scripted fixture, so the figure in the UI is reproducible and
//! re-derivable rather than an estimate somebody once wrote down.
//!
//! # What is and is not measured here
//!
//! **Turns are measured exactly.** Given a fixture, the number of units a mode
//! dispatches is deterministic, and turns are what the engine bills per
//! request. That is the headline multiplier, and it is what the UI copy states.
//!
//! **Words are measured exactly**, as the volume of text translated.
//!
//! **Tokens are NOT counted here.** Tokenizing needs the real engine, and a
//! translate turn measured 165 input tokens for a single sentence on the Claude
//! tier — so per-turn overhead dominates short units and the turn multiplier is
//! the honest proxy. Anything claiming a token count from this module would be
//! an estimate dressed as a measurement.
//!
//! **Latency is in fixture time**, i.e. milliseconds from a word first being
//! heard in a partial to the unit carrying it being dispatched. It measures the
//! scheduling win, which is what the modes actually change; it excludes engine
//! round-trip, which is identical across modes.

use crate::stable_prefix::{StablePrefixTracker, TranslationMode};

/// One scripted step of continuous speech: the partial text as it stands at
/// `at_ms`, and whether the utterance finalizes at that point.
#[derive(Debug, Clone)]
pub struct ScriptStep {
    pub at_ms: u64,
    pub text: String,
    pub finalizes: bool,
}

/// What a mode cost and how quickly it responded on one fixture.
#[derive(Debug, Clone, PartialEq)]
pub struct CadenceMeasurement {
    pub mode: TranslationMode,
    /// Units dispatched — one engine turn each. The billable quantity.
    pub turns: usize,
    /// Words of source text released across those turns.
    pub words: usize,
    /// Fixture duration, for per-minute rates.
    pub speech_ms: u64,
    /// Per-word latency: heard → dispatched, sorted ascending.
    latencies_ms: Vec<u64>,
}

impl CadenceMeasurement {
    pub fn turns_per_minute(&self) -> f64 {
        if self.speech_ms == 0 {
            return 0.0;
        }
        self.turns as f64 * 60_000.0 / self.speech_ms as f64
    }

    pub fn words_per_minute(&self) -> f64 {
        if self.speech_ms == 0 {
            return 0.0;
        }
        self.words as f64 * 60_000.0 / self.speech_ms as f64
    }

    /// Latency percentile in fixture milliseconds. `p` is 0..=100.
    pub fn latency_p(&self, p: usize) -> u64 {
        if self.latencies_ms.is_empty() {
            return 0;
        }
        // Nearest-rank: the smallest value at or above the p-th percentile.
        let rank = (p * self.latencies_ms.len()).div_ceil(100).max(1);
        self.latencies_ms[rank - 1]
    }

    /// Turn multiplier against a baseline (Relaxed). This is the number the UI
    /// copy states, so it is deliberately the plain ratio of billable turns.
    pub fn turn_multiplier(&self, baseline: &CadenceMeasurement) -> f64 {
        if baseline.turns == 0 {
            return 0.0;
        }
        self.turns as f64 / baseline.turns as f64
    }
}

/// Replay a script through one mode and measure what it cost.
///
/// The same script drives every mode, which is what makes the multipliers
/// comparable: any difference is the mode's scheduling, not a different input.
pub fn measure(mode: TranslationMode, script: &[ScriptStep]) -> CadenceMeasurement {
    let mut tracker = StablePrefixTracker::new(mode);
    let mut turns = 0usize;
    let mut words = 0usize;
    let mut latencies_ms: Vec<u64> = Vec::new();
    // When each word index of the current utterance was FIRST heard, so latency
    // is measured from the speaker, not from when the tracker settled it.
    let mut first_heard_ms: Vec<u64> = Vec::new();
    let mut dispatched_words = 0usize;

    let record = |unit_words: usize,
                  now_ms: u64,
                  dispatched: &mut usize,
                  heard: &[u64],
                  lat: &mut Vec<u64>| {
        for index in *dispatched..(*dispatched + unit_words) {
            let heard_at = heard.get(index).copied().unwrap_or(now_ms);
            lat.push(now_ms.saturating_sub(heard_at));
        }
        *dispatched += unit_words;
    };

    for step in script {
        // Note when each newly-appearing word was first heard.
        let count = step.text.split_whitespace().count();
        while first_heard_ms.len() < count {
            first_heard_ms.push(step.at_ms);
        }

        if step.finalizes {
            let released_before = tracker.released_words();
            if let Some(unit) = tracker.on_finalize(&step.text) {
                let unit_words = unit.text.split_whitespace().count();
                turns += 1;
                words += unit_words;
                record(
                    unit_words,
                    step.at_ms,
                    &mut dispatched_words,
                    &first_heard_ms,
                    &mut latencies_ms,
                );
            }
            let _ = released_before;
            // A finalized utterance ends the word-timing frame.
            first_heard_ms.clear();
            dispatched_words = 0;
        } else if let Some(unit) = tracker.on_partial(&step.text, step.at_ms) {
            let unit_words = unit.text.split_whitespace().count();
            turns += 1;
            words += unit_words;
            record(
                unit_words,
                step.at_ms,
                &mut dispatched_words,
                &first_heard_ms,
                &mut latencies_ms,
            );
        }
    }

    latencies_ms.sort_unstable();
    CadenceMeasurement {
        mode,
        turns,
        words,
        speech_ms: script.last().map(|s| s.at_ms).unwrap_or(0),
        latencies_ms,
    }
}

/// Build a continuous-speech script: a speaker who never pauses long enough to
/// finalize, so the partial keeps growing until the 30 s force-cut.
///
/// This is the case #195 exists for — the one where today's behaviour leaves the
/// viewer with no translation at all for up to half a minute.
pub fn continuous_speech_script(clauses: &[&str], partial_interval_ms: u64) -> Vec<ScriptStep> {
    let mut steps = Vec::new();
    let mut spoken = String::new();
    let mut at_ms = 0u64;
    for clause in clauses {
        for word in clause.split_whitespace() {
            if !spoken.is_empty() {
                spoken.push(' ');
            }
            spoken.push_str(word);
            at_ms += partial_interval_ms / 4; // ~4 words per partial interval
                                              // A partial is only produced every `partial_interval_ms`.
            if at_ms % partial_interval_ms < partial_interval_ms / 4 {
                steps.push(ScriptStep {
                    at_ms,
                    text: spoken.clone(),
                    finalizes: false,
                });
            }
        }
        // Each clause boundary still produces a partial, so Balanced can see it.
        steps.push(ScriptStep {
            at_ms,
            text: spoken.clone(),
            finalizes: false,
        });
        steps.push(ScriptStep {
            at_ms: at_ms + partial_interval_ms,
            text: spoken.clone(),
            finalizes: false,
        });
        at_ms += partial_interval_ms;
    }
    // The utterance finally finalizes (a pause, or the 30 s force-cut).
    steps.push(ScriptStep {
        at_ms: at_ms + 800,
        text: spoken,
        finalizes: true,
    });
    steps
}

/// Build a realistic mixed meeting: mostly natural speech with pauses, plus a
/// few stretches where the speaker runs on without pausing.
///
/// 100% continuous speech is a synthetic worst case nobody actually talks in,
/// and 100% natural speech understates the problem — a real meeting is mostly
/// the latter with occasional bursts of the former. `monologue_runs` gives the
/// clause indices where a run STARTS and how many clauses it swallows, so the
/// composition of the fixture is explicit rather than buried in the shape of
/// the data.
pub fn mixed_meeting_script(
    clauses: &[&str],
    partial_interval_ms: u64,
    monologue_runs: &[(usize, usize)],
) -> Vec<ScriptStep> {
    let mut steps = Vec::new();
    let mut at_ms = 0u64;
    let mut index = 0usize;
    while index < clauses.len() {
        // Does a run start here, and how many clauses does it cover?
        let run_len = monologue_runs
            .iter()
            .find(|(start, _)| *start == index)
            .map(|(_, len)| (*len).max(1))
            .unwrap_or(1)
            .min(clauses.len() - index);

        let mut spoken = String::new();
        for clause in &clauses[index..index + run_len] {
            for word in clause.split_whitespace() {
                if !spoken.is_empty() {
                    spoken.push(' ');
                }
                spoken.push_str(word);
                at_ms += partial_interval_ms / 4;
                steps.push(ScriptStep {
                    at_ms,
                    text: spoken.clone(),
                    finalizes: false,
                });
            }
            if run_len > 1 {
                // Mid-run clause boundary: a partial lands, but no pause, so the
                // utterance keeps growing.
                steps.push(ScriptStep {
                    at_ms: at_ms + partial_interval_ms,
                    text: spoken.clone(),
                    finalizes: false,
                });
                at_ms += partial_interval_ms;
            }
        }
        // The run ends with a pause, so this utterance finalizes.
        at_ms += 800;
        steps.push(ScriptStep {
            at_ms,
            text: spoken,
            finalizes: true,
        });
        index += run_len;
    }
    steps
}

/// Strip sentence-final punctuation from a clause set.
///
/// This is what actually separates Balanced from Live. Balanced only releases
/// at punctuation, so on unpunctuated speech — a speaker the recognizer never
/// gives a full stop, which is common in fast or accented speech — Balanced
/// degrades to Relaxed and the viewer is back to waiting. Live's dwell trigger
/// is the whole reason that step exists, and without this fixture "Live" would
/// be a claim the measurement never demonstrates.
pub fn unpunctuated(clauses: &[&str]) -> Vec<String> {
    clauses
        .iter()
        .map(|clause| {
            clause
                .split_whitespace()
                .map(|word| word.trim_end_matches(['.', '!', '?', '。', '！', '？', '…']))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

/// Build a natural-speech script: the speaker pauses between clauses, so each
/// clause finalizes as its own utterance.
///
/// This is the TYPICAL case, and it is the other half of an honest measurement.
/// Relaxed already spends a turn per utterance here, so the streaming modes have
/// far less headroom to add — measuring only continuous speech would report a
/// worst case as if it were the everyday one.
pub fn natural_speech_script(clauses: &[&str], partial_interval_ms: u64) -> Vec<ScriptStep> {
    let mut steps = Vec::new();
    let mut at_ms = 0u64;
    for clause in clauses {
        let mut spoken = String::new();
        for word in clause.split_whitespace() {
            if !spoken.is_empty() {
                spoken.push(' ');
            }
            spoken.push_str(word);
            at_ms += partial_interval_ms / 4;
            steps.push(ScriptStep {
                at_ms,
                text: spoken.clone(),
                finalizes: false,
            });
        }
        // The speaker pauses: this utterance finalizes on its own.
        at_ms += 800;
        steps.push(ScriptStep {
            at_ms,
            text: spoken,
            finalizes: true,
        });
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stable_prefix::{UnitReason, ESCALATE_AFTER_MS};

    /// One clause set, used by BOTH fixtures so the two speech patterns are
    /// compared on identical text.
    /// A 12-clause meeting, used for the mixed fixture.
    const MEETING: &[&str] = &[
        "we are committed to the dual mandate of maximum employment and stable prices.",
        "inflation has moderated over the past year but remains above our longer run goal.",
        "the committee will remain data dependent as it assesses incoming information.",
        "we will adjust the stance of policy as appropriate to achieve our objectives.",
        "labor market conditions have come into better balance over recent months.",
        "consumer spending has continued to grow at a solid pace this quarter.",
        "housing activity remains subdued relative to its pre pandemic level.",
        "business investment in equipment has picked up modestly since the spring.",
        "financial conditions have tightened somewhat over the intermeeting period.",
        "the path forward is not on a preset course and depends on the data.",
        "we are prepared to maintain the current stance for as long as needed.",
        "let me turn now to the outlook for growth over the coming year.",
    ];

    const CLAUSES: &[&str] = &[
        "we are committed to the dual mandate of maximum employment and stable prices.",
        "inflation has moderated over the past year but remains above our longer run goal.",
        "the committee will remain data dependent as it assesses incoming information.",
        "we will adjust the stance of policy as appropriate to achieve our objectives.",
        "labor market conditions have come into better balance over recent months.",
    ];

    /// A ~25 s monologue with no pause long enough to finalize — the case #195
    /// exists for.
    fn fixture() -> Vec<ScriptStep> {
        continuous_speech_script(CLAUSES, 1_200)
    }

    #[test]
    fn relaxed_is_one_turn_per_utterance_and_the_full_text() {
        let relaxed = measure(TranslationMode::Relaxed, &fixture());
        // Today's behaviour: nothing until finalize, then exactly one turn.
        assert_eq!(relaxed.turns, 1);
        assert_eq!(relaxed.turn_multiplier(&relaxed), 1.0);
    }

    /// The operator's check: a DISPATCH COUNT over a scripted continuous
    /// utterance, not an inspection of the code.
    #[test]
    fn no_span_is_dispatched_twice_in_any_mode() {
        let script = fixture();
        let total_words = script
            .last()
            .map(|s| s.text.split_whitespace().count())
            .unwrap_or(0);
        for mode in [
            TranslationMode::Relaxed,
            TranslationMode::Balanced,
            TranslationMode::Live,
        ] {
            let m = measure(mode, &script);
            // Every word is translated exactly once: the words released across
            // all turns equal the utterance's word count. Fewer would mean
            // untranslated text; more would mean paying twice.
            assert_eq!(
                m.words, total_words,
                "{mode:?} released {} words for a {total_words}-word utterance",
                m.words
            );
        }
    }

    /// The reason Live exists as a separate step. On speech the recognizer
    /// never punctuates, Balanced has no boundary to cut at and degrades to
    /// Relaxed — the viewer waits again. Live's dwell keeps following.
    /// The PO's decision fixture: a realistic meeting rather than a synthetic
    /// worst case. Mostly paused speech with a couple of run-on stretches, which
    /// is how people actually talk.
    #[test]
    fn mixed_meeting_multipliers() {
        let script = mixed_meeting_script(MEETING, 1_200, &[(2, 2), (7, 2)]);
        let relaxed = measure(TranslationMode::Relaxed, &script);
        let balanced = measure(TranslationMode::Balanced, &script);
        let live = measure(TranslationMode::Live, &script);
        println!(
            "\nMIXED meeting (12 clauses: 8 paused, two 2-clause monologues)\n  Relaxed {} turns  p95 {} ms\n  Balanced {} turns ({:.2}x)  p95 {} ms\n  Live {} turns ({:.2}x)  p95 {} ms\n",
            relaxed.turns,
            relaxed.latency_p(95),
            balanced.turns,
            balanced.turn_multiplier(&relaxed),
            balanced.latency_p(95),
            live.turns,
            live.turn_multiplier(&relaxed),
            live.latency_p(95),
        );
        // Every mode still translates each word exactly once.
        let words: usize = MEETING.iter().map(|c| c.split_whitespace().count()).sum();
        for m in [&relaxed, &balanced, &live] {
            assert_eq!(
                m.words, words,
                "{:?} released {} of {words} words",
                m.mode, m.words
            );
        }
    }

    /// CHANGED BY #211. This asserted that Balanced behaves exactly like Relaxed
    /// on unpunctuated speech — one turn, the same long wait. That WAS true, and
    /// it is the defect #211 exists to remove: Balanced now escalates when a
    /// stretch goes long enough without punctuation, so it keeps up too.
    #[test]
    fn balanced_escalates_to_keep_up_with_unpunctuated_speech() {
        let bare = unpunctuated(CLAUSES);
        let bare_refs: Vec<&str> = bare.iter().map(|s| s.as_str()).collect();
        let script = continuous_speech_script(&bare_refs, 1_200);

        let relaxed = measure(TranslationMode::Relaxed, &script);
        let balanced = measure(TranslationMode::Balanced, &script);
        let live = measure(TranslationMode::Live, &script);

        // Balanced no longer collapses to Relaxed here — this is the whole point.
        assert!(
            balanced.turns > relaxed.turns,
            "balanced released {} units vs relaxed {}",
            balanced.turns,
            relaxed.turns
        );
        assert!(
            balanced.latency_p(95) < relaxed.latency_p(95),
            "balanced p95 {} should beat relaxed p95 {}",
            balanced.latency_p(95),
            relaxed.latency_p(95)
        );

        // But it stays CHEAPER than Live, because it waits for the stretch to
        // prove itself unpunctuated before it starts dwelling. Escalation buys
        // Live's benefit here without buying Live's cost everywhere else.
        assert!(
            balanced.turns < live.turns,
            "escalated balanced {} should cost less than live {}",
            balanced.turns,
            live.turns
        );
    }

    /// The interval @re2 identified as the real floor for `ESCALATE_AFTER_MS`.
    ///
    /// The wait clock starts partway through every clause, so a threshold below
    /// the gap between boundaries fires mid-clause on ordinary speech, spends a
    /// turn, and is de-escalated by the boundary that was arriving anyway.
    /// "Longer than the dwell" is not the constraint; "longer than this" is.
    fn clause_release_gaps(script: &[ScriptStep]) -> Vec<u64> {
        let mut tracker = StablePrefixTracker::new(TranslationMode::Balanced);
        let mut last: Option<u64> = None;
        let mut gaps = Vec::new();
        for step in script {
            if step.finalizes {
                // Mirror the pipeline: finalizing resets the tracker, so the
                // next utterance starts a fresh stretch. Measuring a "gap"
                // across an utterance boundary would fold in the speaker's
                // pause and inflate the interval — it is not a gap escalation
                // could ever see.
                tracker.on_finalize(&step.text);
                last = None;
                continue;
            }
            if let Some(unit) = tracker.on_partial(&step.text, step.at_ms) {
                if unit.reason == UnitReason::Clause {
                    if let Some(previous) = last {
                        gaps.push(step.at_ms - previous);
                    }
                    last = Some(step.at_ms);
                }
            }
        }
        gaps
    }

    #[test]
    fn escalation_threshold_clears_the_inter_boundary_interval() {
        let mut worst = 0;
        for (label, script) in [
            ("natural", natural_speech_script(CLAUSES, 1_200)),
            ("continuous", continuous_speech_script(CLAUSES, 1_200)),
            (
                "mixed",
                mixed_meeting_script(MEETING, 1_200, &[(2, 2), (7, 2)]),
            ),
        ] {
            let gaps = clause_release_gaps(&script);
            let max = gaps.iter().copied().max().unwrap_or(0);
            println!("{label}: clause-release gaps {gaps:?} max {max}ms");
            worst = worst.max(max);
        }
        // The constant is derived from this number, not fitted to a multiplier.
        assert!(
            ESCALATE_AFTER_MS > worst,
            "ESCALATE_AFTER_MS {ESCALATE_AFTER_MS} must exceed the widest \
             inter-boundary gap in punctuated speech ({worst}ms), or escalation \
             fires mid-clause and costs a turn per clause"
        );
        // The other two bounds are compile-time assertions on the constant
        // itself (see `stable_prefix.rs`), so they hold whether or not anyone
        // runs this test.
    }

    #[test]
    fn streaming_modes_respond_faster_than_relaxed() {
        let script = fixture();
        let relaxed = measure(TranslationMode::Relaxed, &script);
        let balanced = measure(TranslationMode::Balanced, &script);
        let live = measure(TranslationMode::Live, &script);

        // The whole point of the feature: the first words are translated long
        // before the utterance finalizes.
        assert!(
            balanced.latency_p(95) < relaxed.latency_p(95),
            "balanced p95 {} should beat relaxed p95 {}",
            balanced.latency_p(95),
            relaxed.latency_p(95)
        );
        assert!(
            live.latency_p(95) <= balanced.latency_p(95),
            "live p95 {} should be at least as fast as balanced p95 {}",
            live.latency_p(95),
            balanced.latency_p(95)
        );
    }

    /// The multiplier is dominated by how the speaker talks, not by the mode
    /// alone — which is why a single number would have been misleading.
    ///
    /// Continuous speech is the WORST case for cost (Relaxed spends one turn for
    /// a whole 25 s monologue) and the BEST case for latency (that is the
    /// half-minute wait #195 exists to remove). Natural speech is the typical
    /// case: Relaxed already spends a turn per clause, so streaming adds little.
    #[test]
    fn the_cost_multiplier_depends_on_speech_pattern_not_mode_alone() {
        let continuous = fixture();
        let natural = natural_speech_script(CLAUSES, 1_200);

        let cont_relaxed = measure(TranslationMode::Relaxed, &continuous);
        let cont_balanced = measure(TranslationMode::Balanced, &continuous);
        let nat_relaxed = measure(TranslationMode::Relaxed, &natural);
        let nat_balanced = measure(TranslationMode::Balanced, &natural);

        // Continuous: Relaxed is one turn for the entire monologue, so any
        // streaming at all is a large relative increase.
        assert_eq!(cont_relaxed.turns, 1);
        assert!(cont_balanced.turn_multiplier(&cont_relaxed) > 3.0);

        // Natural: Relaxed already pays per clause, so the streaming modes add
        // nothing like the same proportion.
        assert!(
            nat_balanced.turn_multiplier(&nat_relaxed) <= 1.5,
            "natural-speech multiplier was {:.2}x",
            nat_balanced.turn_multiplier(&nat_relaxed)
        );
    }

    /// Prints the table that the PR body and the Settings copy quote. Run with
    /// `cargo test -p livecap-core --lib cadence_table -- --nocapture`.
    #[test]
    fn cadence_table() {
        let bare = unpunctuated(CLAUSES);
        let bare_refs: Vec<&str> = bare.iter().map(|s| s.as_str()).collect();
        for (label, script) in [
            ("continuous speech (no pause)", fixture()),
            (
                "natural speech (pauses)",
                natural_speech_script(CLAUSES, 1_200),
            ),
            (
                "continuous + UNPUNCTUATED (only Live helps here)",
                continuous_speech_script(&bare_refs, 1_200),
            ),
            (
                "MIXED meeting: 12 clauses, 8 paused + two 2-clause monologues",
                mixed_meeting_script(MEETING, 1_200, &[(2, 2), (7, 2)]),
            ),
        ] {
            println!("\n=== {label} ===");
            print_table(&script);
        }
    }

    fn print_table(script: &[ScriptStep]) {
        let relaxed = measure(TranslationMode::Relaxed, script);
        println!(
            "\n{:<9} {:>6} {:>7} {:>10} {:>10} {:>9}",
            "mode", "turns", "words", "turns/min", "p50 (ms)", "p95 (ms)"
        );
        for mode in [
            TranslationMode::Relaxed,
            TranslationMode::Balanced,
            TranslationMode::Live,
        ] {
            let m = measure(mode, script);
            println!(
                "{:<9} {:>6} {:>7} {:>10.1} {:>10} {:>9}   {:.1}x turns vs Relaxed",
                format!("{mode:?}"),
                m.turns,
                m.words,
                m.turns_per_minute(),
                m.latency_p(50),
                m.latency_p(95),
                m.turn_multiplier(&relaxed),
            );
        }
        println!("(fixture: {} ms of continuous speech)\n", relaxed.speech_ms);
    }
}
