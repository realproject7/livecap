import { describe, it, expect } from "vitest";

import { buildClaudeArgs, CLAUDE_MODELS, DEFAULT_MODEL, sanitizedClaudeModel } from "../src/args";

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

  // #203: every curated pick has to survive into argv — a picker that changes a
  // setting without changing the spawned command line is the failure this guards.
  it("carries every curated model into --model", () => {
    for (const model of CLAUDE_MODELS) {
      const args = buildClaudeArgs({ ...base, model });
      expect(args[args.indexOf("--model") + 1]).toBe(model);
    }
  });
});

describe("sanitizedClaudeModel (#203)", () => {
  it("keeps every curated pick", () => {
    for (const model of CLAUDE_MODELS) {
      expect(sanitizedClaudeModel(model)).toBe(model);
    }
  });

  // An unknown model does not fail locally — it spawns a CLI that 404s on every
  // turn, i.e. a dead translation lane rather than a visible error. Clamping is
  // what keeps a hand-edited settings.json from doing that.
  it("clamps unknown values, absent values, and whitespace to the default", () => {
    expect(sanitizedClaudeModel("claude-3-5-haiku-20241022")).toBe(DEFAULT_MODEL);
    expect(sanitizedClaudeModel("opus-4-1")).toBe(DEFAULT_MODEL);
    expect(sanitizedClaudeModel("Opus")).toBe(DEFAULT_MODEL); // exact match only
    expect(sanitizedClaudeModel(undefined)).toBe(DEFAULT_MODEL);
    expect(sanitizedClaudeModel(null)).toBe(DEFAULT_MODEL);
    expect(sanitizedClaudeModel("   ")).toBe(DEFAULT_MODEL);
    expect(sanitizedClaudeModel(" sonnet ")).toBe("sonnet"); // trimmed, not rejected
  });

  it("keeps the default inside the curated list", () => {
    expect(CLAUDE_MODELS).toContain(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("haiku"); // #203 does not move the default
  });
});
