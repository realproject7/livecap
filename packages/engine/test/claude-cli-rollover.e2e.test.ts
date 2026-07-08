// #136 session rollover: a persistent `claude -p` session accumulates unbounded
// history and eventually hits the ~2h context cliff ("prompt too long" on every
// turn). The engine watches the already-parsed cacheReadInputTokens and, once it
// crosses the threshold, refreshes to a FRESH session (dropping history) and
// reseeds continuity — before the cliff — while translation keeps flowing.
//
// Real spawn/stdio via fake-cli echo mode; LIVECAP_FAKE_CACHE_READ drives the
// per-turn cache-read the threshold reacts to.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { ClaudeCliEngine } from "../src/claude-cli-engine";
import type { EngineHealthEvent } from "../src/claude-cli-engine";
import type { Sentence, Translation, Usage } from "../src/types";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

const batch: Sentence[] = [{ id: "s1", text: "Rates are unchanged.", seq: 1 }];

async function drain(engine: ClaudeCliEngine): Promise<Translation[]> {
  const out: Translation[] = [];
  for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
  return out;
}

function makeEngine(cacheReadPerTurn: number, rolloverAfter: number): ClaudeCliEngine {
  return new ClaudeCliEngine({
    bin: FAKE_CLI,
    cwd: tmpdir(),
    env: { ...process.env, LIVECAP_FAKE_ECHO: "1", LIVECAP_FAKE_CACHE_READ: String(cacheReadPerTurn) },
    includePartialMessages: false,
    rolloverAfterCacheReadTokens: rolloverAfter,
    continuitySeed: () => "The Fed held rates and stayed data-dependent.",
  });
}

describe("ClaudeCliEngine — session rollover (#136)", () => {
  it("refreshes the session once the cached prefix crosses the threshold, and keeps translating", async () => {
    const engine = makeEngine(500_000, 100_000);
    const health: EngineHealthEvent[] = [];
    const usages: Usage[] = [];
    engine.onHealthEvent((e) => health.push(e));
    engine.onUsage((u) => usages.push(u));
    await engine.start();
    try {
      // Turn 1: usage reports cache_read 500k >= 100k → arms a rollover for the
      // NEXT turn (not this one, which already ran against the current session).
      const t1 = await drain(engine);
      expect(t1.at(-1)?.done).toBe(true);
      expect(health.some((e) => e.kind === "rolledOver")).toBe(false);

      // Turn 2: the session refreshes (fresh `claude -p` + continuity reseed),
      // then translates — seamlessly, from the caller's view.
      const t2 = await drain(engine);
      expect(t2.at(-1)?.done).toBe(true);
      expect(t2.at(-1)?.text.length).toBeGreaterThan(0); // translation continues
      expect(health.filter((e) => e.kind === "rolledOver")).toHaveLength(1);

      // Cost never regresses across the rollover: the retired session's total is
      // banked, so the reported cumulative stays monotonic even though the fresh
      // session's own total_cost_usd restarts near 0 (#136/#24).
      for (let i = 1; i < usages.length; i += 1) {
        expect(usages[i]!.cumulativeCostUsd).toBeGreaterThanOrEqual(usages[i - 1]!.cumulativeCostUsd);
      }
      expect(usages.at(-1)!.cumulativeCostUsd).toBeGreaterThan(usages[0]!.cumulativeCostUsd);
    } finally {
      await engine.stop();
    }
  });

  it("does not roll over while the cached prefix stays below the threshold (data-driven)", async () => {
    const engine = makeEngine(50_000, 100_000); // below threshold every turn
    const health: EngineHealthEvent[] = [];
    engine.onHealthEvent((e) => health.push(e));
    await engine.start();
    try {
      await drain(engine);
      await drain(engine);
      await drain(engine);
      expect(health.some((e) => e.kind === "rolledOver")).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("never rolls over when no threshold is configured (default; unbounded as before)", async () => {
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_ECHO: "1", LIVECAP_FAKE_CACHE_READ: "5000000" },
      includePartialMessages: false,
      // rolloverAfterCacheReadTokens omitted
    });
    const health: EngineHealthEvent[] = [];
    engine.onHealthEvent((e) => health.push(e));
    await engine.start();
    try {
      await drain(engine);
      await drain(engine);
      expect(health).toEqual([]);
    } finally {
      await engine.stop();
    }
  });
});
