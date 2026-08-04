import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  CODEX_DISABLED_FEATURES,
  CODEX_MEASURED_VERSION,
  CodexAppServerEngine,
  parseCodexVersion,
} from "../src/codex-app-server-engine";
import type { Sentence, Translation, Usage } from "../src/types";

// #204: the Codex tier, exercised against a fake app-server that speaks the
// REAL measured JSON-RPC shape over real process stdio. Nothing here needs the
// codex binary to exist — the ticket requires the suite not depend on it.

const FAKE = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const batch: Sentence[] = [{ id: "s1", text: "We are committed to the dual mandate.", seq: 1 }];

function makeEngine(env: NodeJS.ProcessEnv = {}): CodexAppServerEngine {
  return new CodexAppServerEngine({
    bin: FAKE,
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    targetLanguage: "Korean",
    turnTimeoutMs: 15_000,
    startTimeoutMs: 15_000,
  });
}

async function drain(engine: CodexAppServerEngine): Promise<Translation[]> {
  const out: Translation[] = [];
  for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
  return out;
}

describe("parseCodexVersion (#204)", () => {
  it("takes the version and nothing else from the userAgent", () => {
    expect(
      parseCodexVersion("livecap/0.146.0 (Ubuntu 26.4.0; x86_64) xterm-256color (livecap; 0.1.0)"),
    ).toBe("0.146.0");
    expect(parseCodexVersion(undefined)).toBeNull();
    expect(parseCodexVersion(42)).toBeNull();
    expect(parseCodexVersion("no version here")).toBeNull();
  });
});

