// Shared meeting-brief parsing for the engine adapters. Both the CLI and local
// tiers return a summarize() response as one running paragraph plus `[Label]`
// board lines; this splits them the same way so the two tiers can't drift.

/** Split a summary response into the running paragraph and board lines: the
 *  first non-`[` line is the summary, every `[`-prefixed line is a board item. */
export function parseBrief(text: string): { summary: string; board: string[] } {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const summary = lines.find((line) => !line.startsWith("[")) ?? "";
  const board = lines.filter((line) => line.startsWith("["));
  return { summary, board };
}
