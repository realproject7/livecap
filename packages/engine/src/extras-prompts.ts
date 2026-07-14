// Prompts + parsing for the LLM-extras pipeline (issue #9, PROPOSAL §8.4/§8.5).
// Pure functions — no engine, no I/O — so they unit-test directly.

/** Structured meeting board (PROPOSAL §8.4). */
export interface MeetingBoard {
  decisions: string[];
  /** "owner → task" lines, as emitted. */
  actionItems: string[];
  openQuestions: string[];
}

export interface SummaryBoardParse {
  summary: string[];
  board: MeetingBoard;
}

/** Reply-chip intents (PROPOSAL §8.5). */
export type ReplyIntent = "agree" | "push-back" | "ask" | "suggest";

const INTENT_INSTRUCTION: Record<ReplyIntent, string> = {
  agree: "agree with and build on the current point",
  "push-back": "politely push back on the current point",
  ask: "ask a clarifying question about the current point",
  suggest: "offer a concrete suggestion",
};

export const DEFAULT_CONTEXT_CAPTIONS = 10;

/** Build the summary+board request (one call feeds both — §8.4). */
export function buildSummaryBoardPrompt(
  transcript: string,
  outputLanguage: string,
): { system: string; user: string } {
  const system =
    `You are a meeting assistant. Write a concise live summary and a structured ` +
    `board in ${outputLanguage}. Output ONLY the format below — no preamble, no commentary.`;
  const user = [
    "Use EXACTLY these section headers, each on its own line:",
    "SUMMARY",
    "- <one short bullet per key point>",
    "DECISIONS",
    "- <decision>",
    "ACTION ITEMS",
    "- <owner> → <task>",
    "OPEN QUESTIONS",
    "- <question>",
    "Keep a header even if it has no bullets. Do not invent content.",
    `Write the bullet content in ${outputLanguage}, but keep the section headers ` +
      "in English exactly as above (SUMMARY / DECISIONS / ACTION ITEMS / OPEN QUESTIONS).",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
  return { system, user };
}

/** Render a board section back into the bullet form the prompt expects, so the
 *  model sees its own prior output in the same shape it must re-emit. */
function renderSection(header: string, items: string[]): string[] {
  return [header, ...(items.length > 0 ? items.map((i) => `- ${i}`) : ["- (none)"])];
}

/**
 * Build an INCREMENTAL summary+board request (#55). Instead of re-sending the
 * whole accumulated transcript every cadence tick (linear input → quadratic
 * session cost, the #13 blow-up), this feeds the PREVIOUS summary/board plus
 * only the NEW transcript since the last update, and asks the model to fold the
 * delta in. Output format is identical to the full prompt, so `parseSummaryBoard`
 * handles both. Keeping the summary concise (instructed below) keeps the
 * fed-back previous summary bounded, so per-call input stays roughly constant.
 */
export function buildIncrementalSummaryBoardPrompt(
  previous: SummaryBoardParse,
  deltaTranscript: string,
  outputLanguage: string,
): { system: string; user: string } {
  const system =
    `You are a meeting assistant maintaining a running summary and board in ` +
    `${outputLanguage}. You are given the CURRENT summary/board and only the NEW ` +
    `transcript since it was written. Merge the new content in — update or extend, ` +
    `do not re-derive from scratch and do not drop still-relevant prior points. ` +
    `Output ONLY the format below — no preamble, no commentary.`;
  const user = [
    "Current summary and board:",
    ...renderSection("SUMMARY", previous.summary),
    ...renderSection("DECISIONS", previous.board.decisions),
    ...renderSection("ACTION ITEMS", previous.board.actionItems),
    ...renderSection("OPEN QUESTIONS", previous.board.openQuestions),
    "",
    "New transcript since the last update:",
    deltaTranscript,
    "",
    "Output the COMPLETE updated summary and board (not just the changes), using",
    "EXACTLY these section headers, each on its own line:",
    "SUMMARY",
    "- <one short bullet per key point>",
    "DECISIONS",
    "- <decision>",
    "ACTION ITEMS",
    "- <owner> → <task>",
    "OPEN QUESTIONS",
    "- <question>",
    "Keep a header even if it has no bullets. Keep the summary concise — merge",
    "related points rather than letting it grow without bound. Do not invent content.",
    `Write the bullet content in ${outputLanguage}, but keep the section headers ` +
      "in English exactly as above (SUMMARY / DECISIONS / ACTION ITEMS / OPEN QUESTIONS).",
  ].join("\n");
  return { system, user };
}

/** Build the reply-suggestion request (intent + last ~N captions — §8.5). */
export function buildReplyPrompt(
  intent: ReplyIntent,
  recentCaptions: string[],
  meetingLanguage: string,
  contextCaptions = DEFAULT_CONTEXT_CAPTIONS,
): { system: string; user: string } {
  const window = recentCaptions.slice(-contextCaptions);
  const system =
    `You help the user reply in a live meeting. Output ONLY one short reply the ` +
    `user could say, in ${meetingLanguage}. No quotes, no preamble, no explanation.`;
  const user = [
    `Goal: ${INTENT_INSTRUCTION[intent]}.`,
    "Recent conversation (most recent last):",
    ...window.map((c) => `- ${c}`),
    "",
    "Write one reply now.",
  ].join("\n");
  return { system, user };
}

/** Result of `analyzeAndRespond` (#77): a short read of a targeted caption block
 *  plus a suggested reply. `analysis` is in the user's target language, `reply`
 *  is in the meeting language. */
export interface AnalyzeRespondResult {
  analysis: string;
  reply: string;
}

/**
 * Build the targeted analyze-and-respond request (#77). Unlike `buildReplyPrompt`
 * (chip intent over the last N captions), this focuses the model on ONE specific
 * caption block the user clicked — usually a question aimed at them — and asks for
 * two sections: a short strategy read (전략, in `analysisLanguage`) and a suggested
 * reply (답변, in `meetingLanguage`). The recent captions ride along only as
 * surrounding context. Section headers stay in English so {@link parseAnalyzeRespond}
 * keys off them regardless of the body languages.
 */
export function buildAnalyzeRespondPrompt(
  targetText: string,
  recentCaptions: string[],
  meetingLanguage: string,
  analysisLanguage: string,
  contextCaptions = DEFAULT_CONTEXT_CAPTIONS,
): { system: string; user: string } {
  const window = recentCaptions.slice(-contextCaptions);
  const system =
    `You help the user handle a specific moment in a live meeting. The user clicked ` +
    `one line — usually a question aimed at them — and wants to know how to handle it ` +
    `and what to say. Output ONLY the two sections below, no preamble, no commentary.`;
  const user = [
    "Use EXACTLY these section headers, each on its own line:",
    "ANALYSIS",
    `<a brief read of what the line is asking and how to handle it, in ${analysisLanguage}>`,
    "REPLY",
    `<one natural reply the user could say, in ${meetingLanguage}>`,
    `Write the ANALYSIS body in ${analysisLanguage} and the REPLY body in ${meetingLanguage}, ` +
      "but keep the two section headers in English exactly as above (ANALYSIS / REPLY).",
    "",
    ...(window.length > 0
      ? ["Recent conversation for context (most recent last):", ...window.map((c) => `- ${c}`), ""]
      : []),
    "The specific line to analyze and reply to:",
    targetText,
  ].join("\n");
  return { system, user };
}

const ANALYZE_SECTION_BY_HEADER: Record<string, "analysis" | "reply"> = {
  ANALYSIS: "analysis",
  STRATEGY: "analysis",
  전략: "analysis",
  분석: "analysis",
  REPLY: "reply",
  RESPONSE: "reply",
  답변: "reply",
  답장: "reply",
};

/**
 * Parse an analyze-and-respond response into `{ analysis, reply }`. Robust to the
 * model omitting a section (graceful fallback, never throws on shape):
 * - both headers present → each section's body is the lines beneath it;
 * - only one header present → the other side is empty;
 * - NO recognized header → the whole output is treated as the `reply` (the
 *   user-facing, actionable half), leaving `analysis` empty.
 */
export function parseAnalyzeRespond(text: string): AnalyzeRespondResult {
  const buckets: { analysis: string[]; reply: string[] } = { analysis: [], reply: [] };
  let current: "analysis" | "reply" | null = null;
  let sawHeader = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const key = ANALYZE_SECTION_BY_HEADER[headerNormalize(line)] ?? null;
    if (key) {
      current = key;
      sawHeader = true;
      continue;
    }
    if (current === null) continue; // preamble before any header
    buckets[current].push(line);
  }

  if (!sawHeader) {
    return { analysis: "", reply: text.trim() };
  }
  return { analysis: buckets.analysis.join("\n").trim(), reply: buckets.reply.join("\n").trim() };
}

