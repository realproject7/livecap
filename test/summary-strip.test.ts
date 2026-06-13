import { describe, it, expect } from "vitest";

import { summaryStripContent } from "../src/summary-strip";

describe("summaryStripContent (#65 durable failure surface)", () => {
  it("shows a terminal failure DURABLY in the strip when idle with a detail", () => {
    const c = summaryStripContent("idle", "translation engine did not start (TimeoutError: …)", "");
    expect(c.label).toBe("Couldn't start");
    expect(c.line).toContain("did not start");
    expect(c.live).toBe(false);
  });

  it("shows the start prompt when idle with no detail (clean stop)", () => {
    const c = summaryStripContent("idle", "", "");
    expect(c.line).toMatch(/Start captioning/);
    expect(c.live).toBe(false);
  });

  it("surfaces progress detail while starting", () => {
    expect(summaryStripContent("starting", "downloading local model 40%…", "").line).toBe(
      "downloading local model 40%…",
    );
    expect(summaryStripContent("starting", "", "").line).toBe("…");
  });

  it("lights the live dot only when live", () => {
    expect(summaryStripContent("live", "", "key point").live).toBe(true);
    expect(summaryStripContent("live", "", "key point").line).toBe("key point");
    expect(summaryStripContent("live", "", "").line).toBe("Listening…");
    expect(summaryStripContent("paused", "", "").live).toBe(false);
  });
});
