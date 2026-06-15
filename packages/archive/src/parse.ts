// Dashboard data layer (#98): parse a saved session Markdown file back into a
// structured model — the exact inverse of `render.ts` (renderDocument). The
// parser is derived from that renderer's format (PROPOSAL §8.9), NOT guessed,
// and round-trips the writer's output (see parse.test.ts driving the real
// SessionArchiveWriter).
//
// Headless + pure: no fs, no engine, no native deps. SECURITY.md / EPIC #1 — this
// module NEVER logs: caption source/target text flows only into the returned
// struct, never to a console or sink.
//
// Robustness: malformed or partial input never throws and never yields NaN —
// every field degrades to a sensible default ("" / 0 / [] / undefined), so the
// dashboard aggregations stay NaN-free (cf. #88).

import type { BoardData, CaptionEntry, MetricsData, Speaker } from "./types";

/** Header metadata recovered from the `> …` meta line + the H1 title. */
export interface ParsedSessionMeta {
  /** H1 title. The in-progress working file carries WORKING_TITLE "(recording)". */
  title: string;
  /** e.g. "2026-06-11". */
  headerDate: string;
  /** e.g. "10:45". */
  startClock: string;
  /** e.g. "11:32" (equals startClock while still recording). */
  endClock: string;
  /** Whole-meeting duration in minutes (0 while recording / when absent). */
  durationMin: number;
  /** Source language label, e.g. "EN". */
  sourceLang: string;
  /** Target language label, e.g. "KO". */
  targetLang: string;
  /** Engine label, e.g. "Claude CLI". */
  engineName: string;
  /** Cumulative engine cost in USD (0 when absent/unparseable). */
  costUsd: number;
  /** Channel-config note when present (#53), e.g. "system audio only". */
  channels?: string;
}

/** A saved session parsed back into structure — the inverse of `ArchiveModel`. */
export interface ParsedSession {
  meta: ParsedSessionMeta;
  summary: string[];
  board: BoardData;
  /** Present only when the session has a "## Metrics" section (post-finalize, #81). */
  metrics?: MetricsData;
  entries: CaptionEntry[];
  /** True when this is still the in-progress working file (title is the
   *  WORKING_TITLE "(recording)") — handy so the dashboard can exclude it. */
  isRecording: boolean;
}

/** Working title the writer uses until finalize (mirrors writer.ts WORKING_TITLE). */
const WORKING_TITLE = "(recording)";

// The exact separators the renderer emits (render.ts) — kept as named constants
// so the inversion can never silently drift from the format it mirrors.
const META_SEP = " · "; // U+00B7 between meta segments
const LANG_ARROW = " → "; // U+2192 between source and target language
const BOARD_ITEM_SEP = " · "; // board items joined by U+00B7
// (the start–end clock is split by the U+2013 EN-dash literal in SEG_WHEN below)

const EMPTY_META: ParsedSessionMeta = {
  title: "",
  headerDate: "",
  startClock: "",
  endClock: "",
  durationMin: 0,
  sourceLang: "",
  targetLang: "",
  engineName: "",
  costUsd: 0,
};

