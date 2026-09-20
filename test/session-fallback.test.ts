// Exercise the actual HostSession, routers and runner. Only process-backed
// engines/detection are test doubles; no CLI, model, credentials or network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EngineHealthEvent, EngineStatus, Sentence, Translation, Usage,
} from "@livecap/engine";

import { HostSession } from "../src/host/session";
import type { HostInbound, HostOutbound } from "../src/protocol";

const engines = vi.hoisted(() => ({ primaries: [] as FakeCli[], local: null as FakeLocal | null }));

vi.mock("@livecap/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livecap/engine")>();
  return {
    ...actual,
    ClaudeCliEngine: vi.fn(function () {
      const engine = new FakeCli();
      engines.primaries.push(engine);
      return engine;
    }),
  };
});
vi.mock("../src/host/detect-cli", () => ({
  detectClaudeCli: async () => ({ bin: "test-cli", includePartialMessages: true }),
  detectCodexCli: async () => null,
}));
vi.mock("../src/host/local-tier", () => ({
  LazyLocalEngine: vi.fn(function () {
    engines.local = new FakeLocal();
    return engines.local;
  }),
}));

const USAGE: Usage = {
  cumulativeCostUsd: 0, turnCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
};
const PRIVATE_CAPTION = "private caption must never appear in status";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeCli {
  status: EngineStatus = "stopped";
  readonly turn = deferred();
  failed = false;
  translateCalls: string[][] = [];
  private listeners: ((event: EngineHealthEvent) => void)[] = [];
  async start() { this.status = "ready"; }
  async stop() { this.status = "stopped"; }
  dispose() { this.status = "stopped"; }
  health() { return { status: this.status }; }
  onHealthEvent(listener: (event: EngineHealthEvent) => void) { this.listeners.push(listener); }
  healthEvent(event: EngineHealthEvent) { for (const listener of this.listeners) listener(event); }
  onUsage() { return () => undefined; }
  async summarize() { return { summary: "", board: [], usage: USAGE }; }
  async complete() { return { text: "{}", usage: USAGE }; }
  async *translate(batch: Sentence[]): AsyncIterable<Translation> {
    const sentenceIds = batch.map((sentence) => sentence.id);
    this.translateCalls.push(sentenceIds);
    yield { sentenceIds, text: "primary partial", done: false };
    await this.turn.promise;
    if (this.failed) {
      this.status = "error";
      // Like the FIRST real CLI exit: error health, without a degraded event.
      throw new Error("cli exited (code=null, signal=SIGKILL)");
    }
    yield { sentenceIds, text: "primary final", done: true };
  }
  crash() { this.failed = true; this.turn.resolve(); }
}

class FakeLocal extends FakeCli {
  readonly readiness = deferred();
  startCalls = 0;
  private starting: Promise<void> | null = null;
  override async start() {
    this.starting ??= (async () => {
      this.startCalls += 1;
      this.status = "starting";
      await this.readiness.promise;
      this.status = "ready";
    })();
    await this.starting;
  }
  override async *translate(batch: Sentence[]): AsyncIterable<Translation> {
    const sentenceIds = batch.map((sentence) => sentence.id);
    this.translateCalls.push(sentenceIds);
    yield { sentenceIds, text: "local partial", done: false };
    yield { sentenceIds, text: "local final", done: true };
  }
}

let session: HostSession;
let events: HostOutbound[];
let dir: string;

async function start(autoSwitch = true) {
  const message: Extract<HostInbound, { type: "start" }> = {
    type: "start", appDataDir: dir, archiveDir: dir,
    targetLanguageCode: "ko", sourceLanguageCode: "auto", enginePref: "cli",
    claudeModel: "haiku", translationMode: "relaxed", poolUsd: 20, resetDay: 1,
    autoSwitch, archiveAutoSave: false, archiveRetentionDays: 0,
    captureSystem: true, captureMic: true,
  };
  await session.handle(message);
  expect(events.some((event) => event.type === "ready")).toBe(true);
}

async function caption() {
  await session.handle({
    type: "caption", id: 1, channel: "them", text: PRIVATE_CAPTION,
    lowConfidence: false, epochMs: Date.now(), durationMs: 1000,
  });
  await settle();
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }
function switches() { return events.filter((event) => event.type === "engineSwitch"); }
function statuses() {
  return events.filter((event) => event.type === "status").map((event) => event.detail);
}
function finals() { return events.filter((event) => event.type === "translation" && event.done); }