/** Build the quick-translate request (free text → meeting language — §8.5). */
export function buildQuickTranslatePrompt(
  text: string,
  meetingLanguage: string,
): { system: string; user: string } {
  return {
    system: `Translate the user's text into ${meetingLanguage}. Output ONLY the translation, nothing else.`,
    user: text,
  };
}

const SECTION_BY_HEADER: Record<string, keyof SectionBuckets> = {
  SUMMARY: "summary",
  "MEETING SO FAR": "summary",
  DECISIONS: "decisions",
  DECISION: "decisions",
  "ACTION ITEMS": "actionItems",
  "ACTION ITEM": "actionItems",
  ACTIONS: "actionItems",
  "OPEN QUESTIONS": "openQuestions",
  "OPEN QUESTION": "openQuestions",
  QUESTIONS: "openQuestions",
  // Korean aliases (#40): the prompt asks the model to keep English headers, but
  // a localizing model writing the board in KO is a documented launch case — so
  // the common Korean header phrasings parse too.
  요약: "summary",
  "회의 요약": "summary",
  "결정 사항": "decisions",
  결정사항: "decisions",
  결정: "decisions",
  "실행 항목": "actionItems",
  실행항목: "actionItems",
  "액션 아이템": "actionItems",
  "할 일": "actionItems",
  할일: "actionItems",
  "미해결 질문": "openQuestions",
  "열린 질문": "openQuestions",
  질문: "openQuestions",
};

