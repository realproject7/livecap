// #79 / #112: coachUtterance / coachUtterances at the pipeline level. Drives the
// REAL ExtrasPipeline through a counting fake completion engine so we can assert
// the degenerate-input no-op does NOT call the model (no fabricated rewrite, no
// spend), that batching groups real items into few turns (#112), that the
// per-item fallback never loses an utterance, and that usage attribution sums
// back to the real turn totals.

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

/** A well-formed batched response echoing `### ITEM k` for k = 1..count, each
 *  with content that names its item number so alignment can be asserted. */
function batchOutput(count: number): string {
  const blocks: string[] = [];
  for (let k = 1; k <= count; k += 1) {
    blocks.push(
      `### ITEM ${k}`,
      "BETTER",
      `Cleaner version of item ${k}.`,
      "CHANGES",
      `um ${k} => (removed)`,
      "EXPLANATION",
      `Explanation ${k}.`,
    );
  }
  return blocks.join("\n");
}

/** How many `### ITEM k` markers the batch prompt carried (0 → a single-item
 *  request built by buildCoachPrompt). */
function requestedItemCount(request: CompletionRequest): number {
  return [...(request.user ?? "").matchAll(/### ITEM \d+/g)].length;
}

/** Records model calls; answers batch requests with a well-formed multi-item
 *  response and single requests with COACH_OUTPUT. `respond` can be overridden
 *  to simulate a malformed / miscounted batch. */
class CountingEngine {
  calls = 0;
  batchSizes: number[] = [];
  lastRequest: CompletionRequest | null = null;

  constructor(private readonly respond: (n: number) => string = batchOutput) {}

  complete(request: CompletionRequest): Promise<Completion> {
    this.calls += 1;
    this.lastRequest = request;
    const items = requestedItemCount(request);
    if (items > 0) this.batchSizes.push(items);
    const usage: Usage = {
      cumulativeCostUsd: 0.001 * this.calls,
      turnCostUsd: 0.002,
      inputTokens: 13,
      outputTokens: 7,
      cacheReadInputTokens: 3,
    };
    const text = items > 0 ? this.respond(items) : COACH_OUTPUT;
    return Promise.resolve({ text, usage });
  }
}

function makePipeline(respond?: (n: number) => string): {
  engine: CountingEngine;
  pipeline: ExtrasPipeline;
} {
  const engine = new CountingEngine(respond);
  const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });
  return { engine, pipeline };
}

/** Sum a Usage field across per-item results. */
function sumField(results: { usage: Usage }[], field: keyof Usage): number {
  return results.reduce((acc, r) => acc + r.usage[field], 0);
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
    expect(result.usage.turnCostUsd).toBe(0.002);
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

describe("ExtrasPipeline.coachUtterances — batch (#79/#112)", () => {
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
    // Two real items batch into ONE grouped turn (#112), was two serial turns.
    expect(engine.calls).toBe(1);
    expect(engine.batchSizes).toEqual([2]);
    // Degenerate items are no-ops in place.
    expect(results[1]).toMatchObject({ better: "Yeah", changes: [], explanation: "" });
    expect(results[3]).toMatchObject({ better: "", changes: [], explanation: "" });
    // Real items carry the parsed rewrite, aligned to their original index.
    expect(results[0]?.better).toBe("Cleaner version of item 1.");
    expect(results[2]?.better).toBe("Cleaner version of item 2.");
  });

  it("coaches 10 real utterances in ≤2 model turns (#112 fixture)", async () => {
    const { engine, pipeline } = makePipeline();
    const inputs = Array.from({ length: 10 }, (_, i) => `um so I think we should really do thing number ${i}`);
    const results = await pipeline.coachUtterances(inputs);
    expect(results).toHaveLength(10);
    // 10 real / batch-size 5 → exactly two grouped turns.
    expect(engine.calls).toBeLessThanOrEqual(2);
    expect(engine.batchSizes).toEqual([5, 5]);
    // Every item is coached and aligned (item k+1 for 0-based index k).
    results.forEach((r, i) => expect(r.better).toBe(`Cleaner version of item ${(i % 5) + 1}.`));
  });

  it("re-runs ONLY the items a miscounted batch dropped — never loses an utterance (#112 fallback)", async () => {
    // The batch is asked for 3 items but only returns 2 → item 3's marker is
    // absent, so just that one is re-run through the single-item path.
    const { engine, pipeline } = makePipeline((n) => batchOutput(Math.min(n, 2)));
    const inputs = [
      "um the first thing we should discuss here",
      "and the uh second point I wanted to raise",
      "finally the um third item on my list",
    ];
    const results = await pipeline.coachUtterances(inputs);
    expect(results).toHaveLength(3);
    // 1 batch turn (returns 2 items) + 1 re-run for the dropped 3rd item.
    expect(engine.calls).toBe(2);
    expect(engine.batchSizes).toEqual([3]); // the batch requested 3
    // Items 1 and 2 came from the batch; item 3 fell back to the single path,
    // which the fake answers with COACH_OUTPUT — no utterance lost.
    expect(results[0]?.better).toBe("Cleaner version of item 1.");
    expect(results[1]?.better).toBe("Cleaner version of item 2.");
    expect(results[2]?.better).toBe(
      "I'd like to shift our personalization to real-time contextual curation.",
    );
  });

  it("divides each batch turn's usage evenly so per-item sums equal the turn totals (#112)", async () => {
    const { engine, pipeline } = makePipeline();
    const inputs = Array.from({ length: 4 }, (_, i) => `um the point number ${i} I want to make now`);
    const results = await pipeline.coachUtterances(inputs);
    expect(engine.calls).toBe(1); // one grouped turn of 4
    // The single batch turn's usage, split across 4 items, sums back exactly.
    expect(sumField(results, "turnCostUsd")).toBeCloseTo(0.002, 10);
    expect(sumField(results, "inputTokens")).toBe(13);
    expect(sumField(results, "outputTokens")).toBe(7);
    expect(sumField(results, "cacheReadInputTokens")).toBe(3);
    // Token remainders distribute one-per-item (13 → 4,3,3,3), never fractional.
    for (const r of results) {
      expect(Number.isInteger(r.usage.inputTokens)).toBe(true);
      expect(Number.isInteger(r.usage.outputTokens)).toBe(true);
    }
  });

  it("usage still sums to real turn totals when an item falls back (#112)", async () => {
    // 3 requested, batch returns 2 → 1 batch turn + 1 re-run turn; the returned
    // per-item usage must account for BOTH turns' tokens.
    const { engine, pipeline } = makePipeline((n) => batchOutput(Math.min(n, 2)));
    const inputs = [
      "um the first thing we should discuss here",
      "and the uh second point I wanted to raise",
      "finally the um third item on my list",
    ];
    const results = await pipeline.coachUtterances(inputs);
    expect(engine.calls).toBe(2); // batch + one re-run
    // Two turns × 13 input / 7 output / 3 cacheRead tokens each.
    expect(sumField(results, "inputTokens")).toBe(26);
    expect(sumField(results, "outputTokens")).toBe(14);
    expect(sumField(results, "cacheReadInputTokens")).toBe(6);
    expect(sumField(results, "turnCostUsd")).toBeCloseTo(0.004, 10);
  });

  it("degenerate-only input never calls the model (#112)", async () => {
    const { engine, pipeline } = makePipeline();
    const results = await pipeline.coachUtterances(["Yeah", "", "  ", "Right."]);
    expect(engine.calls).toBe(0);
    expect(results.map((r) => r.better)).toEqual(["Yeah", "", "", "Right."]);
    expect(sumField(results, "turnCostUsd")).toBe(0);
  });
});
