import { describe, it, expect } from "vitest";

import {
  asTaskMessage,
  buildGlossarySetupMessage,
  buildReseedMessage,
  buildSystemPrompt,
  buildTranslateMessage,
  formatUserMessageLine,
  TASK_MARKER,
} from "../src/prompt";
import type { RollingContext, Sentence } from "../src/types";

describe("buildSystemPrompt", () => {
  it("states the output-only contract and folds in a fixed glossary", () => {
    const prompt = buildSystemPrompt({ targetLanguage: "Korean", glossary: { FOMC: "연방공개시장위원회" } });
    expect(prompt).toContain("Output ONLY the Korean translation");
    expect(prompt).toContain("FOMC → 연방공개시장위원회");
  });

  it("does not pin the source language — any spoken language translates into the target (#12)", () => {
    const prompt = buildSystemPrompt({ targetLanguage: "German" });
    expect(prompt).toContain("into German");
    expect(prompt).not.toContain("English sentences");
    expect(prompt).toContain("detected automatically");
  });

  it("carries the [TASK] override clause so extras can reuse the session", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(TASK_MARKER);
    expect(prompt.toLowerCase()).toContain("follow that message");
  });
});

describe("asTaskMessage", () => {
  it("prefixes the marker on its own line", () => {
    expect(asTaskMessage("do the thing")).toBe("[TASK]\ndo the thing");
  });
});

describe("buildGlossarySetupMessage", () => {
  it("renders glossary terms for stdin delivery (#26 — off argv)", () => {
    const msg = buildGlossarySetupMessage({ AcmeCorp: "에이콘", FOMC: "연방공개시장위원회" });
    expect(msg).toContain("AcmeCorp → 에이콘");
    expect(msg).toContain("FOMC → 연방공개시장위원회");
  });

  it("is not placed in the static system prompt (which goes on argv)", () => {
    // buildSystemPrompt with no glossary option carries no user terms.
    expect(buildSystemPrompt({ targetLanguage: "Korean" })).not.toContain("AcmeCorp");
  });
});

describe("buildTranslateMessage", () => {
  const batch: Sentence[] = [
    { id: "a", text: "Rates are unchanged.", seq: 1 },
    { id: "b", text: "We remain data dependent.", seq: 2 },
  ];

  it("includes only the last N context pairs", () => {
    const ctx: RollingContext = {
      pairs: Array.from({ length: 6 }, (_, i) => ({ source: `en${i}`, target: `ko${i}` })),
    };
    const msg = buildTranslateMessage(batch, ctx, 4);
    expect(msg).toContain("en5");
    expect(msg).not.toContain("en1");
    expect(msg).toContain("Rates are unchanged.\nWe remain data dependent.");
  });

  it("omits the context block entirely when there are no pairs", () => {
    const msg = buildTranslateMessage(batch, { pairs: [] });
    expect(msg).not.toContain("Recent context");
    expect(msg.startsWith("Translate, one line per sentence:")).toBe(true);
  });

  it("keeps per-turn input bounded regardless of how many pairs accumulate — CLI trim (#136)", () => {
    // The CLI tier passes a small contextPairs (the persistent session remembers
    // prior turns), so a long meeting's growing pair history never inflates the
    // per-turn message beyond the trimmed window.
    const many: RollingContext = {
      pairs: Array.from({ length: 500 }, (_, i) => ({ source: `en${i}`, target: `ko${i}` })),
    };
    const one = buildTranslateMessage(batch, many, 1);
    // Only the single most-recent pair survives — 499 older pairs are dropped, so
    // the per-turn message can't grow with the meeting's accumulating history.
    expect(one).toContain("en499");
    expect(one).not.toContain("en498");
    expect(one).not.toContain("en0");
    const none = buildTranslateMessage(batch, many, 0);
    expect(none).not.toContain("Recent context"); // 0 → no context block at all
  });
});

describe("buildReseedMessage (#136)", () => {
  it("carries the glossary and running summary so terminology survives a rollover", () => {
    const msg = buildReseedMessage({ FOMC: "연방공개시장위원회" }, "The Fed held rates and stayed data-dependent.");
    expect(msg).toContain("FOMC → 연방공개시장위원회");
    expect(msg).toContain("The Fed held rates and stayed data-dependent.");
    // Marked as context, not something to translate/echo.
    expect(msg?.toLowerCase()).toContain("do not translate");
    // Wrapped as a [TASK] override so the fresh session treats it as an instruction.
    expect(asTaskMessage(msg ?? "").startsWith(TASK_MARKER)).toBe(true);
  });

  it("works with only a summary (no glossary configured — the common CLI case)", () => {
    const msg = buildReseedMessage(undefined, "Quarterly review of the roadmap.");
    expect(msg).toContain("Quarterly review of the roadmap.");
    expect(msg).not.toContain("Preferred term translations");
  });

  it("returns undefined when there is nothing to seed (no reseed turn is sent)", () => {
    expect(buildReseedMessage(undefined, undefined)).toBeUndefined();
    expect(buildReseedMessage({}, "   ")).toBeUndefined(); // empty glossary + blank summary
  });
});

describe("formatUserMessageLine", () => {
  it("wraps text as a single stream-json user line (content in payload, not argv)", () => {
    const line = formatUserMessageLine("hi");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
  });
});
