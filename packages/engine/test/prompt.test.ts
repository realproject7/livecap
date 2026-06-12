import { describe, it, expect } from "vitest";

import {
  asTaskMessage,
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
