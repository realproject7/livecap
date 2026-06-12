// Per-session extras budget cap (#55): a hard ceiling on summary/extras spend
// within one session, so the auto-summary loop can never run away with the
// monthly pool the way #13 observed. Pure and tally-based; the spend it tracks
// is the same `Usage.turnCostUsd` the credit ledger meters, so it "flows into"
// the gauge the host emits.

import { describe, it, expect } from "vitest";

import { ExtrasBudget, ExtrasBudgetExceededError, DEFAULT_EXTRAS_BUDGET_USD } from "../src/extras-budget";
import { ExtrasPipeline } from "../src/extras-pipeline";
import type { Completion, Usage } from "../src/types";

function usage(turnCostUsd: number): Usage {
  return { cumulativeCostUsd: turnCostUsd, turnCostUsd, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 };
}

class FixedCostEngine {
  calls = 0;
  constructor(private readonly costPerCall: number) {}
  complete(): Promise<Completion> {
    this.calls++;
    return Promise.resolve({ text: "SUMMARY\n- a", usage: usage(this.costPerCall) });
  }
}

describe("ExtrasBudget", () => {
  it("allows spend until the cap is reached, then stops", () => {
    const b = new ExtrasBudget({ capUsd: 1 });
    expect(b.canSpend()).toBe(true);
    b.record(0.4);
    expect(b.canSpend()).toBe(true);
    b.record(0.7); // now 1.1 ≥ cap
    expect(b.canSpend()).toBe(false);
    expect(b.remainingUsd).toBe(0);
  });

  it("ignores non-positive / non-finite costs", () => {
    const b = new ExtrasBudget({ capUsd: 1 });
    b.record(0);
    b.record(-5);
    b.record(Number.NaN);
    b.record(Number.POSITIVE_INFINITY);
    expect(b.spentUsd).toBe(0);
    expect(b.canSpend()).toBe(true);
  });

  it("a zero cap disables extras outright", () => {
    const b = new ExtrasBudget({ capUsd: 0 });
    expect(b.canSpend()).toBe(false);
    expect(b.snapshot().fractionUsed).toBe(1);
  });

  it("exposes a snapshot for the gauge", () => {
    const b = new ExtrasBudget({ capUsd: 2 });
    b.record(0.5);
    expect(b.snapshot()).toEqual({
      capUsd: 2,
      spentUsd: 0.5,
      remainingUsd: 1.5,
      fractionUsed: 0.25,
      exhausted: false,
    });
  });

  it("ships a sane default cap", () => {
    expect(DEFAULT_EXTRAS_BUDGET_USD).toBeGreaterThan(0);
  });
});

describe("ExtrasPipeline — budget gating", () => {
  it("records every summary's cost against the budget", async () => {
    const budget = new ExtrasBudget({ capUsd: 10 });
    const engine = new FixedCostEngine(0.3);
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "English", meetingLanguage: "English", budget });
    await pipeline.generateSummaryBoard("a");
    await pipeline.generateSummaryBoard("b");
    expect(budget.spentUsd).toBeCloseTo(0.6, 5);
  });

  it("throws ExtrasBudgetExceededError instead of making the call once the cap is hit", async () => {
    const budget = new ExtrasBudget({ capUsd: 0.4 });
    const engine = new FixedCostEngine(0.4);
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "English", meetingLanguage: "English", budget });
    await pipeline.generateSummaryBoard("a"); // 0.4 spent → cap reached
    await expect(pipeline.generateSummaryBoard("b")).rejects.toBeInstanceOf(ExtrasBudgetExceededError);
    expect(engine.calls).toBe(1); // the second call never reached the engine
  });

  it("the error message is content-free (#23)", async () => {
    const budget = new ExtrasBudget({ capUsd: 0 });
    const engine = new FixedCostEngine(0.4);
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "English", meetingLanguage: "English", budget });
    await expect(pipeline.generateSummaryBoard("secret transcript")).rejects.toThrow(
      /extras budget/i,
    );
    expect(engine.calls).toBe(0);
  });

  it("records user-initiated extras spend but does NOT block them on the cap", async () => {
    // The cap exists to stop the recurring auto-summary loop; reply / quick
    // translate are user-driven and bounded, so they still run (and still meter).
    const budget = new ExtrasBudget({ capUsd: 0.1 });
    const engine = new FixedCostEngine(0.4);
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "English", meetingLanguage: "English", budget });
    budget.record(0.2); // already over cap
    expect(budget.canSpend()).toBe(false);
    const reply = await pipeline.suggestReply("agree", ["hi"]);
    expect(typeof reply.text).toBe("string");
    const quick = await pipeline.quickTranslate("hello");
    expect(typeof quick.text).toBe("string");
    expect(engine.calls).toBe(2);
  });
});
