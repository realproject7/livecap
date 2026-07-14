// #136 session rollover: a persistent `claude -p` session accumulates unbounded
// history and eventually hits the ~2h context cliff ("prompt too long" on every
// turn). The engine watches the already-parsed cacheReadInputTokens and, once it
// crosses the threshold, refreshes to a FRESH session (dropping history) and
// reseeds continuity — before the cliff — while translation keeps flowing.
//
// Real spawn/stdio via fake-cli echo mode; LIVECAP_FAKE_CACHE_READ drives the
// per-turn cache-read the threshold reacts to.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // #173: performRollover mints a fresh id + banks the retired session's cost
  // BEFORE the fresh `claude -p` is confirmed. If that spawn fails (ENOENT /
  // resource exhaustion — plausible exactly under the long-session load that
  // triggers rollover), the old code left sessionId/resumeId pointing at a
  // conversation that never existed, so every later recovery `--resume`d that
  // phantom id forever, AND the retired session's cost stayed banked (double-
  // counted if recovery resumed it). The fix rolls the WHOLE transition back.
  it("rolls a failed-spawn rollover back so recovery resumes the prior session with non-duplicated cost (#173)", async () => {
    const ORIG = "00000000-0000-4000-8000-0000000000aa";
    const argvOut = join(tmpdir(), `livecap-argv-${randomUUID()}.json`);
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: {
        ...process.env,
        LIVECAP_FAKE_ECHO: "1",
        LIVECAP_FAKE_CACHE_READ: "500000", // >= threshold → arms a rollover each turn
        LIVECAP_FAKE_ARGV_OUT: argvOut,
      },
      includePartialMessages: false,
      rolloverAfterCacheReadTokens: 100_000,
      sessionId: ORIG,
      continuitySeed: () => "The Fed held rates.",
    });

    // Inject a one-shot FRESH-spawn failure to model a rollover whose `claude -p`
    // cannot spawn — the one failure mode a real fake-cli binary can't produce (a
    // successfully-started process can never make the parent's spawn() emit
    // 'error'). Only the rollover's fresh spawn (resume === undefined, once armed)
    // is failed; start() and the recovery respawn take the real path.
    interface SpawnSeam {
      spawnSession(resume: string | undefined): Promise<unknown>;
    }
    const seam = engine as unknown as SpawnSeam;
    const realSpawn = seam.spawnSession.bind(engine);
    let failFreshSpawn = false;
    seam.spawnSession = (resume) => {
      if (failFreshSpawn && resume === undefined) {
        failFreshSpawn = false;
        return Promise.reject(new Error("simulated spawn failure (ENOENT)"));
      }
      return realSpawn(resume);
    };

    const usages: Usage[] = [];
    engine.onUsage((u) => usages.push(u));
    await engine.start();
    try {
      // Turn 1: runs on the ORIGINAL session and arms a rollover for turn 2.
      await drain(engine);

      // Turn 2: the armed rollover's fresh spawn fails → performRollover rolls the
      // whole transition back → runTurn throws not-started for this turn.
      failFreshSpawn = true;
      await expect(drain(engine)).rejects.toThrow();

      // Turn 3: recovery. The child is null, so runTurn respawns — and it must
      // resume the PRIOR session id, never a phantom rollover id.
      const t3 = await drain(engine);
      expect(t3.at(-1)?.done).toBe(true);
      expect(t3.at(-1)?.text.length).toBeGreaterThan(0); // translation recovers

      // (a) Viable identity: the recovery respawn resumed the ORIGINAL session.
      const argv = JSON.parse(readFileSync(argvOut, "utf8")) as string[];
      const ri = argv.indexOf("--resume");
      expect(ri).toBeGreaterThan(-1);
      expect(argv[ri + 1]).toBe(ORIG); // the prior id — NOT a stranded phantom
      expect(argv).not.toContain("--session-id"); // resumes, doesn't mint fresh

      // (b) Cost monotonic AND non-duplicated: the retired session's 0.001 was
      // banked then UN-banked by the rollback, and its cumulative restored, so the
      // resumed session's repeat of total_cost_usd=0.001 nets a 0 delta — final
      // cumulative is one session's 0.001, not the 0.002 a restore-ids-only fix
      // (leaving the cost double-banked) would report.
      for (let i = 1; i < usages.length; i += 1) {
        expect(usages[i]!.cumulativeCostUsd).toBeGreaterThanOrEqual(usages[i - 1]!.cumulativeCostUsd);
      }
      expect(usages.at(-1)!.cumulativeCostUsd).toBeCloseTo(0.001, 6);
    } finally {
      await engine.stop();
    }
  });
});
