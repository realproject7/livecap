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
  /** Word units across mic utterances — whitespace tokens for space-delimited
   *  scripts, CJK characters for non-space-delimited content (#86). */
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
//
// LANGUAGE (#86): `micWordCount` (the density denominator) is script-aware so a
// fluent sentence in a non-space-delimited language (Japanese, Chinese) is not
// scored as one giant "word" with its density spiking toward 1. EN/KO and any
// space-delimited script keep their exact whitespace token count — unchanged.
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

// Multi-word filler / hedge phrases, matched as consecutive whitespace tokens
// (word-boundary-aware — see `countPhrase`).
const FILLER_PHRASES = ["you know", "sort of", "kind of", "그러니까", "뭐랄까"];

// Repair phrases (a spoken self-correction lead-in).
const REPAIR_PHRASES = ["i mean"];

// Restart markers: an em-dash (—) or a double hyphen (--) used mid-utterance to
// abandon and restart a phrase ("take out—take our …"). Counted only for
// space-delimited scripts — in CJK the em-dash is ordinary punctuation, not a
// restart (#86), so it is skipped for records containing CJK characters.
const RESTART_MARKER = /—|--/g;

// Unicode ranges for scripts written WITHOUT inter-word spaces: Hiragana +
// Katakana (U+3040-U+30FF), CJK Ext-A (U+3400-U+4DBF), CJK Unified
// (U+4E00-U+9FFF), CJK Compatibility Ideographs (U+F900-U+FAFF), and halfwidth
// Katakana (U+FF66-U+FF9F). Hangul (U+AC00-U+D7A3) is deliberately EXCLUDED —
// Korean delimits words (eojeol) with spaces, so its whitespace tokenization is
// correct and stays on the unchanged path.
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u;
const CJK_CHAR_GLOBAL = new RegExp(CJK_CHAR.source, "gu");

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

/** A token that is a pure CJK run (no Latin letter, digit, or Hangul) — the kind
 *  whitespace tokenization wrongly collapses into a single "word". Token is
 *  already lower-cased by {@link tokenize}. */
function isCjkOnly(token: string): boolean {
  return CJK_CHAR.test(token) && !/[a-z0-9\uac00-\ud7a3]/u.test(token);
}

/**
 * Word-unit count for the disfluency-density denominator. Space-delimited scripts
 * (English, Korean, …) keep their EXACT whitespace token count — unchanged. For
 * non-space-delimited CJK content — where a whole fluent sentence collapses to a
 * single whitespace token and would spike density toward 1 — each CJK character
 * counts as one unit (a deliberately lenient over-count: it can only LOWER
 * density, never spuriously collapse a fluent score). Mixed text sums the
 * non-CJK whitespace words and the CJK characters.
 *
 * (Intl.Segmenter word granularity was considered for exact CJK words, but its
 * counts vary with the runtime's bundled ICU and its types need a tsconfig lib
 * change; codepoint counting is deterministic, dependency-free, and leaves the
 * EN/KO path byte-identical.)
 */
function wordUnits(tokens: string[], cjkChars: number): number {
  if (cjkChars === 0) return tokens.length; // EN/KO and any space-delimited script
  return tokens.filter((t) => !isCjkOnly(t)).length + cjkChars;
}

/** Count non-overlapping runs of `phrase` (a token sequence) inside `tokens`.
 *  Word-boundary-aware by construction — tokens are whitespace-delimited,
 *  punctuation-stripped words — so "you know" never matches inside "you know-how"
 *  the way a raw substring search would (#86 secondary). */
function countPhrase(tokens: string[], phrase: string[]): number {
  if (phrase.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let hit = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      count += 1;
      i += phrase.length - 1;
    }
  }
  return count;
}

// Phrases pre-tokenized once, so matching is consecutive-token comparison.
const FILLER_PHRASE_TOKENS = FILLER_PHRASES.map((p) => tokenize(p));
const REPAIR_PHRASE_TOKENS = REPAIR_PHRASES.map((p) => tokenize(p));

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
    // Only a FINITE positive duration counts; negative, NaN, AND non-finite
    // (Infinity) durations are treated as zero. Without the finiteness gate an
    // Infinity slips through (`Infinity > 0`), making micMs/totalMs Infinity and
    // micShare `Infinity/Infinity = NaN` — the exact corruption this guard exists
    // to prevent and a violation of the [0,1] micShare contract (#88).
    const duration =
      Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : 0;
    if (record.channel === "mic") {
      micMs += duration;
      micUtterances += 1;
      if (record.lowConfidence) micLowConfidence += 1;

      const tokens = tokenize(record.text);
      const cjkChars = (record.text.match(CJK_CHAR_GLOBAL) ?? []).length;
      micWordCount += wordUnits(tokens, cjkChars);
      for (const token of tokens) if (FILLER_WORDS.has(token)) fillerCount += 1;
      for (const phrase of FILLER_PHRASE_TOKENS) fillerCount += countPhrase(tokens, phrase);
      for (const phrase of REPAIR_PHRASE_TOKENS) repairCount += countPhrase(tokens, phrase);
      // Em-dash restart is a disfluency only in space-delimited scripts; in CJK
      // the em-dash (—) is ordinary punctuation, so skip it there (#86).
      if (cjkChars === 0) repairCount += (record.text.match(RESTART_MARKER) ?? []).length;
      // Immediate word repetition ("I I would", "take take") — a restart not
      // glued by an em-dash. Alphabetic tokens only, so a repeated filler is
      // already counted above, not double-counted as a content repair.
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token !== undefined && token === tokens[i - 1] && !FILLER_WORDS.has(token)) {
          repairCount += 1;
        }
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
