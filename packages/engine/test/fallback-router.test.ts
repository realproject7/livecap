import { afterEach, describe, it, expect, vi } from "vitest";

import { FallbackRouter } from "../src/fallback-router";
import type {
  Completion,
  CompletionRequest,
  EngineHealth,
  EngineStatus,
  MeetingBrief,
  Sentence,
  Translation,
  TranslationEngine,
  Usage,
} from "../src/types";

const ZERO_USAGE: Usage = {
  cumulativeCostUsd: 0,
  turnCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
};

/** In-memory engine; translate yields a partial, then a final after `gate`. */
class StubEngine implements TranslationEngine {
  status: EngineStatus = "stopped";
  startCalls = 0;
  translateCalls = 0;
  private usageListeners = new Set<(u: Usage) => void>();

  constructor(
    readonly label: string,
    private readonly gate?: Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    this.status = "ready";
  }
  async stop(): Promise<void> {
    this.status = "stopped";
  }
  health(): EngineHealth {
    return { status: this.status };
  }
  async *translate(batch: Sentence[]): AsyncIterable<Translation> {
    this.translateCalls += 1;
    const ids = batch.map((s) => s.id);
    yield { sentenceIds: ids, text: `${this.label}:partial`, done: false };
    if (this.gate) await this.gate;
    yield { sentenceIds: ids, text: `${this.label}:final`, done: true };
  }
  async summarize(): Promise<MeetingBrief> {
    return { summary: this.label, board: [], usage: ZERO_USAGE };
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    return { text: `${this.label}:${request.user}`, usage: ZERO_USAGE };
  }
  onUsage(listener: (u: Usage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }
  emitUsage(): void {
    for (const l of this.usageListeners) l({ ...ZERO_USAGE, turnCostUsd: 0.1 });
  }
}

const batch: Sentence[] = [{ id: "s1", text: "hello", seq: 1 }];

async function collect(stream: AsyncIterable<Translation>): Promise<Translation[]> {
  const out: Translation[] = [];
  for await (const t of stream) out.push(t);
  return out;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class HardExitEngine extends StubEngine {
  readonly exit = deferred();
  finalBeforeExit = false;

  override async *translate(batch: Sentence[]): AsyncIterable<Translation> {
    this.translateCalls += 1;
    yield { sentenceIds: batch.map((s) => s.id), text: "primary:snapshot", done: this.finalBeforeExit };
    await this.exit.promise;
    this.status = "error";
    throw new Error("cli exited (code=null, signal=SIGKILL)");
  }
}

class ColdEngine extends StubEngine {
  readonly readiness = deferred();

  override async start(): Promise<void> {
    this.startCalls += 1;
    this.status = "starting";
    await this.readiness.promise;
    this.status = "ready";
  }
}

afterEach(() => { vi.useRealTimers(); });

describe("FallbackRouter", () => {
  it("replays an unresolved primary hard exit exactly once after cold fallback readiness", async () => {
    const primary = new HardExitEngine("primary");
    const fallback = new ColdEngine("fallback");
    const router = new FallbackRouter({ primary, fallback, onPrimaryFailure: (): Promise<void> => router.switchToFallback() });
    await router.start();
    const inFlight = router.translate(batch, { pairs: [] })[Symbol.asyncIterator]();
    expect((await inFlight.next()).value).toMatchObject({ text: "primary:snapshot", done: false });
    primary.exit.resolve();
    const recovering = inFlight.next();
    await vi.waitFor(() => expect(fallback.startCalls).toBe(1));
    expect(router.onFallback).toBe(false);
    expect(fallback.translateCalls).toBe(0);
    fallback.readiness.resolve();
    expect((await recovering).value).toMatchObject({ sentenceIds: ["s1"], text: "fallback:partial", done: false });
    expect((await inFlight.next()).value).toMatchObject({ sentenceIds: ["s1"], text: "fallback:final", done: true });
    expect((await inFlight.next()).done).toBe(true);
    expect(primary.translateCalls).toBe(1);
    expect(fallback.translateCalls).toBe(1);
  });

  it("holds new batches behind a pending cold switch and coalesces concurrent switches", async () => {
    const primary = new StubEngine("primary");
    const fallback = new ColdEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();
    const switching = router.switchToFallback();
    const alsoSwitching = router.switchToFallback();
    const translated = collect(router.translate(batch, { pairs: [] }));
    expect(fallback.startCalls).toBe(1);
    expect(primary.translateCalls).toBe(0);
    expect(fallback.translateCalls).toBe(0);
    fallback.readiness.resolve();
    await Promise.all([switching, alsoSwitching]);
    expect((await translated).at(-1)?.text).toBe("fallback:final");
    expect(primary.translateCalls).toBe(0);
    expect(fallback.translateCalls).toBe(1);
  });

  it("does not enable fallback without a host policy or an explicit switch", async () => {
    const primary = new HardExitEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();
    const translated = collect(router.translate(batch, { pairs: [] }));
    primary.exit.resolve();
    await expect(translated).rejects.toThrow("cli exited");
    expect(fallback.startCalls).toBe(0);
    expect(fallback.translateCalls).toBe(0);
    // An explicit recovery remains possible after the rejected batch.
    await router.switchToFallback();
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.done).toBe(true);
  });

  it("never replays or fails a batch after yielding its final snapshot", async () => {
    const primary = new HardExitEngine("primary");
    primary.finalBeforeExit = true;
    const fallback = new StubEngine("fallback");
    const onPrimaryFailure = vi.fn();
    const router = new FallbackRouter({ primary, fallback, onPrimaryFailure });
    await router.start();
    const translated = collect(router.translate(batch, { pairs: [] }));
    await router.switchToFallback();
    primary.exit.resolve();
    expect(await translated).toEqual([{ sentenceIds: ["s1"], text: "primary:snapshot", done: true }]);
    expect(fallback.translateCalls).toBe(0);
    expect(onPrimaryFailure).not.toHaveBeenCalled();
  });

  it("propagates a fallback replay failure once without another replay", async () => {
    const primary = new HardExitEngine("primary");
    const fallback = new HardExitEngine("fallback");
    const router = new FallbackRouter({ primary, fallback, onPrimaryFailure: (): Promise<void> => router.switchToFallback() });
    await router.start();
    const translated = collect(router.translate(batch, { pairs: [] }));
    primary.exit.resolve();
    fallback.exit.resolve();
    await expect(translated).rejects.toThrow("cli exited");
    expect(primary.translateCalls).toBe(1);
    expect(fallback.translateCalls).toBe(1);
  });

  it("keeps a replayed fallback final successful when its stream later throws", async () => {
    const primary = new HardExitEngine("primary");
    const fallback = new HardExitEngine("fallback");
    fallback.finalBeforeExit = true;
    const router = new FallbackRouter({ primary, fallback, onPrimaryFailure: (): Promise<void> => router.switchToFallback() });
    await router.start();
    const translated = collect(router.translate(batch, { pairs: [] }));
    primary.exit.resolve();
    fallback.exit.resolve();
    await expect(translated).resolves.toEqual([
      { sentenceIds: ["s1"], text: "primary:snapshot", done: false },
      { sentenceIds: ["s1"], text: "primary:snapshot", done: true },
    ]);
    expect(primary.translateCalls).toBe(1);
    expect(fallback.translateCalls).toBe(1);
  });

  it("times out an unresponsive cold start, fails retained work, and reaps late readiness", async () => {
    vi.useFakeTimers();
    const primary = new HardExitEngine("primary");
    const fallback = new ColdEngine("fallback");
    const router = new FallbackRouter({
      primary, fallback, fallbackStartTimeoutMs: 500,
      onPrimaryFailure: (): Promise<void> => router.switchToFallback(),
    });
    await router.start();
    const inFlight = router.translate(batch, { pairs: [] })[Symbol.asyncIterator]();
    await inFlight.next();
    primary.exit.resolve();
    let settled = false;
    const recovery = inFlight.next().finally(() => { settled = true; });
    const failed = expect(recovery).rejects.toThrow("local fallback startup timed out");
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback.startCalls).toBe(1);
    const queued = expect(collect(router.translate(batch, { pairs: [] }))).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await Promise.all([failed, queued]);
    expect(router.onFallback).toBe(false);
    expect(fallback.translateCalls).toBe(0);
    // No second start can race the timed-out operation's eventual cleanup.
    await expect(router.switchToFallback()).rejects.toThrow("still stopping");
    expect(fallback.startCalls).toBe(1);
    fallback.readiness.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback.health().status).toBe("stopped");
    expect(router.onFallback).toBe(false);
    expect(fallback.translateCalls).toBe(0);
    // Once cleanup finished, a deliberate retry can start a fresh attempt.
    await router.switchToFallback();
    expect(router.onFallback).toBe(true);
    expect(fallback.startCalls).toBe(2);
  });

