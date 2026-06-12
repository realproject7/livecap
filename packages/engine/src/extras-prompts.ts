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

const DEFAULT_CONTEXT_CAPTIONS = 10;

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

function headerKey(line: string): keyof SectionBuckets | null {
  // Markdown header markers (#, *) and trailing punctuation are tolerated; a
  // leading bullet ("- Decisions …") is NOT a header.
  const normalized = line
    .replace(/^[#*\s]+/, "")
    .replace(/[:：#*\s]+$/, "")
    .toUpperCase();
  return SECTION_BY_HEADER[normalized] ?? null;
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
