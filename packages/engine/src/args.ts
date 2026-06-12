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

export const DEFAULT_MODEL = "haiku";

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
