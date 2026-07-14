// Dashboard data layer (#98): aggregate parsed sessions into the stats the
// dashboard (#90) renders. Headless + pure — no fs, no engine, no native deps,
// no logging (SECURITY.md / EPIC #1: caption text never reaches a sink here; the
// aggregates carry only counts, durations, ratios, languages, and titles).
//
// NaN-free by construction (cf. #88): every numeric field guards non-finite
// inputs, and averages over an empty set return `null` rather than `0/0 = NaN`.
//
// Note on "tokens/cost if recorded": the saved Markdown format (render.ts) only
// persists cumulative cost (the meta line `($X.XX)`), not token counts — so the
// dashboard exposes cost only; per-token figures are not recoverable from a
// saved session and are intentionally absent.

import type { ParsedSession } from "./parse";

/** One row of the per-session index. */
export interface SessionIndexEntry {
  title: string;
  /** Header date, e.g. "2026-06-11". */
  date: string;
  /** Header start clock, e.g. "10:45". */
  startClock: string;
  durationMin: number;
  sourceLang: string;
  targetLang: string;
  costUsd: number;
  /** Mic talk-ratio in [0,1], or null when the session has no metrics. */
  talkRatioMic: number | null;
  /** Smooth Score in [0,100], or null when the session has no metrics. */
  smoothScore: number | null;
  /** True for the still-in-progress working file ("(recording)"). */
  isRecording: boolean;
}

/** A point on a time-ordered metric trend. */
export interface TrendPoint {
  date: string;
  startClock: string;
  value: number;
}

export interface DashboardStats {
  /** All parsed sessions (including any in-progress recording). */
  totalSessions: number;
  /** Count excluding the in-progress working file(s). */
  completedSessions: number;
  totalDurationMin: number;
  totalCostUsd: number;
  /** Mean mic talk-ratio over sessions WITH metrics; null when none (no NaN). */
  averageTalkRatioMic: number | null;
  /** Mean Smooth Score over sessions WITH metrics; null when none. */
  averageSmoothScore: number | null;
  /** Chronological mic talk-ratio points (only sessions that recorded metrics). */
  talkRatioTrend: TrendPoint[];
  /** Chronological Smooth Score points (only sessions that recorded metrics). */
  smoothScoreTrend: TrendPoint[];
  /** Per-session index, chronological. */
  index: SessionIndexEntry[];
}

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

/** Round to cents — costs are cent-precision, so this avoids float-sum artifacts. */
function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null; // empty set → null, never 0/0 = NaN
  let sum = 0;
  for (const v of values) sum += finite(v);
  return sum / values.length;
}

/**
 * Build one per-session index row from a parsed session. Pure and derived solely
 * from `session`, so a row always carries ITS OWN session's numbers — callers can
 * pair an entry with a session by identity (e.g. keyed by file name) rather than
 * by array position (#170). NaN-guarded like the aggregate.
 */
export function toSessionIndexEntry(session: ParsedSession): SessionIndexEntry {
  const { meta, metrics, isRecording } = session;
  return {
    title: meta.title,
    date: meta.headerDate,
    startClock: meta.startClock,
    durationMin: finite(meta.durationMin),
    sourceLang: meta.sourceLang,
    targetLang: meta.targetLang,
    costUsd: roundCents(finite(meta.costUsd)),
    talkRatioMic: metrics ? finite(metrics.talkRatioMic) : null,
    smoothScore: metrics ? finite(metrics.smoothScore) : null,
    isRecording,
  };
}

/** Chronological order: by header date, then start clock, stable for ties. */
function chronological(a: ParsedSession, b: ParsedSession): number {
  if (a.meta.headerDate !== b.meta.headerDate) {
    return a.meta.headerDate < b.meta.headerDate ? -1 : 1;
  }
  if (a.meta.startClock !== b.meta.startClock) {
    return a.meta.startClock < b.meta.startClock ? -1 : 1;
  }
  return 0;
}

/**
 * Aggregate parsed sessions into dashboard stats. Pure and deterministic; the
 * input is never mutated (it is sorted on a copy). Safe on an empty array and on
 * sessions with missing/partial data — all numeric outputs stay finite, and
 * metric averages are `null` (not `NaN`) when no session recorded metrics.
 */
export function aggregateSessions(sessions: readonly ParsedSession[]): DashboardStats {
  const ordered = [...sessions].sort(chronological);

  let totalDurationMin = 0;
  let totalCostUsd = 0;
  let completedSessions = 0;
  const talkRatios: number[] = [];
  const smoothScores: number[] = [];
  const talkRatioTrend: TrendPoint[] = [];
  const smoothScoreTrend: TrendPoint[] = [];
  const index: SessionIndexEntry[] = [];

  for (const session of ordered) {
    const { meta, metrics, isRecording } = session;
    totalDurationMin += finite(meta.durationMin);
    totalCostUsd += finite(meta.costUsd);
    if (!isRecording) completedSessions += 1;

    const talkRatioMic = metrics ? finite(metrics.talkRatioMic) : null;
    const smoothScore = metrics ? finite(metrics.smoothScore) : null;
    if (talkRatioMic !== null) {
      talkRatios.push(talkRatioMic);
      talkRatioTrend.push({ date: meta.headerDate, startClock: meta.startClock, value: talkRatioMic });
    }
    if (smoothScore !== null) {
      smoothScores.push(smoothScore);
      smoothScoreTrend.push({ date: meta.headerDate, startClock: meta.startClock, value: smoothScore });
    }

    index.push(toSessionIndexEntry(session));
  }

  return {
    totalSessions: ordered.length,
    completedSessions,
    totalDurationMin,
    totalCostUsd: roundCents(totalCostUsd),
    averageTalkRatioMic: mean(talkRatios),
    averageSmoothScore: mean(smoothScores),
    talkRatioTrend,
    smoothScoreTrend,
    index,
  };
}
