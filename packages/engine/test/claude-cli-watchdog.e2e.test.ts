// CLI translation watchdog (#135): a hung `claude -p` turn must abort within a
// per-turn timeout instead of wedging translation forever, a crashed CLI must
// respawn so later turns recover, and a repeated-failure streak must fire one
// content-free `degraded` signal so the host can fall back to the local tier.
//
// Real spawn/stdio against fake-cli's failure-injection modes — no mocks.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { ClaudeCliEngine, EngineTimeoutError } from "../src/claude-cli-engine";
import type { EngineHealthEvent } from "../src/claude-cli-engine";
import type { Sentence, Translation } from "../src/types";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

const batch: Sentence[] = [{ id: "s1", text: "We are committed to the dual mandate.", seq: 1 }];

/** A unique marker path per call, so a "_ONCE" mode's first-process claim is not
 *  poisoned by a leftover file from an earlier run. */
let markerSeq = 0n;
function marker(tag: string): string {
  markerSeq += 1n;
  return join(tmpdir(), `livecap-fake-${tag}-${process.pid}-${markerSeq}`);
}

interface EngineOpts {
  env: Record<string, string | undefined>;
  turnTimeoutMs?: number;
  maxTurnFailures?: number;
}

function makeEngine({ env, turnTimeoutMs, maxTurnFailures }: EngineOpts): {
  engine: ClaudeCliEngine;
  events: EngineHealthEvent[];
} {
  const engine = new ClaudeCliEngine({
    bin: FAKE_CLI,
    cwd: tmpdir(),
    // Echo mode gives respawned processes a normal (successful) turn to serve.
    env: { ...process.env, LIVECAP_FAKE_ECHO: "1", ...env },
    includePartialMessages: false,
    turnTimeoutMs,
    maxTurnFailures,
  });
  const events: EngineHealthEvent[] = [];
  engine.onHealthEvent((e) => events.push(e));
  return { engine, events };
}

async function drain(engine: ClaudeCliEngine): Promise<Translation[]> {
  const out: Translation[] = [];
  for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
  return out;
}

describe("ClaudeCliEngine — per-turn watchdog, respawn, and degraded fallback (#135)", () => {
  it("aborts a hung turn within the watchdog window with a content-free EngineTimeoutError", async () => {
    const { engine } = makeEngine({ env: { LIVECAP_FAKE_HANG_ALWAYS: "1" }, turnTimeoutMs: 200 });
    await engine.start();
    try {
      const started = Date.now();
      let error: unknown;
      try {
        await drain(engine);
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - started;
      // Aborted, not wedged: it returns near the timeout, nowhere near forever.
      expect(elapsed).toBeLessThan(2000);
      expect(error).toBeInstanceOf(EngineTimeoutError);
      const message = (error as Error).message;
      // #23: the error never carries the caption/prompt text.
      expect(message).not.toContain("dual mandate");
      expect(message).toBe("translation turn timed out (200ms without a response)");
    } finally {
      await engine.stop();
    }
  });

  it("respawns after a mid-turn crash so the next turn recovers", async () => {
    const { engine, events } = makeEngine({ env: { LIVECAP_FAKE_CRASH_ONCE: marker("crash") } });
    await engine.start();
    try {
      // Turn 1: the CLI exits mid-turn → the turn fails.
      await expect(drain(engine)).rejects.toThrow();
      // Turn 2: the engine respawns (resumed by id) and translation is restored.
      const recovered = (await drain(engine)).at(-1);
      expect(recovered?.done).toBe(true);
      expect(recovered?.text.length).toBeGreaterThan(0);
      expect(events).toContainEqual({ kind: "respawned" });
    } finally {
      await engine.stop();
    }
  });

  it("respawns after a hung turn (killed by the watchdog) so the next turn recovers", async () => {
    const { engine, events } = makeEngine({
      env: { LIVECAP_FAKE_HANG_ONCE: marker("hang") },
      turnTimeoutMs: 200,
    });
    await engine.start();
    try {
      // Turn 1: hangs → watchdog aborts with a timeout error and kills the child.
      await expect(drain(engine)).rejects.toBeInstanceOf(EngineTimeoutError);
      // Turn 2: a fresh process serves normally.
      const recovered = (await drain(engine)).at(-1);
      expect(recovered?.done).toBe(true);
      expect(recovered?.text.length).toBeGreaterThan(0);
      expect(events).toContainEqual({ kind: "respawned" });
    } finally {
      await engine.stop();
    }
  });

  it("fires exactly one `degraded` event once the failure streak reaches the threshold", async () => {
    const { engine, events } = makeEngine({
      env: { LIVECAP_FAKE_HANG_ALWAYS: "1" },
      turnTimeoutMs: 150,
      maxTurnFailures: 2,
    });
    await engine.start();
    try {
      await expect(drain(engine)).rejects.toThrow(); // failure 1
      expect(events.filter((e) => e.kind === "degraded")).toHaveLength(0);
      await expect(drain(engine)).rejects.toThrow(); // failure 2 → degraded
      expect(events.filter((e) => e.kind === "degraded")).toHaveLength(1);
      // Latched: a third consecutive failure does not re-fire.
      await expect(drain(engine)).rejects.toThrow(); // failure 3
      expect(events.filter((e) => e.kind === "degraded")).toHaveLength(1);
    } finally {
      await engine.stop();
    }
  });

  it("respawns resuming the external resume id, not a fresh unused session id (#135)", async () => {
    // Started with an external `resume` id, so `sessionId` is a fresh UUID that
    // was never used with --session-id. A respawn must resume the ORIGINAL
    // conversation (continuity), not fork into that unused id.
    const argvFile = marker("resume-argv");
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: {
        ...process.env,
        LIVECAP_FAKE_ECHO: "1",
        LIVECAP_FAKE_CRASH_ONCE: marker("crash-resume"),
        LIVECAP_FAKE_ARGV_OUT: argvFile, // each process rewrites this with its argv
      },
      includePartialMessages: false,
      sessionId: "SID-fresh-unused",
      resume: "RESUME-original-convo",
    });
    await engine.start();
    try {
      await expect(drain(engine)).rejects.toThrow(); // turn 1 crashes mid-turn
      await drain(engine); // turn 2 respawns → argvFile now holds the respawn's argv
      const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
      expect(argv).toContain("--resume");
      expect(argv[argv.indexOf("--resume") + 1]).toBe("RESUME-original-convo");
      // The unused session id must never reach the respawn command line.
      expect(argv).not.toContain("SID-fresh-unused");
      expect(argv).not.toContain("--session-id");
    } finally {
      await engine.stop();
    }
  });

  it("does not fire `degraded` when a healthy turn resets the failure streak", async () => {
    const { engine, events } = makeEngine({
      env: { LIVECAP_FAKE_CRASH_ONCE: marker("crash-reset") },
      maxTurnFailures: 2,
    });
    await engine.start();
    try {
      await expect(drain(engine)).rejects.toThrow(); // failure 1 (crash)
      await drain(engine); // respawn → healthy turn resets the streak
      expect(events.filter((e) => e.kind === "degraded")).toHaveLength(0);
    } finally {
      await engine.stop();
    }
  });

  it("emits no health event for a normal, responsive turn", async () => {
    const { engine, events } = makeEngine({ env: {} });
    await engine.start();
    try {
      const final = (await drain(engine)).at(-1);
      expect(final?.done).toBe(true);
      expect(events).toHaveLength(0);
    } finally {
      await engine.stop();
    }
  });
});
