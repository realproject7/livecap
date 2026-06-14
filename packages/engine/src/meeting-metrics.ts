// Meeting metrics (#78, EPIC #76 v1.1 feature 2): talk-time ratio + Smooth Score.
//
// Pure TS, deterministic, no LLM, no I/O — so the whole module unit-tests over
// synthetic record arrays and runs on Linux CI. It consumes an EXPLICIT typed
// array the host builds from finalized captions; it never reaches into engine
// events. (Per-utterance duration is NOT on the TS-side finalized event today —
// `BridgeCaption::from_event` drops start_ms/end_ms via `..`; plumbing
// `durationMs` through the bridge is a separate app-side ticket, #81. This
// module just consumes the typed array once that lands.)
//
// IMPORTANT: `durationMs` is SPEAKING duration (end_ms - start_ms). It is NOT
// `epochMs` (wall-clock at finalize), which is available today but is not a
// duration — do not substitute it.

/** Which side an utterance came from: "mic" = the user's own speech. */
export type MetricsChannel = "mic" | "system";

/** One finalized utterance, as the host accumulates it for metrics (#78/#81). */
export interface FinalizedRecord {
  channel: MetricsChannel;
  /** Spoken duration in ms (end_ms - start_ms). NOT wall-clock epochMs. */
  durationMs: number;
  /** Finalized transcript text. */
  text: string;
  /** True when the STT pipeline marked this utterance low-confidence. */
  lowConfidence: boolean;
}

/** Spoken-time breakdown, in ms, plus the mic ("me") share of total speech. */
export interface TalkTime {
  micMs: number;
  systemMs: number;
  totalMs: number;
  /** mic / total, in [0,1]. 0 when there is no speech at all. */
  micShare: number;
}

/**
 * The transparent inputs to the Smooth Score, surfaced so the review screen can
 * explain the number ("you used 12 fillers across 240 words") and so tests can
 * assert the formula directly.
 */
export interface SmoothSignals {
  /** Total words across mic utterances. */
  micWordCount: number;
  /** Filler tokens/phrases in mic text (um, uh, you know, 음, 그러니까, …). */
  fillerCount: number;
  /** Repair/restart markers in mic text (em-dash restarts, immediate word
   *  repetition, "I mean"). */
  repairCount: number;
  /** Fraction of mic utterances flagged low-confidence by STT, in [0,1]. */
  lowConfidenceRate: number;
  /** (fillerCount + repairCount) / micWordCount, clamped to [0,1]. */
  disfluencyDensity: number;
}

export interface MeetingMetrics {
  talkTime: TalkTime;
  /** Delivery/fluency score for the user's OWN (mic) speech, in [0,100]. */
  smoothScore: number;
  signals: SmoothSignals;
}

// --- Smooth Score formula (documented, deterministic) -----------------------
//
//   disfluencyDensity = clamp((fillerCount + repairCount) / micWordCount, 0, 1)
//   lowConfidenceRate = micLowConfidenceCount / micUtteranceCount
//   penalty = DISFLUENCY_WEIGHT * disfluencyDensity + LOWCONF_WEIGHT * lowConfidenceRate
//   smoothScore = round(100 * clamp(1 - penalty, 0, 1))
//
// Monotonic by construction: more disfluencies or more low-confidence
// utterances strictly raise `penalty`, which strictly lowers the score, and the
// final clamp keeps it within [0,100]. With no mic speech there is nothing to
// penalize, so the score is 100.
//
// Only the two signals we can compute soundly from the typed array drive the
// score for v1.1: disfluency density (from `text`) and low-confidence rate (from
// `lowConfidence`). Other delivery signals named in the ticket — average
// utterance length, long-pause rate — are deferred: pause rate needs
// inter-utterance gaps (start offsets), and the array carries only per-utterance
// `durationMs`, not start times, so gaps are not derivable here. An optional LLM
// refinement is a later follow-up.
const DISFLUENCY_WEIGHT = 2.0;
const LOWCONF_WEIGHT = 0.6;

// English + Korean single-token fillers. Matched as whole, punctuation-stripped,
// lower-cased words. Kept conservative to avoid false positives on common words.
const FILLER_WORDS = new Set([
  "um",
  "uh",
  "umm",
  "uhh",
  "erm",
  "er",
  "ah",
  "hmm",
  "mhm",
  "음",
  "어",
  "엄",
  "저기",
]);

// Multi-word filler / hedge phrases (lower-cased substring match on mic text).
const FILLER_PHRASES = ["you know", "sort of", "kind of", "그러니까", "뭐랄까"];

// Repair phrases (a spoken self-correction lead-in).
const REPAIR_PHRASES = ["i mean"];

// Restart markers: an em-dash (—) or a double hyphen (--) used mid-utterance to
// abandon and restart a phrase ("take out—take our …").
const RESTART_MARKER = /—|--/g;

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Lower-case, split on whitespace, strip surrounding punctuation; drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/**
 * Compute talk-time ratio + Smooth Score from finalized records. Pure and
 * deterministic — the same input always yields the same output. Records of
 * either channel contribute to talk-time; only mic records drive the Smooth
 * Score (it measures the user's own delivery).
 */
export function computeMeetingMetrics(records: readonly FinalizedRecord[]): MeetingMetrics {
  let micMs = 0;
  let systemMs = 0;
  let micWordCount = 0;
  let fillerCount = 0;
  let repairCount = 0;
  let micUtterances = 0;
  let micLowConfidence = 0;

  for (const record of records) {
    // Negative/NaN durations would corrupt the ratio; treat them as zero.
    const duration = record.durationMs > 0 ? record.durationMs : 0;
    if (record.channel === "mic") {
      micMs += duration;
      micUtterances += 1;
      if (record.lowConfidence) micLowConfidence += 1;

      const lower = record.text.toLowerCase();
      const tokens = tokenize(record.text);
      micWordCount += tokens.length;
      for (const token of tokens) if (FILLER_WORDS.has(token)) fillerCount += 1;
      for (const phrase of FILLER_PHRASES) fillerCount += countOccurrences(lower, phrase);
      for (const phrase of REPAIR_PHRASES) repairCount += countOccurrences(lower, phrase);
      repairCount += (record.text.match(RESTART_MARKER) ?? []).length;
      // Immediate word repetition ("I I would", "take take") — a restart not
      // glued by an em-dash. Alphabetic tokens only, so a repeated filler is
      // already counted above, not double-counted as a content repair.
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === tokens[i - 1] && !FILLER_WORDS.has(tokens[i])) repairCount += 1;
      }
    } else {
      systemMs += duration;
    }
  }

  const totalMs = micMs + systemMs;
  const micShare = totalMs > 0 ? micMs / totalMs : 0;
  const lowConfidenceRate = micUtterances > 0 ? micLowConfidence / micUtterances : 0;
  const disfluencyDensity =
    micWordCount > 0 ? clamp01((fillerCount + repairCount) / micWordCount) : 0;

  const penalty = DISFLUENCY_WEIGHT * disfluencyDensity + LOWCONF_WEIGHT * lowConfidenceRate;
  const smoothScore = Math.round(100 * clamp01(1 - penalty));

  return {
    talkTime: { micMs, systemMs, totalMs, micShare },
    smoothScore,
    signals: { micWordCount, fillerCount, repairCount, lowConfidenceRate, disfluencyDensity },
  };
}
