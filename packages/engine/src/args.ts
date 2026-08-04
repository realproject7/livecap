// CLI argument construction. Replicates the #3 PoC isolation recipe exactly
// (scripts/poc/translate-poc.mjs) — verified against the committed fixtures.
//
// Translation needs no tools, no MCP, no hooks, no thinking. `--bare` would be
// ideal but disables subscription OAuth, so each context source is stripped
// individually instead. `--include-partial-messages` is gated on a capability
// probe (older builds reject it — see detect.ts).

/** Context-isolation flags. Order matters: this mirrors the verified PoC. */
export const ISOLATION_ARGS: readonly string[] = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--settings",
  '{"disableAllHooks":true,"alwaysThinkingEnabled":false}',
];

/** Curated model picks the app may run (#203). These are the CLI's tier
 *  ALIASES, not dated snapshot ids: the alias resolves to the current build of
 *  each tier, so LiveCap never pins a snapshot that ages out from under it.
 *  Ordered cheapest-first — the order the picker shows. */
export const CLAUDE_MODELS: readonly string[] = ["haiku", "sonnet", "opus"];

/** Model the CLI runs unless the user picks another (#203 keeps this at Haiku:
 *  fast enough for live captions, and the cheapest against the plan). */
export const DEFAULT_MODEL = "haiku";

/**
 * Clamp a persisted/hand-edited model to a curated pick (#203).
 *
 * This is the LAST gate before the value becomes `--model` argv: an unknown
 * value would not fail locally, it would spawn a CLI that 404s on every turn,
 * which surfaces as a dead translation lane rather than an obvious error. The
 * Rust sanitizer (`src-tauri/src/settings.rs`) clamps the same list on the way
 * in; this one holds even if a start message arrives from an older shell.
 */
export function sanitizedClaudeModel(value: string | null | undefined): string {
  // Trimmed before matching so this agrees with the Rust sanitizer on every
  // input (it trims too) — and so stray whitespace can never become argv.
  const model = (value ?? "").trim();
  return CLAUDE_MODELS.includes(model) ? model : DEFAULT_MODEL;
}

export interface ClaudeArgsOptions {
  /** App-generated session id (UUID) for `--session-id`. */
  sessionId: string;
  /** System prompt (cacheable; carries base instructions + fixed glossary). */
  systemPrompt: string;
  /** Whether the CLI advertised `--include-partial-messages` on probe. */
  includePartialMessages: boolean;
  /** Model pin; defaults to Haiku. */
  model?: string;
  /** When resuming a crashed session, pass its id here instead of session-id. */
  resume?: string;
}

/**
 * Build argv for one persistent `claude -p` stream-json session.
 * Prompt content never goes here — it is streamed over stdin (avoids E2BIG /
 * Windows command-line limits, and keeps caption text out of argv, PROPOSAL §5).
 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (options.includePartialMessages) args.push("--include-partial-messages");
  args.push("--model", options.model ?? DEFAULT_MODEL);
  if (options.resume) args.push("--resume", options.resume);
  else args.push("--session-id", options.sessionId);
  args.push(...ISOLATION_ARGS);
  args.push("--system-prompt", options.systemPrompt);
  return args;
}