function toInt(s: string | undefined, fallback = 0): number {
  if (s === undefined) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(s: string | undefined, fallback = 0): number {
  if (s === undefined) return fallback;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

// `2026-06-11 10:45–11:32 (47 min)` → date / start / end / duration.
const SEG_WHEN = /^(\S+) (.+?)(?:–(.+?))? \((\d+) min\)$/;
// `engine: Claude CLI ($0.31)` → engine name / cost.
const SEG_ENGINE = /^engine: (.*?) \(\$(-?\d+(?:\.\d+)?)\)$/;

/**
 * Parse the `> …` meta line emitted by `renderMetaLine`. Segment-positional
 * (split on " · "), each segment parsed independently so a missing/garbled
 * segment degrades to its default rather than corrupting the rest.
 */
function parseMetaLine(line: string, title: string): ParsedSessionMeta {
  const meta: ParsedSessionMeta = { ...EMPTY_META, title };
  const segments = line.split(META_SEP);

  const whenMatch = segments[0]?.match(SEG_WHEN);
  if (whenMatch) {
    meta.headerDate = whenMatch[1] ?? "";
    meta.startClock = whenMatch[2] ?? "";
    // endClock is optional in the grammar; default it to startClock.
    meta.endClock = whenMatch[3] ?? whenMatch[2] ?? "";
    meta.durationMin = toInt(whenMatch[4]);
  }

  const langSeg = segments[1];
  if (langSeg !== undefined) {
    const at = langSeg.indexOf(LANG_ARROW);
    if (at !== -1) {
      meta.sourceLang = langSeg.slice(0, at).trim();
      meta.targetLang = langSeg.slice(at + LANG_ARROW.length).trim();
    }
  }

  const engineMatch = segments[2]?.match(SEG_ENGINE);
  if (engineMatch) {
    meta.engineName = engineMatch[1] ?? "";
    meta.costUsd = toFloat(engineMatch[2]);
  }

  // Any trailing segment(s) are the channel-config note (#53).
  if (segments.length > 3) {
    const channels = segments.slice(3).join(META_SEP).trim();
    if (channels !== "") meta.channels = channels;
  }

  return meta;
}

const H1 = /^# (.*)$/;
const QUOTE = /^> (.*)$/;
const SECTION = /^## (.+?)\s*$/;
const SUMMARY_BULLET = /^- (.*)$/;
const BOARD_LINE = /^\*\*(.+?)\*\* — (.*)$/;
const TALK_RATIO = /^\*\*Talk ratio \(me\)\*\* — (\d+)%$/;
const SMOOTH_SCORE = /^\*\*Smooth Score\*\* — (\d+)$/;
// `📌 **Me** (10:45) — source text (?)` — pin + speaker + timestamp + source(+conf).
const ENTRY_HEADER = /^(📌 )?\*\*(Me|Them)\*\* \(([^)]*)\) — (.*)$/;
const LOW_CONFIDENCE_SUFFIX = " (?)";

const BOARD_LABELS: Record<string, keyof BoardData> = {
  Decisions: "decisions",
  "Action items": "actionItems",
  "Open questions": "openQuestions",
};

/**
 * Parse a session Markdown document into a {@link ParsedSession}. Never throws:
 * an empty or malformed document yields empty/default fields. The inverse of
 * `renderDocument` for the canonical writer output.
 */
export function parseSession(markdown: string): ParsedSession {
  const lines = markdown.split(/\r?\n/);

  let title = "";
  let metaLine: string | null = null;
  // Bucket each section's raw body lines by its header name.
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  let sawSection = false;

  for (const raw of lines) {
    const sectionMatch = raw.match(SECTION);
    if (sectionMatch) {
      current = sectionMatch[1] ?? "";
      sawSection = true;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null) {
      sections.get(current)?.push(raw);
      continue;
    }
    // Pre-section preamble: the H1 title, then the `> …` meta line.
    if (title === "") {
      const h1 = raw.match(H1);
      if (h1) {
        title = h1[1] ?? "";
        continue;
      }
    }
    if (metaLine === null && !sawSection) {
      const quote = raw.match(QUOTE);
      if (quote) {
        metaLine = quote[1] ?? "";
        continue;
      }
    }
  }

  const meta = metaLine !== null ? parseMetaLine(metaLine, title) : { ...EMPTY_META, title };

  const summary: string[] = [];
  for (const line of sections.get("Summary") ?? []) {
    const m = line.match(SUMMARY_BULLET);
    if (m) summary.push(m[1] ?? "");
  }

  const board: BoardData = { decisions: [], actionItems: [], openQuestions: [] };
  for (const line of sections.get("Board") ?? []) {
    const m = line.match(BOARD_LINE);
    if (!m) continue;
    const key = BOARD_LABELS[m[1] ?? ""];
    if (key === undefined) continue;
    const items = (m[2] ?? "")
      .split(BOARD_ITEM_SEP)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    board[key] = items;
  }

  let metrics: MetricsData | undefined;
  const metricsLines = sections.get("Metrics");
  if (metricsLines !== undefined) {
    let talkRatioMic = 0;
    let smoothScore = 0;
    for (const line of metricsLines) {
      const t = line.match(TALK_RATIO);
      if (t) talkRatioMic = toInt(t[1]) / 100; // writer rounds to whole percent (lossy)
      const s = line.match(SMOOTH_SCORE);
      if (s) smoothScore = toInt(s[1]);
    }
    metrics = { talkRatioMic, smoothScore };
  }

  const entries = parseEntries(sections.get("Transcript") ?? []);

  return {
    meta,
    summary,
    board,
    metrics,
    entries,
    isRecording: title === WORKING_TITLE,
  };
}

/** Parse the Transcript body: a header line, then its `> translation` line. */
function parseEntries(lines: string[]): CaptionEntry[] {
  const entries: CaptionEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = (lines[i] ?? "").match(ENTRY_HEADER);
    if (!header) continue;
    const pinned = header[1] !== undefined;
    const speaker: Speaker = header[2] === "Me" ? "me" : "them";
    const timestamp = header[3] ?? "";
    let source = header[4] ?? "";
    let lowConfidence = false;
    if (source.endsWith(LOW_CONFIDENCE_SUFFIX)) {
      lowConfidence = true;
      source = source.slice(0, -LOW_CONFIDENCE_SUFFIX.length);
    }
    // The translation is the next line (`> target`); tolerate it being absent.
    const next = (lines[i + 1] ?? "").match(QUOTE);
    const target = next ? next[1] ?? "" : "";
    if (next) i += 1;

    const entry: CaptionEntry = { speaker, timestamp, source, target };
    if (pinned) entry.pinned = true;
    if (lowConfidence) entry.lowConfidence = true;
    entries.push(entry);
  }
  return entries;
}