describe("CodexAppServerEngine — real spawn/stdio (fake app-server)", () => {
  it("streams progressive snapshots and ends with a final done snapshot", async () => {
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_REPLY: "하나 둘 셋" });
    await engine.start();
    expect(engine.health().status).toBe("ready");
    try {
      const snapshots = await drain(engine);
      // Progressive, not one block at the end (#204 AC).
      expect(snapshots.length).toBeGreaterThan(1);
      expect(snapshots.filter((s) => !s.done).length).toBeGreaterThan(0);
      const final = snapshots.at(-1);
      expect(final?.done).toBe(true);
      expect(final?.sentenceIds).toEqual(["s1"]);
      expect(final?.text).toBe("하나 둘 셋");
      // Each snapshot is a growing prefix of the final text.
      for (const snapshot of snapshots) {
        expect(final?.text.startsWith(snapshot.text)).toBe(true);
      }
    } finally {
      await engine.stop();
    }
    expect(engine.health().status).toBe("stopped");
  });

  // The measured overhead reduction only exists if these flags actually reach
  // the spawned process — asserted on real argv, not on a mock.
  it("spawns app-server with the measured feature-disable set, never `exec`", async () => {
    const argvFile = join(tmpdir(), `codex-argv-${process.pid}-${process.hrtime.bigint()}.json`);
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_ARGV_OUT: argvFile });
    await engine.start();
    try {
      const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
      expect(argv).toContain("app-server");
      expect(argv).not.toContain("exec"); // #204: app-server only
      for (const feature of CODEX_DISABLED_FEATURES) {
        expect(argv).toContain(feature);
      }
      expect(argv.filter((a) => a === "--disable")).toHaveLength(CODEX_DISABLED_FEATURES.length);
    } finally {
      await engine.stop();
    }
  });

  // Security (#204): caption text rides the turn input over stdio, never argv.
  it("keeps caption text off the command line", async () => {
    const argvFile = join(tmpdir(), `codex-argv2-${process.pid}-${process.hrtime.bigint()}.json`);
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_ARGV_OUT: argvFile });
    await engine.start();
    try {
      await drain(engine);
      const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
      expect(argv.join("\0")).not.toContain("dual mandate");
    } finally {
      await engine.stop();
    }
  });

  it("adopts the SERVER-minted thread id and reports the probed version", async () => {
    const engine = makeEngine();
    await engine.start();
    try {
      // #204 scope 3: Codex mints the id; the app does not generate one.
      expect(engine.currentThreadId()).toBe("thr_fake_1");
      expect(engine.codexVersion()).toBe(CODEX_MEASURED_VERSION);
    } finally {
      await engine.stop();
    }
  });

  // Codex exposes no USD anywhere. Reporting 0 is the honest value; inventing a
  // figure would be the rate card #204 forbids.
  it("reports token usage with zero USD rather than an invented cost", async () => {
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_INPUT: "5168" });
    const usages: Usage[] = [];
    engine.onUsage((u) => usages.push(u));
    await engine.start();
    try {
      await drain(engine);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.inputTokens).toBe(5168);
      expect(usages[0]?.outputTokens).toBe(16);
      expect(usages[0]?.cacheReadInputTokens).toBe(Math.floor(5168 * 0.66));
      expect(usages[0]?.turnCostUsd).toBe(0);
      expect(usages[0]?.cumulativeCostUsd).toBe(0);
    } finally {
      await engine.stop();
    }
  });

  // #204 scope 4: per-turn input grows as the thread accumulates (~31 tokens/
  // turn measured), so a long meeting must roll the thread over before it walks
  // into the context wall. Trigger keys on modelContextWindow.
  it("rolls the thread over once a turn crosses the context fraction", async () => {
    const engine = new CodexAppServerEngine({
      bin: FAKE,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_CODEX_INPUT: "700", LIVECAP_FAKE_CODEX_WINDOW: "1000" },
      targetLanguage: "Korean",
      rolloverAtContextFraction: 0.6, // 700 >= 600 ⇒ roll before the next turn
      turnTimeoutMs: 15_000,
    });
    await engine.start();
    try {
      expect(engine.currentThreadId()).toBe("thr_fake_1");
      await drain(engine); // crosses the threshold, flags a rollover
      expect(engine.currentThreadId()).toBe("thr_fake_1"); // in-flight turn untouched
      await drain(engine); // next turn starts a fresh thread first
      expect(engine.currentThreadId()).toBe("thr_fake_2");
    } finally {
      await engine.stop();
    }
  });

  it("does NOT roll over while comfortably inside the window", async () => {
    const engine = new CodexAppServerEngine({
      bin: FAKE,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_CODEX_INPUT: "100", LIVECAP_FAKE_CODEX_WINDOW: "1000" },
      targetLanguage: "Korean",
      rolloverAtContextFraction: 0.6,
      turnTimeoutMs: 15_000,
    });
    await engine.start();
    try {
      await drain(engine);
      await drain(engine);
      expect(engine.currentThreadId()).toBe("thr_fake_1");
    } finally {
      await engine.stop();
    }
  });

  it("surfaces a failed turn as a content-free error", async () => {
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_FAIL_TURN: "1" });
    await engine.start();
    try {
      await expect(drain(engine)).rejects.toThrow(/turn failed/i);
    } finally {
      await engine.stop();
    }
  });

  // #204 AC: killing the codex process mid-session recovers via thread/resume
  // with continuity intact — the SAME server-minted thread, not a new one.
  it("recovers a crashed server by resuming the same thread", async () => {
    const marker = join(tmpdir(), `codex-exit-${process.pid}-${process.hrtime.bigint()}.marker`);
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_EXIT_ONCE: marker });
    await engine.start();
    const originalThread = engine.currentThreadId();
    expect(originalThread).toBe("thr_fake_1");
    try {
      // First turn kills the process (the marker makes only that one die).
      await expect(drain(engine)).rejects.toThrow();
      expect(engine.health().status).toBe("error");

      await engine.recover();
      expect(engine.health().status).toBe("ready");
      // Continuity: resumed onto the ORIGINAL thread id, not a fresh one.
      expect(engine.currentThreadId()).toBe(originalThread);

      const snapshots = await drain(engine);
      expect(snapshots.at(-1)?.done).toBe(true);
      expect(snapshots.at(-1)?.text.length).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it("summarizes into a brief with usage attached", async () => {
    const engine = makeEngine({ LIVECAP_FAKE_CODEX_REPLY: "A running summary line." });
    await engine.start();
    try {
      const brief = await engine.summarize("speaker: hello");
      expect(typeof brief.summary).toBe("string");
      expect(Array.isArray(brief.board)).toBe(true);
      expect(brief.usage.turnCostUsd).toBe(0);
    } finally {
      await engine.stop();
    }
  });
});
