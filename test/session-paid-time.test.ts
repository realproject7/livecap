// Real host, routers and credit ledger; only process-backed engines/detection
// are doubled. Every session uses an isolated ledger and a controlled clock.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditAccountant, nodeLedgerFs } from "@livecap/engine";
import type {
  EngineHealthEvent, EngineStatus, Sentence, Translation, Usage,
} from "@livecap/engine";

import { HostSession } from "../src/host/session";
import type { EnginePref, HostInbound, HostOutbound } from "../src/protocol";

const engines = vi.hoisted(() => ({
  primaries: [] as FakePaid[], local: null as FakeLocal | null, cliAvailable: true,
}));

vi.mock("@livecap/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livecap/engine")>();
  const create = () => {
    const engine = new FakePaid();
    engines.primaries.push(engine);
    return engine;
  };
  return {
    ...actual,
    ClaudeCliEngine: vi.fn(function () { return create(); }),
    CodexAppServerEngine: vi.fn(function () { return create(); }),
  };
});
vi.mock("../src/host/detect-cli", () => ({
  detectClaudeCli: async () => engines.cliAvailable ? { bin: "test-cli", includePartialMessages: true } : null,
  detectCodexCli: async () => engines.cliAvailable ? { bin: "test-codex" } : null,
}));
vi.mock("../src/host/local-tier", () => ({
  LazyLocalEngine: vi.fn(function () {
    engines.local = new FakeLocal();
    return engines.local;
  }),
}));