beforeEach(() => {
  vi.useFakeTimers();
  engines.primaries = [];
  engines.local = null;
  dir = mkdtempSync(join(tmpdir(), "livecap-fallback-"));
  events = [];
  session = new HostSession((event) => events.push(event));
});
afterEach(async () => {
  session.dispose();
  engines.local?.readiness.resolve();
  await settle();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("HostSession hard-exit fallback (#218)", () => {
  it("recovers the first CLI exit once, waits through cold readiness, and reports measured delay", async () => {
    await start();
    expect(engines.local!.startCalls).toBe(0);
    await caption();
    engines.primaries[0].crash();
    await settle();
    expect(engines.local!.startCalls).toBe(1);
    expect(statuses()).toContain("starting local fallback…");
    expect(switches()).toHaveLength(0);
    expect(finals()).toHaveLength(0);
    expect(events.filter((event) => event.type === "translationFailed")).toHaveLength(0);
    // Deterministic 11.6 s cold-start window, matching the retained #115
    // measurement. This is a clock-controlled delay, not new hardware timing.
    await vi.advanceTimersByTimeAsync(11_600);
    engines.local!.readiness.resolve();
    await settle();
    expect(statuses()).toContain("local fallback ready (11600 ms)");
    expect(switches()).toHaveLength(1);
    expect(finals()).toEqual([{ type: "translation", items: [{ id: 1, text: "local final" }], done: true }]);
    expect(engines.primaries[0].translateCalls).toEqual([["1"]]);
    expect(engines.local!.translateCalls).toEqual([["1"]]);
    expect(statuses().join(" ")).not.toContain(PRIVATE_CAPTION);
  });

  it("honors autoSwitch:false on the first exit and preserves explicit retranslation", async () => {
    await start(false);
    await caption();
    engines.primaries[0].crash();
    await settle();
    expect(statuses()).toContain("translation engine unresponsive");
    expect(statuses().join(" ")).not.toContain(PRIVATE_CAPTION);
    expect(events.filter((event) => event.type === "translationFailed")).toHaveLength(1);
    engines.primaries[0].healthEvent({ kind: "degraded" });
    expect(engines.local!.startCalls).toBe(0);
    expect(switches()).toHaveLength(0);
    engines.primaries[0].failed = false;
    engines.primaries[0].status = "ready";
    await session.handle({ type: "retranslate", id: 1 });
    await settle();
    expect(finals()).toEqual([{ type: "translation", items: [{ id: 1, text: "primary final" }], done: true }]);
    expect(engines.local!.startCalls).toBe(0);
  });

  it("coalesces concurrent lane health signals and emits readiness exactly once", async () => {
    await start();
    engines.primaries[0].healthEvent({ kind: "degraded" });
    engines.primaries[1].healthEvent({ kind: "degraded" });
    engines.primaries[0].healthEvent({ kind: "degraded" });
    await settle();
    expect(engines.local!.startCalls).toBe(1);
    expect(statuses().filter((status) => status === "starting local fallback…")).toHaveLength(1);
    expect(switches()).toHaveLength(0);
    engines.local!.readiness.resolve();
    await settle();
    engines.primaries[1].healthEvent({ kind: "degraded" });
    await settle();
    expect(switches()).toHaveLength(1);
  });

  it("explicitly fails a held batch when fallback startup fails and never announces a switch", async () => {
    await start();
    await caption();
    engines.primaries[0].crash();
    await settle();
    engines.local!.readiness.reject(new Error(PRIVATE_CAPTION));
    await settle();
    expect(statuses()).toContain("local fallback unavailable");
    expect(statuses().join(" ")).not.toContain(PRIVATE_CAPTION);
    expect(switches()).toHaveLength(0);
    expect(finals()).toHaveLength(0);
    expect(events.filter((event) => event.type === "translationFailed")).toHaveLength(1);
    expect(engines.local!.translateCalls).toHaveLength(0);
  });

  it("does not announce a late switch when the session stops during cold startup", async () => {
    await start();
    engines.primaries[0].healthEvent({ kind: "degraded" });
    await settle();
    await session.handle({ type: "stop" });
    engines.local!.readiness.resolve();
    await settle();
    expect(events.some((event) => event.type === "stopped")).toBe(true);
    expect(switches()).toHaveLength(0);
    expect(statuses().some((status) => status.startsWith("local fallback ready"))).toBe(false);
  });

  it("turns a wedged fallback start into an explicit batch failure and ignores late readiness", async () => {
    await start();
    await caption();
    engines.primaries[0].crash();
    await settle();
    expect(engines.local!.startCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(statuses()).toContain("local fallback unavailable");
    expect(events.filter((event) => event.type === "translationFailed")).toHaveLength(1);
    expect(switches()).toHaveLength(0);
    engines.local!.readiness.resolve();
    await settle();
    expect(engines.local!.health().status).toBe("stopped");
    expect(engines.local!.translateCalls).toHaveLength(0);
    expect(finals()).toHaveLength(0);
    expect(switches()).toHaveLength(0);
  });
});