  it.each(["stop", "dispose"] as const)("%s settles a never-ready switch promptly and reaps late startup", async (action) => {
    vi.useFakeTimers();
    const primary = new HardExitEngine("primary");
    const fallback = new ColdEngine("fallback");
    const router = new FallbackRouter({ primary, fallback, onPrimaryFailure: (): Promise<void> => router.switchToFallback() });
    await router.start();
    const inFlight = router.translate(batch, { pairs: [] })[Symbol.asyncIterator]();
    await inFlight.next();
    let switchSettled = false;
    const switching = router.switchToFallback().finally(() => { switchSettled = true; });
    const cancelled = expect(switching).rejects.toThrow("fallback switch cancelled");
    primary.exit.resolve();
    let recoverySettled = false;
    const recovery = inFlight.next().finally(() => { recoverySettled = true; });
    const recoveryFailed = expect(recovery).rejects.toThrow("fallback switch cancelled");
    let translationSettled = false;
    const translated = collect(router.translate(batch, { pairs: [] })).finally(() => { translationSettled = true; });
    const failed = expect(translated).rejects.toThrow("fallback switch cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverySettled).toBe(false);
    let stopSettled = false;
    const stopped = Promise.resolve(router[action]()).then(() => { stopSettled = true; });
    // No deadline or readiness advance: all callers must settle on cancellation.
    await vi.advanceTimersByTimeAsync(0);
    expect(stopSettled).toBe(true);
    expect(switchSettled).toBe(true);
    expect(recoverySettled).toBe(true);
    expect(translationSettled).toBe(true);
    await Promise.all([cancelled, recoveryFailed, failed, stopped]);
    fallback.readiness.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(router.onFallback).toBe(false);
    expect(fallback.health().status).toBe("stopped");
    expect(fallback.translateCalls).toBe(0);
  });

  it("leaves failed startup explicit and permits a later switch retry", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const start = vi.spyOn(fallback, "start").mockRejectedValueOnce(new Error("startup failed"));
    const router = new FallbackRouter({ primary, fallback });
    await router.start();
    await expect(router.switchToFallback()).rejects.toThrow("startup failed");
    expect(router.onFallback).toBe(false);
    await router.switchToFallback();
    expect(router.onFallback).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("cancels a cold switch on stop and tears down a late-started fallback", async () => {
    const primary = new StubEngine("primary");
    const fallback = new ColdEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();
    const switching = expect(router.switchToFallback()).rejects.toThrow("fallback switch cancelled");
    const stopped = router.stop();
    fallback.readiness.resolve();
    await Promise.all([switching, stopped]);
    expect(router.onFallback).toBe(false);
    expect(fallback.health().status).toBe("stopped");
    await router.start();
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("primary:final");
  });

  it("does not resurrect a failed in-flight batch after stop", async () => {
    const primary = new HardExitEngine("primary");
    const fallback = new StubEngine("fallback");
    const onPrimaryFailure = vi.fn();
    const router = new FallbackRouter({ primary, fallback, onPrimaryFailure });
    await router.start();
    const inFlight = router.translate(batch, { pairs: [] })[Symbol.asyncIterator]();
    await inFlight.next();
    await router.stop();
    primary.exit.resolve();
    await expect(inFlight.next()).rejects.toThrow("cli exited");
    expect(onPrimaryFailure).not.toHaveBeenCalled();
    expect(fallback.startCalls).toBe(0);
  });

  it("routes to the primary until switched, then to the fallback", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();

    expect(router.onFallback).toBe(false);
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("primary:final");

    await router.switchToFallback();
    expect(router.onFallback).toBe(true);
    expect(fallback.startCalls).toBe(1);
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("fallback:final");
  });

  it("completes an in-flight batch on the OLD engine after a mid-stream switch (loss-free)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const primary = new StubEngine("primary", gate);
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();

    // Start a batch on the primary and consume its first (partial) snapshot.
    const inFlight = router.translate(batch, { pairs: [] })[Symbol.asyncIterator]();
    expect((await inFlight.next()).value.text).toBe("primary:partial");

    // Switch mid-stream; the next batch must go to the fallback...
    await router.switchToFallback();
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("fallback:final");

    // ...but the in-flight batch finishes on the PRIMARY — nothing lost.
    release();
    expect((await inFlight.next()).value.text).toBe("primary:final");
    expect((await inFlight.next()).done).toBe(true);
  });

