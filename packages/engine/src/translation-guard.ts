// Post-processing guard (issue #6). A 4B model follows the "output the
// translation only" contract less reliably than the CLI tier — it adds
// preambles ("Here is the translation:"), wraps lines in quotes/code fences,
// and appends notes. We enforce translation-only output by contract, not hope.

// A whole line that is just commentary / a label — dropped entirely.
const COMMENTARY_LINE = [
  /^(sure|certainly|of course|okay|got it)[!,. ]/i,
  /^here(?:'s| is| are| you go)\b/i,
  // a label-ONLY line ("Translation:", "The translation is:") — but not
  // "Translation: <actual text>", which the inline-label strip handles instead
  /^(the |this )?(translation|translated text|korean translation)( is| follows)?\s*:?\s*$/i,
  /^(note|please note|disclaimer|caveat)\b/i,
  /^[(（][^)）]*[)）]\s*$/, // a wholly-parenthetical line
];

// A leading label on the first content line — stripped, the rest kept.
const INLINE_LABEL = /^(translation|korean|translated text|번역문?)\s*[:：]\s*/i;
const LEADING_QUOTES = /^["'“”„«『「《]+/;
const TRAILING_QUOTES = /["'“”»』」》]+$/;

function isCommentary(line: string): boolean {
  return COMMENTARY_LINE.some((re) => re.test(line));
}

function stripLabelsAndQuotes(line: string): string {
  return line.replace(INLINE_LABEL, "").replace(LEADING_QUOTES, "").replace(TRAILING_QUOTES, "").trim();
}

/** Remove Qwen3 hybrid-thinking reasoning, defensively (belt to the request flag). */
function stripThinking(text: string): string {
  // Whole <think>…</think> blocks.
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // A dangling close (server emitted reasoning then a stray </think>): keep what follows.
  if (/<\/think>/i.test(out)) out = out.replace(/^[\s\S]*<\/think>/i, "");
  // An unclosed <think> (truncated): everything from it on is reasoning, not answer.
  out = out.replace(/<think>[\s\S]*$/i, "");
  return out.trim();
}

/**
 * Reduce raw model output to translation-only text: at most `expectedLines`
 * cleaned lines (one per input sentence), with thinking blocks, code fences,
 * labels, wrapping quotes, and commentary removed. Returns "" when nothing
 * translatable remains (empty output is allowed by the prompt contract).
 *
 * NOTE (MVP): empty lines are dropped, so a per-sentence empty translation does
 * not hold its slot — line↔sentence positional alignment within a batch is not
 * preserved here. Tracked for #11 if positional empties become needed.
 */
export function stripNonTranslation(raw: string, expectedLines = 1): string {
  let text = stripThinking((raw ?? "").trim());

  // Unwrap a single surrounding code fence.
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence && fence[1] !== undefined) text = fence[1].trim();

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const kept: string[] = [];
  for (const line of lines) {
    if (kept.length >= expectedLines) break;
    if (isCommentary(line)) continue;
    const cleaned = stripLabelsAndQuotes(line);
    if (cleaned === "" || isCommentary(cleaned)) continue;
    kept.push(cleaned);
  }
  return kept.join("\n");
}
