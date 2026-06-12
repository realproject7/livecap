// Prompt contract (PROPOSAL §4): low temperature, "output the translation
// only", empty output allowed for non-translatable fragments, last N pairs +
// glossary as context. The system prompt is cacheable (set once per session);
// recent context goes in each stdin message.

import type { RollingContext, Sentence } from "./types";

export interface PromptOptions {
  /** Target language name, e.g. "Korean". */
  targetLanguage?: string;
  /** Glossary fixed for the whole session (folded into the system prompt). */
  glossary?: Record<string, string>;
}

const DEFAULT_TARGET = "Korean";

/**
 * Task-override marker. The session system prompt is the translation contract,
 * but summary/board, reply, and quick-translate (#9) reuse the SAME session.
 * A message prefixed with this marker tells the model to follow that message's
 * instructions instead of translating. See buildSystemPrompt / asTaskMessage.
 */
export const TASK_MARKER = "[TASK]";

/** Prefix a message so it overrides the session's default translation behavior. */
export function asTaskMessage(message: string): string {
  return `${TASK_MARKER}\n${message}`;
}

function glossaryLines(glossary: Record<string, string>): string[] {
  return Object.entries(glossary).map(([term, target]) => `- ${term} → ${target}`);
}

/** Build the cacheable system prompt. */
export function buildSystemPrompt(options: PromptOptions = {}): string {
  const target = options.targetLanguage ?? DEFAULT_TARGET;
  const lines = [
    `You are a real-time meeting interpreter. Translate the English sentences you receive into ${target}.`,
    `Output ONLY the ${target} translation, nothing else — no notes, no romanization, no quotes.`,
    "Keep names, numbers, and financial terms accurate. Prefer natural spoken language over literal wording.",
    "If a fragment is untranslatable noise, output an empty line for it.",
    "Output exactly one line per input sentence, in order.",
    `Exception: if a message begins with ${TASK_MARKER}, ignore the translation rule and follow that message's instructions exactly instead.`,
  ];
  if (options.glossary && Object.keys(options.glossary).length > 0) {
    lines.push("Use these preferred term translations:");
    lines.push(...glossaryLines(options.glossary));
  }
  return lines.join(" ");
}

const DEFAULT_CONTEXT_PAIRS = 4;

/**
 * Build one stdin user message: optional request-scoped glossary, the last N
 * context pairs (so the model keeps terminology consistent without
 * retranslating them), then the sentences to translate.
 */
export function buildTranslateMessage(
  batch: Sentence[],
  ctx: RollingContext,
  contextPairs = DEFAULT_CONTEXT_PAIRS,
): string {
  const blocks: string[] = [];

  if (ctx.glossary && Object.keys(ctx.glossary).length > 0) {
    blocks.push(["Glossary for this request:", ...glossaryLines(ctx.glossary)].join("\n"));
  }

  const recent = ctx.pairs.slice(-contextPairs);
  if (recent.length > 0) {
    const rendered = recent.map((p) => `EN: ${p.source}\nKO: ${p.target}`).join("\n");
    blocks.push(`Recent context (do not retranslate):\n${rendered}`);
  }

  const sentences = batch.map((s) => s.text).join("\n");
  blocks.push(`Translate, one line per sentence:\n${sentences}`);

  return blocks.join("\n\n");
}

/** Build the stdin message for a summary/board request (PROPOSAL §8.4). */
export function buildSummaryMessage(transcript: string): string {
  return [
    "Summarize the meeting so far for a live side panel.",
    "First line: a one-paragraph running summary.",
    "Then, one per line, board items prefixed with their kind in brackets:",
    "[decision], [action], or [question]. Output nothing else.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/** Wrap text as a stream-json user message line (content goes in payload, never argv). */
export function formatUserMessageLine(text: string): string {
  const message = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
  return JSON.stringify(message) + "\n";
}
