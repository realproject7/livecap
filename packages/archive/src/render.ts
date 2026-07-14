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

/** Board items are joined with " · " and split back on it by parse.ts, so a
 *  single item that itself contains " · " (natural writing; "·" is also a common
 *  Korean bullet) would round-trip as TWO items. Neutralize an item-internal
 *  " · " by swapping its U+00B7 middot for a visually-similar U+2027 (‧) so it no
 *  longer matches the U+00B7 separator (#178). Only the exact " <U+00B7> "
 *  sequence is touched — a bare "·" is left alone. The parser never unescapes,
 *  so the item reads back with the look-alike (a near-invisible change) instead
 *  of being fragmented. */
function escapeBoardItem(item: string): string {
  return item.split(" · ").join(" ‧ ");
}

function renderBoard(board: BoardData): string {
  const join = (items: string[]): string => items.map(escapeBoardItem).join(" · ");
  let out = "";
  if (board.decisions.length > 0) out += `**Decisions** — ${join(board.decisions)}\n`;
  if (board.actionItems.length > 0) out += `**Action items** — ${join(board.actionItems)}\n`;
  if (board.openQuestions.length > 0) out += `**Open questions** — ${join(board.openQuestions)}\n`;
  return out;
}

// The line-start markdown tokens the parser keys on (parse.ts): `**Me**/**Them**`
// entry headers, `> ` translation lines, `## ` sections, `- ` summary bullets,
// and `**Label** —` board lines all begin with one of `# > - *`.
const LEADING_STRUCTURAL = /^(?:#|>|-|\*)/;

/**
 * Neutralize adversarial free text before it is written into the line-oriented
 * transcript (#148, N-2). `source` (whatever a participant speaks) and `target`
 * (LLM output, susceptible to spoken prompt-injection) are attacker-influenceable;
 * written verbatim, a value carrying a newline — or, defensively, a leading
 * structural token — could forge a fake `**Me**` utterance, a `> ` line, or a
 * board/section line in the saved, searchable record. Collapse newlines to
 * spaces (the value can then never begin a new line) and space-prefix a leading
 * structural token. The parser captures source/target to end-of-line and never
 * unescapes, so existing files parse exactly as before and the writer's output
 * still round-trips. Idempotent, and identity on ordinary text (so every
 * newline-free, non-structural caption renders byte-for-byte as today).
 */
export function sanitizeInline(text: string): string {
  const collapsed = text.replace(/[\r\n]+/g, " ");
  return LEADING_STRUCTURAL.test(collapsed) ? ` ${collapsed}` : collapsed;
}

/**
 * Neutralize a field whose newlines are MEANINGFUL and must survive round-trip
 * (#113 coaching `better`/`explanation` render multi-line, #148). Collapsing
 * would corrupt those rewrites, so instead space-prefix each line that begins
 * with a structural token: a continuation line like `## Transcript` then no
 * longer matches the section header grammar, so it cannot re-open a real section
 * bucket in the parser (which reuses a `## Section` by name) and smuggle forged
 * entries/board lines into it. A space-prefixed line parses back as an ordinary
 * continuation line, so the multi-line field still round-trips. Identity on text
 * whose lines don't start with `# > - *` (existing coaching output unchanged).
 */
export function sanitizeBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (LEADING_STRUCTURAL.test(line) ? ` ${line}` : line))
    .join("\n");
}

/** Render one entry's two lines (header line + `>` translation), trailing \n. */
export function renderEntryBody(e: CaptionEntry): string {
  const pin = e.pinned ? "📌 " : "";
  const speaker = e.speaker === "me" ? "Me" : "Them";
  const confidence = e.lowConfidence ? " (?)" : "";
  return `${pin}**${speaker}** (${e.timestamp}) — ${sanitizeInline(e.source)}${confidence}\n> ${sanitizeInline(e.target)}\n`;
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
 *  default. `better` may span multiple lines. Every field here is adversarial
 *  LLM output and is sanitized (#148, N-2): the multi-line `better`/`explanation`
 *  per-line (newlines preserved), the single-line `changes` edits inline. */
function renderCoachingEntry(e: CaptionEntry, occurrence: number, coaching: NonNullable<CaptionEntry["coaching"]>): string {
  // The heading echoes the (adversarial) source as an advisory redundancy check;
  // sanitize it like the transcript so it cannot forge a coaching heading/label
  // line. The echo is not parsed back into data, so this can't affect round-trip.
  let out = `### (${e.timestamp} · ${occurrence}) — ${sanitizeInline(e.source)}\n`;
  // `better`/`explanation` are multi-line LLM output: a continuation line like
  // `## Transcript` would otherwise re-open the real section bucket in the parser
  // and smuggle forged entries/board lines into it (#148). sanitizeBlock keeps
  // the newlines but defuses each structural line-start.
  out += `**Better:** ${sanitizeBlock(coaching.better)}\n`;
  if (coaching.changes.length > 0) {
    // Each edit is single-line; sanitizeInline collapses any injected newline so
    // a `from`/`to` cannot spill onto a new structural line.
    const list = coaching.changes
      .map((c) => `${sanitizeInline(c.from)}${COACHING_ARROW}${sanitizeInline(c.to)}`)
      .join(COACHING_CHANGE_SEP);
    out += `**Changes:** ${list}\n`;
  }
  if (coaching.explanation !== "") out += `**Explanation:** ${sanitizeBlock(coaching.explanation)}\n`;
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
