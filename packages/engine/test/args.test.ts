import { describe, it, expect } from "vitest";

import { buildClaudeArgs } from "../src/args";

describe("buildClaudeArgs", () => {
  const base = { sessionId: "sess-123", systemPrompt: "SYS", includePartialMessages: true };

  it("builds the verified stream-json + isolation recipe (with partials)", () => {
    expect(buildClaudeArgs(base)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "haiku",
      "--session-id",
      "sess-123",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--settings",
      '{"disableAllHooks":true,"alwaysThinkingEnabled":false}',
      "--system-prompt",
      "SYS",
    ]);
  });

  it("omits --include-partial-messages when the CLI did not advertise it", () => {
    const args = buildClaudeArgs({ ...base, includePartialMessages: false });
    expect(args).not.toContain("--include-partial-messages");
    // The flag's absence must not disturb the rest of the recipe.
    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(args[6]).toBe("--model");
  });

  it("uses --resume instead of --session-id when resuming", () => {
    const args = buildClaudeArgs({ ...base, resume: "sess-prev" });
    expect(args).toContain("--resume");
    expect(args).toContain("sess-prev");
    expect(args).not.toContain("--session-id");
  });

  it("pins Haiku by default and honors a model override", () => {
    expect(buildClaudeArgs(base)).toContain("haiku");
    const i = buildClaudeArgs({ ...base, model: "sonnet" }).indexOf("--model");
    expect(buildClaudeArgs({ ...base, model: "sonnet" })[i + 1]).toBe("sonnet");
  });
});