interface SectionBuckets {
  summary: string[];
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
}

/** Normalize a candidate header line for lookup: strip leading markdown markers
 *  (#, *) and trailing punctuation, then upper-case. A leading bullet
 *  ("- Decisions …") is NOT stripped here, so it never reads as a header. */
function headerNormalize(line: string): string {
  return line
    .replace(/^[#*\s]+/, "")
    .replace(/[:：#*\s]+$/, "")
    .toUpperCase();
}

function headerKey(line: string): keyof SectionBuckets | null {
  return SECTION_BY_HEADER[headerNormalize(line)] ?? null;
}

function stripBulletMarker(line: string): string {
  // Strip ONE leading marker: a bullet glyph or an ordered-list marker
  // (`1.`, `2)`). Plain leading digits are content (e.g. "2026 budget") and
  // must be preserved.
  return line.replace(/^(?:[-•□?▪*·]|\d+[.)])\s*/u, "").trim();
}

/**
 * Parse a summary/board model response into structure. Robust to malformed
 * output: lines before any recognized header are ignored, unknown headers are
 * ignored, and bullet markers (-, •, □, ?, numbers) are stripped.
 */
export function parseSummaryBoard(text: string): SummaryBoardParse {
  const buckets: SectionBuckets = { summary: [], decisions: [], actionItems: [], openQuestions: [] };
  let current: keyof SectionBuckets | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const key = headerKey(line);
    if (key) {
      current = key;
      continue;
    }
    if (current === null) continue; // preamble before any header
    const item = stripBulletMarker(line);
    if (item !== "") buckets[current].push(item);
  }

  return {
    summary: buckets.summary,
    board: {
      decisions: buckets.decisions,
      actionItems: buckets.actionItems,
      openQuestions: buckets.openQuestions,
    },
  };
}

// --- Speech coaching (#79) --------------------------------------------------

/** One key edit the rewrite made, so the UI can highlight what changed. */
export interface CoachChange {
  from: string;
  to: string;
}

/** Result of coaching one utterance (#79): a native rewrite + the key edits +
 *  why. `better` is in the meeting language; `explanation` is in the user's
 *  target language. `changes` may be empty even for a real rewrite. */
export interface CoachResult {
  better: string;
  changes: CoachChange[];
  explanation: string;
}

/**
 * Build the speech-coaching request (#79). Given one of the user's OWN
 * (disfluent) utterances, ask for three sections: a natural native rewrite
 * (`better`, in `meetingLanguage`), the key edits as `original => replacement`
 * lines (`changes`, so the UI can highlight diffs), and why (`explanation`, in
 * `explanationLanguage`). Headers stay in English so {@link parseCoachResult}
 * keys off them regardless of the body languages.
 */
export function buildCoachPrompt(
  text: string,
  meetingLanguage: string,
  explanationLanguage: string,
): { system: string; user: string } {
  const system =
    `You are a speech coach. The user gives ONE thing they said in a meeting; ` +
    `produce a cleaner, natural-sounding native version of it. Do not invent new ` +
    `claims — only improve phrasing and remove disfluencies. Output ONLY the three ` +
    `sections below, no preamble, no commentary.`;
  const user = [
    "Use EXACTLY these section headers, each on its own line:",
    "BETTER",
    `<the improved native rewrite, in ${meetingLanguage}>`,
    "CHANGES",
    "<original phrase> => <replacement> (one key edit per line; omit if none)",
    "EXPLANATION",
    `<a short note on why it is better, in ${explanationLanguage}>`,
    `Write the BETTER rewrite in ${meetingLanguage} and the EXPLANATION in ` +
      `${explanationLanguage}, but keep the three section headers in English exactly ` +
      "as above (BETTER / CHANGES / EXPLANATION).",
    "",
    "The user said:",
    text,
  ].join("\n");
  return { system, user };
}

const COACH_SECTION_BY_HEADER: Record<string, "better" | "changes" | "explanation"> = {
  BETTER: "better",
  REWRITE: "better",
  CHANGES: "changes",
  EDITS: "changes",
  EXPLANATION: "explanation",
  WHY: "explanation",
  // Korean aliases — the benchmarked card labels the explanation 해설.
  해설: "explanation",
  설명: "explanation",
  수정: "changes",
  개선: "better",
};

const CHANGE_SEPARATOR = /\s*(?:=>|->|→|⇒)\s*/;

/**
 * Parse a coaching response into `{ better, changes, explanation }`. Robust to
 * the model omitting a section (never throws on shape):
 * - sections are keyed off the English headers (with a few aliases);
 * - CHANGES lines are split on `=>` / `->` / `→`; a line without a separator or
 *   with an empty side is skipped rather than half-captured;
 * - NO recognized header → the whole output is treated as `better` (the rewrite
 *   is the load-bearing field), leaving `changes`/`explanation` empty.
 */
export function parseCoachResult(text: string): CoachResult {
  const better: string[] = [];
  const explanation: string[] = [];
  const changes: CoachChange[] = [];
  let current: "better" | "changes" | "explanation" | null = null;
  let sawHeader = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const key = COACH_SECTION_BY_HEADER[headerNormalize(line)] ?? null;
    if (key) {
      current = key;
      sawHeader = true;
      continue;
    }
    if (current === null) continue; // preamble before any header
    if (current === "changes") {
      const stripped = line.replace(/^(?:[-•□▪*·]|\d+[.)])\s*/u, "").trim();
      const parts = stripped.split(CHANGE_SEPARATOR);
      if (parts.length >= 2) {
        const from = (parts[0] ?? "").trim();
        const to = parts.slice(1).join(" ").trim();
        if (from !== "" && to !== "") changes.push({ from, to });
      }
    } else if (current === "better") {
      better.push(line);
    } else {
      explanation.push(line);
    }
  }

  if (!sawHeader) {
    return { better: text.trim(), changes: [], explanation: "" };
  }
  return {
    better: better.join("\n").trim(),
    changes,
    explanation: explanation.join("\n").trim(),
  };
}

