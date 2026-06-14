// #79: coachUtterance / coachUtterances at the pipeline level. Drives the REAL
// ExtrasPipeline through a counting fake completion engine so we can assert the
// degenerate-input no-op does NOT call the model (no fabricated rewrite, no
// spend) and that batch results align by index.

import { describe, it, expect } from "vitest";

import { ExtrasPipeline } from "../src/extras-pipeline";
import type { Completion, CompletionRequest, Usage } from "../src/types";

const COACH_OUTPUT = [
  "BETTER",
  "I'd like to shift our personalization to real-time contextual curation.",
  "CHANGES",
  "take out—take our personalization => shift our personalization",
  "EXPLANATION",
  "Removes the false starts and states the idea directly.",
].join("\n");

/** Records how many times the model was actually invoked. */
class CountingEngine {
  calls = 0;
  lastRequest: CompletionRequest | null = null;

  complete(request: CompletionRequest): Promise<Completion> {
    this.calls += 1;
    this.lastRequest = request;
    const usage: Usage = {
      cumulativeCostUsd: 0.001 * this.calls,
      turnCostUsd: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
    };
    return Promise.resolve({ text: COACH_OUTPUT, usage });
  }
}

function makePipeline(): { engine: CountingEngine; pipeline: ExtrasPipeline } {
  const engine = new CountingEngine();
  const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });
  return { engine, pipeline };
}

describe("ExtrasPipeline.coachUtterance (#79)", () => {
  it("parses a real rewrite + changes + explanation from the model", async () => {
    const { engine, pipeline } = makePipeline();
    const result = await pipeline.coachUtterance("So I'm—I would aim to take out—take our personalization uh");
    expect(engine.calls).toBe(1);
    expect(result.better).toBe(
      "I'd like to shift our personalization to real-time contextual curation.",
    );
    expect(result.changes).toEqual([
      { from: "take out—take our personalization", to: "shift our personalization" },
    ]);
    expect(result.explanation).toBe("Removes the false starts and states the idea directly.");
    expect(result.usage.turnCostUsd).toBe(0.001);
  });

  it("returns a no-op for degenerate input WITHOUT calling the model (no fabricated rewrite)", async () => {
    const { engine, pipeline } = makePipeline();
    for (const trivial of ["", "   ", "Yeah", "Right.", "음"]) {
      const result = await pipeline.coachUtterance(trivial);
      expect(result.better).toBe(trivial.trim());
      expect(result.changes).toEqual([]);
      expect(result.explanation).toBe("");
      expect(result.usage.turnCostUsd).toBe(0);
    }
    expect(engine.calls).toBe(0);
  });

  it("honors a per-call language override for the rewrite", async () => {
    const { engine, pipeline } = makePipeline();
    await pipeline.coachUtterance("we should um ship the thing", { language: "한국어" });
    expect(engine.lastRequest?.user).toContain("BETTER rewrite in 한국어");
    // The explanation still targets the configured summary language.
    expect(engine.lastRequest?.user).toContain("EXPLANATION in 한국어");
  });
});

describe("ExtrasPipeline.coachUtterances — batch (#79)", () => {
  it("aligns results by index and only round-trips the non-degenerate items", async () => {
    const { engine, pipeline } = makePipeline();
    const inputs = [
      "So I'm—I would aim to take out—take our personalization uh",
      "Yeah", // degenerate → no round-trip
      "we um should ship the feature this week",
      "", // degenerate → no round-trip
    ];
    const results = await pipeline.coachUtterances(inputs);
    expect(results).toHaveLength(4);
    // Two real items → exactly two model calls.
    expect(engine.calls).toBe(2);
    // Degenerate items are no-ops in place.
    expect(results[1]).toMatchObject({ better: "Yeah", changes: [], explanation: "" });
    expect(results[3]).toMatchObject({ better: "", changes: [], explanation: "" });
    // Real items carry the parsed rewrite.
    expect(results[0]?.better).toContain("real-time contextual curation");
    expect(results[2]?.better).toContain("real-time contextual curation");
  });
});
