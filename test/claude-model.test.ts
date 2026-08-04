import { describe, expect, it } from "vitest";

import {
  CLAUDE_MODELS as ENGINE_CLAUDE_MODELS,
  DEFAULT_MODEL as ENGINE_DEFAULT_MODEL,
  sanitizedClaudeModel as engineSanitizedClaudeModel,
} from "@livecap/engine";

import {
  CLAUDE_MODELS,
  claudeModelLabel,
  DEFAULT_CLAUDE_MODEL,
  sanitizedClaudeModel,
} from "../src/app-settings";

// #203: the Settings sheet exposes a curated set of Claude tiers. The webview
// cannot import @livecap/engine (that package reaches for node builtins and
// never enters the browser bundle), so src/app-settings.ts MIRRORS the engine's
// list rather than re-exporting it. This file is the guard on that mirror — it
// is the only place both copies are visible at once.

describe("CLAUDE_MODELS (#203 curated picks)", () => {
  it("exposes exactly the curated tiers, cheapest first", () => {
    expect(CLAUDE_MODELS.map((m) => m.value)).toEqual(["haiku", "sonnet", "opus"]);
  });

  it("stays byte-identical to the engine's allow-list", () => {
    expect(CLAUDE_MODELS.map((m) => m.value)).toEqual([...ENGINE_CLAUDE_MODELS]);
    expect(DEFAULT_CLAUDE_MODEL).toBe(ENGINE_DEFAULT_MODEL);
  });

  // Aliases, not dated snapshot ids: an id like claude-3-5-haiku-20241022 is
  // retired eventually and would 404 every turn on an install nobody touched.
  it("uses tier aliases, never a pinned snapshot id", () => {
    for (const m of CLAUDE_MODELS) {
      expect(m.value).toMatch(/^[a-z]+$/);
      expect(m.value).not.toMatch(/\d/);
    }
  });

  // The note is the only place the user is told a heavier tier costs more of
  // the plan before they pick it, so it is load-bearing copy, not decoration.
  it("carries a plan-cost note and a label for every option", () => {
    for (const m of CLAUDE_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.note.length).toBeGreaterThan(0);
    }
    expect(CLAUDE_MODELS.map((m) => m.note).join(" ")).toContain("plan");
  });
});

describe("sanitizedClaudeModel (#203 default handling)", () => {
  it("keeps every curated pick as-is", () => {
    for (const m of CLAUDE_MODELS) {
      expect(sanitizedClaudeModel(m.value)).toBe(m.value);
    }
  });

  // Absence means "predates #203", when the model was hard-pinned to Haiku in
  // the engine — so the default IS what that install was already running. No
  // migration caveat here, unlike sanitizedSttModel (#202).
  it("defaults to haiku when the field is absent (old settings.json)", () => {
    expect(sanitizedClaudeModel(undefined)).toBe("haiku");
    expect(sanitizedClaudeModel(null)).toBe("haiku");
    expect(sanitizedClaudeModel("")).toBe("haiku");
  });

  it("clamps unknown / hand-edited values to the default", () => {
    expect(sanitizedClaudeModel("claude-opus-4-5-20251101")).toBe("haiku"); // dated id
    expect(sanitizedClaudeModel("sonnet-4-5")).toBe("haiku");
    expect(sanitizedClaudeModel("gpt-5")).toBe("haiku");
    expect(sanitizedClaudeModel("Haiku")).toBe("haiku"); // case is not folded
  });

  // All three clamps (here, the engine, and the Rust sanitizer) trim before
  // matching, so a whitespace-padded value resolves the same way everywhere
  // instead of clamping on one side and passing on another.
  it("trims before matching, like the Rust sanitizer", () => {
    expect(sanitizedClaudeModel("  sonnet  ")).toBe("sonnet");
    expect(sanitizedClaudeModel("\topus\n")).toBe("opus");
    expect(sanitizedClaudeModel("   ")).toBe("haiku");
  });

  // Same inputs, same verdicts across the mirror — a drift in either clamp
  // shows up here rather than as a dead translation lane at runtime.
  it("agrees with the engine's clamp on every input", () => {
    for (const value of [
      "haiku",
      "sonnet",
      "opus",
      "Haiku",
      "claude-opus-4-5-20251101",
      "gpt-5",
      "  sonnet  ",
      "   ",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizedClaudeModel(value)).toBe(engineSanitizedClaudeModel(value));
    }
  });
});

describe("claudeModelLabel (#203 shared by both surfaces)", () => {
  it("labels every curated pick", () => {
    expect(claudeModelLabel("haiku")).toBe("Haiku");
    expect(claudeModelLabel("sonnet")).toBe("Sonnet");
    expect(claudeModelLabel("opus")).toBe("Opus");
  });

  // The Settings sheet's engine button and the onboarding engine card both
  // render through this, so an unknown value must not leave them disagreeing.
  it("falls back to the default's label for unknown values", () => {
    expect(claudeModelLabel("gpt-5")).toBe("Haiku");
    expect(claudeModelLabel(undefined)).toBe("Haiku");
  });
});

// The rest of the chain — a curated pick surviving into the argv the CLI is
// actually spawned with — is asserted where the spawn happens, against a real
// process: packages/engine/test/claude-cli-engine.e2e.test.ts ("spawns the
// chosen model and accounts cost identically to the default"), with the pure
// argv build covered in packages/engine/test/args.test.ts. `buildClaudeArgs`
// is deliberately not part of the package's public surface, so it is not
// re-tested here through it.