// --- Batched speech coaching (#112) -----------------------------------------

/** Hard indexed delimiter separating items in a batched coaching turn (#112).
 *  Tolerant on parse: 1–6 leading `#`, any case, e.g. `### ITEM 3` / `## item 3`. */
const COACH_ITEM_HEADER = /^#{1,6}\s*ITEM\s+(\d+)\b/i;

/**
 * Build ONE coaching request covering several utterances (#112), so a review of
 * many utterances costs a few grouped turns instead of one turn each. Each input
 * is numbered with a hard `### ITEM k` delimiter and the model is asked to echo
 * that marker before the SAME three BETTER / CHANGES / EXPLANATION sections used
 * by {@link buildCoachPrompt}. Markers and section headers stay in English so
 * {@link parseCoachBatch} can split and key off them regardless of body language.
 */
export function buildCoachBatchPrompt(
  texts: string[],
  meetingLanguage: string,
  explanationLanguage: string,
): { system: string; user: string } {
  const system =
    `You are a speech coach. The user gives SEVERAL things they said in a meeting, ` +
    `numbered as items. For EACH item, produce a cleaner, natural-sounding native ` +
    `version. Do not invent new claims — only improve phrasing and remove ` +
    `disfluencies. Output ONLY the per-item sections below, no preamble, no commentary.`;
  const instructions = [
    `Coach EACH of the ${texts.length} numbered utterances below. For every item, ` +
      `output its "### ITEM k" line (k = the item number, 1-based) followed by ` +
      `EXACTLY these three section headers, each on its own line:`,
    "BETTER",
    `<the improved native rewrite, in ${meetingLanguage}>`,
    "CHANGES",
    "<original phrase> => <replacement> (one key edit per line; omit if none)",
    "EXPLANATION",
    `<a short note on why it is better, in ${explanationLanguage}>`,
    `Write each BETTER rewrite in ${meetingLanguage} and each EXPLANATION in ` +
      `${explanationLanguage}, but keep the "### ITEM k" markers and the three section ` +
      "headers (BETTER / CHANGES / EXPLANATION) in English exactly as above. " +
      `Output all ${texts.length} items in order, nothing else.`,
    "",
  ];
  const items = texts.map((t, i) => `### ITEM ${i + 1}\n${t}`).join("\n\n");
  return { system, user: [...instructions, items].join("\n") };
}

