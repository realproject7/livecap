// Markdown rendering for the archive (PROPOSAL §8.9 is normative). The document
// is assembled so that appending one transcript entry to the file byte-for-byte
// equals re-rendering the whole document with that entry — which is what makes
// the append-only transcript and the periodic full rewrite consistent.

import type { BoardData, CaptionEntry, MetricsData } from "./types";

/** The complete state needed to render a document. */
export interface ArchiveModel {
  title: string;
  headerDate: string;
  startClock: string;
  endClock: string;
  durationMin: number;
  sourceLang: string;
  targetLang: string;
  engineName: string;
  /** Channel-config header note (#53), e.g. "system audio only". */
  channels?: string;
  costUsd: number;
  summary: string[];
  board: BoardData;
  /** Post-meeting metrics (#81). Present only after the session ends; while live
   *  it is undefined and the Metrics section is omitted. */
  metrics?: MetricsData;
  entries: CaptionEntry[];
}

function renderMetaLine(m: ArchiveModel): string {
  const channels = m.channels !== undefined && m.channels !== "" ? ` · ${m.channels}` : "";
  return (
    `${m.headerDate} ${m.startClock}–${m.endClock} (${m.durationMin} min) · ` +
    `${m.sourceLang} → ${m.targetLang} · engine: ${m.engineName} ($${m.costUsd.toFixed(2)})${channels}`
  );
}

function renderBoard(board: BoardData): string {
  let out = "";
  if (board.decisions.length > 0) out += `**Decisions** — ${board.decisions.join(" · ")}\n`;
  if (board.actionItems.length > 0) out += `**Action items** — ${board.actionItems.join(" · ")}\n`;
  if (board.openQuestions.length > 0) out += `**Open questions** — ${board.openQuestions.join(" · ")}\n`;
  return out;
}

/** Render one entry's two lines (header line + `>` translation), trailing \n. */
export function renderEntryBody(e: CaptionEntry): string {
  const pin = e.pinned ? "📌 " : "";
  const speaker = e.speaker === "me" ? "Me" : "Them";
  const confidence = e.lowConfidence ? " (?)" : "";
  return `${pin}**${speaker}** (${e.timestamp}) — ${e.source}${confidence}\n> ${e.target}\n`;
}

/**
 * The text to append for a new entry. Entries are separated by a blank line, so
 * every entry except the first is preceded by one. `isFirst` is true when the
 * transcript currently has no entries.
 */
export function renderEntryAppend(e: CaptionEntry, isFirst: boolean): string {
  return (isFirst ? "" : "\n") + renderEntryBody(e);
}

/** Render the post-meeting Metrics section (#81), or "" when no metrics. The
 *  talk ratio is shown as a whole-percent mic share; the Smooth Score as the
 *  raw 0–100 value. */
function renderMetrics(metrics: MetricsData): string {
  const talkPct = Math.round(metrics.talkRatioMic * 100);
  return (
    `\n## Metrics\n` +
    `**Talk ratio (me)** — ${talkPct}%\n` +
    `**Smooth Score** — ${metrics.smoothScore}\n`
  );
}

// Coaching section separators (#113), kept as named constants so parse.ts can
// invert them without drift. Changes render as `from => to`, multiple joined by
// ` · ` — the same middot the board uses.
export const COACHING_ARROW = " => ";
export const COACHING_CHANGE_SEP = " · ";

/** Render one coached "me" entry as a `### (timestamp · k)` block (#113). The
 *  heading echoes the source text as an advisory redundancy check; empty
 *  `changes`/`explanation` omit their line so absence round-trips to the
 *  default. `better` may span multiple lines and is rendered verbatim. */
function renderCoachingEntry(e: CaptionEntry, occurrence: number, coaching: NonNullable<CaptionEntry["coaching"]>): string {
  let out = `### (${e.timestamp} · ${occurrence}) — ${e.source}\n`;
  out += `**Better:** ${coaching.better}\n`;
  if (coaching.changes.length > 0) {
    const list = coaching.changes.map((c) => `${c.from}${COACHING_ARROW}${c.to}`).join(COACHING_CHANGE_SEP);
    out += `**Changes:** ${list}\n`;
  }
  if (coaching.explanation !== "") out += `**Explanation:** ${coaching.explanation}\n`;
  return out;
}

/**
 * Render the "## Coaching" section (#113), or "" when no entry carries coaching
 * (so a coaching-free document is byte-identical to before — the append-only
 * transcript invariant and every existing golden stay intact). Each coached
 * `me` entry is keyed by `(timestamp · k)`, where `k` is its 1-based occurrence
 * among `me` entries sharing that timestamp, disambiguating duplicate clocks.
 * Placed AFTER the transcript so `amendCoaching` only ever appends.
 */
export function renderCoaching(entries: CaptionEntry[]): string {
  const occurrence = new Map<string, number>();
  const blocks: string[] = [];
  for (const e of entries) {
    if (e.speaker !== "me") continue;
    const k = (occurrence.get(e.timestamp) ?? 0) + 1;
    occurrence.set(e.timestamp, k);
    if (e.coaching !== undefined) blocks.push(renderCoachingEntry(e, k, e.coaching));
  }
  if (blocks.length === 0) return "";
  return `\n## Coaching\n\n${blocks.join("\n")}`;
}

/** Everything above the transcript entries (rewritten on each brief update). */
export function renderFrontMatter(m: ArchiveModel): string {
  let doc = `# ${m.title}\n> ${renderMetaLine(m)}\n`;
  doc += `\n## Summary\n`;
  for (const line of m.summary) doc += `- ${line}\n`;
  doc += `\n## Board\n`;
  doc += renderBoard(m.board);
  if (m.metrics !== undefined) doc += renderMetrics(m.metrics);
  doc += `\n## Transcript\n`;
  return doc;
}

/** The complete document: front matter + all transcript entries + optional
 *  Coaching section (#113, appended after the transcript). */
export function renderDocument(m: ArchiveModel): string {
  let doc = renderFrontMatter(m);
  m.entries.forEach((e, i) => {
    doc += (i === 0 ? "" : "\n") + renderEntryBody(e);
  });
  doc += renderCoaching(m.entries);
  return doc;
}