const HOUR = 3_600_000;
const MINUTE = 60_000;
const USAGE: Usage = {
  cumulativeCostUsd: 0, turnCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakePaid {
  status: EngineStatus = "stopped";
  startCalls = 0;
  translationTurn: ReturnType<typeof deferred> | null = null;
  completionTurn: ReturnType<typeof deferred> | null = null;
  nextTranslationCost = 0;
  nextCompletionCost = 0;
  private readonly usages = new Set<(usage: Usage) => void>();
  private readonly healthListeners = new Set<(event: EngineHealthEvent) => void>();
  async start() { this.startCalls += 1; this.status = "ready"; }
  async stop() { this.status = "stopped"; }
  dispose() { this.status = "stopped"; }
  health() { return { status: this.status }; }
  async readRateLimits() { return null; }
  onHealthEvent(listener: (event: EngineHealthEvent) => void) { this.healthListeners.add(listener); }
  degrade() { for (const listener of this.healthListeners) listener({ kind: "degraded" }); }
  onUsage(listener: (usage: Usage) => void) {
    this.usages.add(listener);
    return () => { this.usages.delete(listener); };
  }
  emitUsage(turnCostUsd: number) {
    const usage = { ...USAGE, turnCostUsd };
    for (const listener of this.usages) listener(usage);
    return usage;
  }
  async summarize() { return { summary: "", board: [], usage: USAGE }; }
  async complete() {
    const cost = this.nextCompletionCost;
    this.nextCompletionCost = 0;
    await this.completionTurn?.promise;
    return { text: "{}", usage: this.emitUsage(cost) };
  }
  async *translate(batch: Sentence[]): AsyncIterable<Translation> {
    const cost = this.nextTranslationCost;
    this.nextTranslationCost = 0;
    const sentenceIds = batch.map((sentence) => sentence.id);
    yield { sentenceIds, text: "partial", done: false };
    await this.translationTurn?.promise;
    this.emitUsage(cost);
    yield { sentenceIds, text: "final", done: true };
  }
}

class FakeLocal extends FakePaid {
  readonly readiness = deferred();
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
}

let session: HostSession;
let events: HostOutbound[];
let dir: string;

function accountant() {
  return new CreditAccountant({
    fs: nodeLedgerFs(), ledgerPath: join(dir, "credit-ledger.json"), poolUsd: 20, now: Date.now,
  });
}
function ledger() {
  return JSON.parse(readFileSync(join(dir, "credit-ledger.json"), "utf8")) as {
    spentUsd: number; meteredMs: number;
  };
}
function seed(spentUsd = 1) {
  const account = accountant();
  account.recordCost(spentUsd);
  account.recordMeetingTime(HOUR);
  return account.gauge();
}
async function start(enginePref: EnginePref = "cli", autoSwitch = true, localAtStart = false) {
  const message: Extract<HostInbound, { type: "start" }> = {
    type: "start", appDataDir: dir, archiveDir: dir,
    targetLanguageCode: "ko", sourceLanguageCode: "auto", enginePref,
    claudeModel: "haiku", translationMode: "relaxed", poolUsd: 20, resetDay: 1,
    autoSwitch, archiveAutoSave: false, archiveRetentionDays: 0,
    captureSystem: true, captureMic: true,
  };
  const starting = session.handle(message);
  await settle();
  if (localAtStart) engines.local!.readiness.resolve();
  await starting;
  expect(events.some((event) => event.type === "ready")).toBe(true);
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }
function elapse(ms: number) { vi.setSystemTime(Date.now() + ms); }
function switches() { return events.filter((event) => event.type === "engineSwitch"); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  engines.primaries = [];
  engines.local = null;
  engines.cliAvailable = true;
  dir = mkdtempSync(join(tmpdir(), "livecap-paid-time-"));
  events = [];
  session = new HostSession((event) => events.push(event));
});
afterEach(async () => {
  session.dispose();
  engines.local?.readiness.resolve();
  for (const engine of engines.primaries) {
    engine.translationTurn?.resolve();
    engine.completionTurn?.resolve();
  }
  await settle();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("HostSession paid meeting time (#219)", () => {
  it.each([
    ["explicit Local", "local", true],
    ["absent Claude CLI", "cli", false],
    ["absent Codex CLI", "codex", false],
  ] as const)("keeps the nonzero paid ledger unchanged for %s", async (_name, pref, available) => {
    const before = seed();
    expect(before.dollarsPerHour).toBe(1);
    expect(before.estimatedHoursRemaining).toBe(19);
    engines.cliAvailable = available;
    await start(pref, true, true);
    elapse(15 * MINUTE);
    engines.local!.emitUsage(0);
    await session.handle({ type: "stop" });
    expect(accountant().gauge()).toEqual(before);
    expect(ledger().meteredMs).toBe(HOUR);
    expect(accountant().isBelowThreshold()).toBe(false);
  });

  it("does not meter routers that start on Local or clear their low-headroom decision", async () => {
    const before = seed(7);
    expect(accountant().isBelowThreshold()).toBe(true);
    await start("cli", true, true);
    expect(engines.primaries.map((engine) => engine.startCalls)).toEqual([0, 0]);
    expect(switches()).toHaveLength(1);
    elapse(15 * MINUTE);
    engines.local!.emitUsage(0);
    await session.handle({ type: "stop" });
    expect(accountant().gauge()).toEqual(before);
    expect(ledger().meteredMs).toBe(HOUR);
    expect(accountant().isBelowThreshold()).toBe(true);
  });

  it.each(["cli", "codex"] as const)("preserves paid-only time and both lanes' usage for %s", async (pref) => {
    seed();
    await start(pref, false);
    const cost = pref === "cli" ? 0.25 : 0;
    engines.primaries[0].emitUsage(cost);
    engines.primaries[1].emitUsage(cost);
    elapse(15 * MINUTE);
    await session.handle({ type: "stop" });
    expect(ledger()).toMatchObject({ spentUsd: 1 + 2 * cost, meteredMs: HOUR + 15 * MINUTE });
    expect(engines.local!.startCalls).toBe(0);
    expect(switches()).toHaveLength(0);
  });

  it("cuts time at successful readiness and counts healthy paid in-flight work on both lanes once", async () => {
    seed();
    await start();
    const [translation, extras] = engines.primaries;
    translation.translationTurn = deferred();
    translation.nextTranslationCost = 0.2;
    extras.completionTurn = deferred();
    extras.nextCompletionCost = 0.3;
    await session.handle({
      type: "caption", id: 1, channel: "them", text: "test caption",
      lowConfidence: false, epochMs: Date.now(), durationMs: 1000,
    });
    await session.handle({ type: "quickTranslate", id: 2, text: "test request" });
    await settle();
    elapse(10 * MINUTE);
    translation.degrade();
    extras.degrade();
    translation.degrade();
    await settle();
    elapse(30_000);
    engines.local!.readiness.resolve();
    await settle();
    expect(switches()).toHaveLength(1);
    expect(engines.local!.startCalls).toBe(1);
    elapse(5 * MINUTE);
    translation.translationTurn.resolve();
    extras.completionTurn.resolve();
    await settle();
    expect(events.filter((event) => event.type === "translation" && event.done)).toHaveLength(1);
    expect(events.filter((event) => event.type === "quickTranslateResult")).toHaveLength(1);
    expect(ledger().spentUsd).toBeCloseTo(1.5);
    extras.degrade();
    elapse(10 * MINUTE);
    engines.local!.emitUsage(0);
    await session.handle({ type: "stop" });
    expect(ledger()).toMatchObject({ spentUsd: 1.5, meteredMs: HOUR + 10 * MINUTE + 30_000 });
    const after = accountant().gauge();
    expect(after.dollarsPerHour).toBeCloseTo(1.5 / 1.175);
    expect(after.estimatedHoursRemaining).toBeCloseTo(18.5 / (1.5 / 1.175));
    await session.handle({ type: "stop" });
    session.dispose();
    session.dispose();
    await session.handle({ type: "stop" });
    expect(accountant().gauge()).toEqual(after);
    expect(switches()).toHaveLength(1);
  });

  it("continues paid metering after fallback readiness fails", async () => {
    seed();
    await start();
    elapse(10 * MINUTE);
    engines.primaries[0].degrade();
    await settle();
    elapse(30_000);
    engines.local!.readiness.reject(new Error("test startup failure"));
    await settle();
    expect(switches()).toHaveLength(0);
    expect(events).toContainEqual({ type: "status", detail: "local fallback unavailable" });
    elapse(5 * MINUTE);
    engines.primaries[0].emitUsage(0.2);
    engines.primaries[1].emitUsage(0.3);
    await session.handle({ type: "stop" });
    expect(ledger()).toMatchObject({ spentUsd: 1.5, meteredMs: HOUR + 15 * MINUTE + 30_000 });
  });

  it("meters through stop once when Local is still starting, and ignores late readiness", async () => {
    seed();
    await start();
    elapse(10 * MINUTE);
    engines.primaries[0].degrade();
    await settle();
    await session.handle({ type: "stop" });
    const stopped = ledger();
    expect(stopped.meteredMs).toBe(HOUR + 10 * MINUTE);
    elapse(5 * MINUTE);
    engines.local!.readiness.resolve();
    await settle();
    await session.handle({ type: "stop" });
    session.dispose();
    expect(ledger()).toEqual(stopped);
    expect(switches()).toHaveLength(0);
  });
});