/**
 * Split a batched coaching response into per-item results (#112), aligned to
 * item numbers `1..expectedCount`. Output is split on the `### ITEM k` markers
 * and each chunk is parsed with {@link parseCoachResult}. An item is `null` when
 * its marker is absent OR its chunk yields no usable rewrite (empty `better`) —
 * the caller re-runs those (and only those) through the single-item path, so a
 * miscounted or partially-garbled batch never loses an utterance. A duplicate
 * `### ITEM k` marker keeps the first occurrence.
 */
export function parseCoachBatch(text: string, expectedCount: number): (CoachResult | null)[] {
  const chunks = new Map<number, string>();
  let current: number | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null && !chunks.has(current)) chunks.set(current, buffer.join("\n"));
    buffer = [];
  };
  for (const raw of text.split("\n")) {
    const match = raw.trim().match(COACH_ITEM_HEADER);
    if (match) {
      flush();
      current = Number.parseInt(match[1] ?? "", 10);
      continue;
    }
    if (current !== null) buffer.push(raw);
  }
  flush();

  const results: (CoachResult | null)[] = [];
  for (let k = 1; k <= expectedCount; k += 1) {
    const chunk = chunks.get(k);
    if (chunk === undefined) {
      results.push(null);
      continue;
    }
    const parsed = parseCoachResult(chunk);
    results.push(parsed.better.trim() === "" ? null : parsed);
  }
  return results;
}
