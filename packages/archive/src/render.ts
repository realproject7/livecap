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

/** The complete document: front matter + all transcript entries. */
export function renderDocument(m: ArchiveModel): string {
  let doc = renderFrontMatter(m);
  m.entries.forEach((e, i) => {
    doc += (i === 0 ? "" : "\n") + renderEntryBody(e);
  });
  return doc;
}
