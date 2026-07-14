import { describe, it, expect } from "vitest";

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

describe("FallbackRouter", () => {
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
