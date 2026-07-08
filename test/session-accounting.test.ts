// #142 accounting wiring: the CLI-tier two-lane split runs TWO ClaudeCliEngine
// sessions (live translation + summary/extras) that both fall back to ONE shared
// local engine. `meterEngines` must sum usage/cost across every distinct engine
// while metering the shared local exactly once (never double-counted across the
// two lanes). Tested as an exported pure helper — the host has no headless e2e
// harness (start() spawns real CLI/llama-server children), matching the #139
// applyRetranslation pattern; the helper IS the accounting fix.
import { describe, expect, it } from "vitest";

import type { Usage } from "@livecap/engine";

import { meterEngines } from "../src/host/session";

/** A minimal usage source: records its listeners and lets the test emit a turn. */
function fakeEngine() {
  const listeners = new Set<(usage: Usage) => void>();
  return {
    onUsage(listener: (usage: Usage) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(turnCostUsd: number): void {
      const usage: Usage = {
        cumulativeCostUsd: 0,
        turnCostUsd,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
      };
      for (const listener of listeners) listener(usage);
    },
  };
}

describe("meterEngines (#142)", () => {
  it("sums usage/cost across both lanes' engines", () => {
    const translation = fakeEngine();
    const extras = fakeEngine();
    let ledger = 0;
    let sessionCost = 0;

    meterEngines(
      [translation, extras],
      (engine) => engine.onUsage((usage) => (ledger += usage.turnCostUsd)), // stands in for the credit ledger
      (turnCostUsd) => (sessionCost += turnCostUsd),
    );

    translation.emit(0.5); // a live translation turn on lane A
    extras.emit(0.3); // a summary turn on lane B

    expect(sessionCost).toBeCloseTo(0.8);
    expect(ledger).toBeCloseTo(0.8);
  });

  it("meters a shared engine exactly once — the local fallback both lanes converge on is not double-counted", () => {
    const local = fakeEngine();
    let attaches = 0;
    let sessionCost = 0;

    // The shared local engine appears in BOTH lanes' engine lists.
    meterEngines(
      [local, local],
      () => (attaches += 1),
      (turnCostUsd) => (sessionCost += turnCostUsd),
    );

    expect(attaches).toBe(1); // attached once despite appearing twice
    local.emit(0.4);
    expect(sessionCost).toBeCloseTo(0.4); // counted once, not 0.8
  });
});