  it("is restart-safe after an auto-fallback: a new Stop/Start session begins on the primary", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });

    await router.start();
    await router.switchToFallback(); // this session crossed the threshold
    expect(router.onFallback).toBe(true);
    await router.stop();

    // Next captioning session: must start fresh on the primary, not the
    // stopped fallback.
    await router.start();
    expect(router.onFallback).toBe(false);
    expect(router.health().status).toBe("ready");
    expect(primary.health().status).toBe("ready");
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("primary:final");

    // And it can still switch again within the new session.
    await router.switchToFallback();
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("fallback:final");
  });

  it("resets routing even when one engine's stop() rejects (#178)", async () => {
    // A partial stop() failure must not strand the router on the fallback: the
    // NEXT session must still begin on the primary. The error still propagates.
    const primary = new StubEngine("primary");
    class FailStopEngine extends StubEngine {
      override async stop(): Promise<void> {
        throw new Error("fallback stop failed");
      }
    }
    const fallback = new FailStopEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });

    await router.start();
    await router.switchToFallback();
    expect(router.onFallback).toBe(true);

    // stop() rejects (fallback.stop threw) — but routing state is reset anyway.
    await expect(router.stop()).rejects.toThrow("fallback stop failed");
    expect(router.onFallback).toBe(false);

    // The next session starts on the PRIMARY, not the stopped fallback.
    await router.start();
    expect(router.onFallback).toBe(false);
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("primary:final");
  });

  it("begins on the fallback when startOnFallback() is true at launch (restart-while-below)", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback, startOnFallback: () => true });
    await router.start();

    expect(router.onFallback).toBe(true);
    expect(fallback.startCalls).toBe(1);
    expect(primary.startCalls).toBe(0);
    expect((await collect(router.translate(batch, { pairs: [] }))).at(-1)?.text).toBe("fallback:final");
  });

  it("begins on the primary when startOnFallback() is false", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback, startOnFallback: () => false });
    await router.start();
    expect(router.onFallback).toBe(false);
    expect(primary.startCalls).toBe(1);
    expect(fallback.startCalls).toBe(0);
  });

  it("a fallback SHARED by two routers stays lazy on start when neither begins on fallback (#136/#142 two-lane)", async () => {
    // The dedicated-lane wiring (#142) starts two routers that share ONE local
    // fallback. Starting both must NOT eagerly start the shared local while the
    // CLI primaries are healthy and there's budget — it stays lazy until a real
    // fallback (below-threshold-at-launch or a mid-session switch).
    const shared = new StubEngine("local");
    const translation = new FallbackRouter({ primary: new StubEngine("tP"), fallback: shared, startOnFallback: () => false });
    const extras = new FallbackRouter({ primary: new StubEngine("eP"), fallback: shared, startOnFallback: () => false });
    await Promise.all([translation, extras].map((r) => r.start()));
    expect(shared.startCalls).toBe(0); // never materialized
    expect(translation.onFallback).toBe(false);
    expect(extras.onFallback).toBe(false);
  });

  it("a fallback SHARED by two routers is started exactly once when both begin on fallback (below-threshold launch)", async () => {
    const shared = new StubEngine("local");
    const translation = new FallbackRouter({ primary: new StubEngine("tP"), fallback: shared, startOnFallback: () => true });
    const extras = new FallbackRouter({ primary: new StubEngine("eP"), fallback: shared, startOnFallback: () => true });
    await Promise.all([translation, extras].map((r) => r.start()));
    // Both converge on the one shared local; StubEngine.start is idempotent-safe,
    // and the health()==="ready" guard means the second switch skips re-starting.
    expect(shared.startCalls).toBe(1);
    expect(translation.onFallback && extras.onFallback).toBe(true);
  });

  it("switchToFallback is idempotent", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();
    await router.switchToFallback();
    await router.switchToFallback();
    expect(fallback.startCalls).toBe(1);
  });

  it("forwards usage from both engines so accounting is continuous across a switch", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    const seen: Usage[] = [];
    router.onUsage((u) => seen.push(u));

    primary.emitUsage();
    fallback.emitUsage();
    expect(seen).toHaveLength(2);
  });

  it("preserves onUsage subscriptions across a stop/start cycle (#38)", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    const seen: Usage[] = [];
    router.onUsage((u) => seen.push(u)); // wired once, like accountant.attach(router)

    await router.start();
    await router.stop();
    await router.start(); // a new captioning session

    primary.emitUsage(); // usage in the new session
    expect(seen).toHaveLength(1); // still wired (pre-fix: stop() unsubscribed → 0)
  });

  it("the onUsage unsubscribe still detaches from both engines", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    const seen: Usage[] = [];
    const off = router.onUsage((u) => seen.push(u));

    primary.emitUsage();
    off();
    primary.emitUsage();
    fallback.emitUsage();
    expect(seen).toHaveLength(1); // only the event before unsubscribe
  });

  it("reflects the active engine's health", async () => {
    const primary = new StubEngine("primary");
    const fallback = new StubEngine("fallback");
    const router = new FallbackRouter({ primary, fallback });
    await router.start();
    expect(router.health().status).toBe("ready");
    expect(fallback.health().status).toBe("stopped");
    await router.switchToFallback();
    expect(router.health().status).toBe("ready"); // fallback started on switch
  });
});
