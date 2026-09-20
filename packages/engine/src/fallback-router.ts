// Loss-free engine router (issue #7). Presents one TranslationEngine that
// delegates to an active engine and can switch to the fallback mid-meeting
// WITHOUT losing the in-flight batch: each translate()/summarize() call binds to
// whichever engine is active at call time, so a batch already streaming on the
// primary completes on the primary while the NEXT batch goes to the fallback.
//
// Pair with CreditAccountant two ways: at session start, set `startOnFallback`
// to accountant.isBelowThreshold so a relaunch while low begins on the fallback;
// during a session, route the "engine-switch" event to switchToFallback().
//
// After a switch the primary keeps running for the rest of the meeting (an idle
// CLI process is cheap) so in-flight batches stay loss-free — do not double-stop
// it externally; stop() handles both engines.

import type {
  Completion,
  CompletionRequest,
  EngineHealth,
  MeetingBrief,
  RollingContext,
  Sentence,
  Translation,
  TranslationEngine,
  Usage,
} from "./types";

export interface FallbackRouterOptions {
  primary: TranslationEngine;
  fallback: TranslationEngine;
  /** Pulled on start(): when it returns true the session begins on the fallback
   *  (e.g. credit already below threshold at launch). */
  startOnFallback?: () => boolean;
  /** Host-owned policy for an unresolved translation whose primary is in error.
   *  May enable fallback; omitting it never enables automatic switching. */
  onPrimaryFailure?: () => Promise<void> | void;
}

export class FallbackRouter implements TranslationEngine {
  private readonly primary: TranslationEngine;
  private readonly fallback: TranslationEngine;
  private active: TranslationEngine;
  private usingFallback = false;
  private switching: Promise<void> | null = null;
  private generation = 0;
  private stopped = false;

  private readonly startOnFallback?: () => boolean;
  private readonly onPrimaryFailure?: () => Promise<void> | void;

  constructor(options: FallbackRouterOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.active = options.primary;
    this.startOnFallback = options.startOnFallback;
    this.onPrimaryFailure = options.onPrimaryFailure;
  }

  /** True once the router has switched to the fallback engine. */
  get onFallback(): boolean {
    return this.usingFallback;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Begin on the fallback if credit is already low at launch (restart-while-
    // below) — this is what re-delivers the recommendation across a process
    // restart, where the accountant's per-crossing event would not re-fire.
    if (!this.usingFallback && this.startOnFallback?.()) {
      await this.switchToFallback();
      return;
    }
    // Otherwise start whichever engine is active — normally the primary, but if
    // a switch happened without an intervening stop() this keeps routing consistent.
    await this.active.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    const switching = this.switching;
    // onUsage subscriptions are durable until the caller invokes the unsubscribe
    // returned by onUsage() — NOT cleared here. Both engines keep their listeners
    // across stop(), so accounting (e.g. accountant.attach(router) once) keeps
    // working after a stop/start cycle (#38).
    // Stop both; the fallback may have been started on a switch. `allSettled` so
    // ONE engine's stop() rejecting can't skip the state reset below (#178): with
    // `Promise.all`, a rejection stranded `usingFallback = true`, and the next
    // session's start() would then silently route to the (stopped) fallback tier
    // even after credit recovered. Neither shipped engine's stop() rejects today,
    // but the TranslationEngine contract does not forbid it.
    const results = await Promise.allSettled([this.primary.stop(), this.fallback.stop()]);
    // A cold start can finish after stop() reached the still-unmaterialized
    // fallback. The switch's generation check tears that late engine down.
    await switching?.catch(() => undefined);
    // Reset routing UNCONDITIONALLY so the NEXT session begins on the primary
    // again, regardless of a partial stop() failure.
    this.active = this.primary;
    this.usingFallback = false;
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
  }

  /** Synchronous force-kill of both tiers' OS children (#66 process teardown). */
  dispose(): void {
    this.stopped = true;
    this.generation += 1;
    this.primary.dispose?.();
    this.fallback.dispose?.();
  }

  health(): EngineHealth {
    return this.active.health();
  }

  /**
   * Switch the active engine to the fallback. The fallback is started if needed;
   * once active, NEW translate/summarize calls route to it. Idempotent.
   */
  switchToFallback(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("engine router stopped"));
    if (this.usingFallback) return Promise.resolve();
    if (this.switching) return this.switching;
    const generation = this.generation;
    this.switching = (async () => {
      if (this.fallback.health().status !== "ready") await this.fallback.start();
      if (generation !== this.generation) {
        await this.fallback.stop();
        throw new Error("fallback switch cancelled");
      }
      if (this.fallback.health().status !== "ready") throw new Error("local fallback did not become ready");
      this.active = this.fallback;
      this.usingFallback = true;
    })().finally(() => { this.switching = null; });
    return this.switching;
  }

  translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
    // Bind healthy in-flight work at call time. New work during a cold switch
    // waits for readiness instead of going back to the failed primary.
    return this.translateOn(this.active, this.switching, this.generation, batch, ctx);
  }

  private async *translateOn(
    engine: TranslationEngine,
    switching: Promise<void> | null,
    generation: number,
    batch: Sentence[],
    ctx: RollingContext,
  ): AsyncIterable<Translation> {
    if (switching) {
      await switching;
      engine = this.fallback;
    }
    if (generation !== this.generation || this.stopped) throw new Error("engine router stopped");
    let finalized = false;
    try {
      for await (const snapshot of engine.translate(batch, ctx)) {
        finalized ||= snapshot.done;
        yield snapshot;
      }
    } catch (error) {
      // A yielded final is already delivered. Never replay it or turn a late
      // stream teardown error into a second completion/failure for that batch.
      if (finalized) return;
      if (engine !== this.primary || generation !== this.generation || this.stopped) throw error;
      if (this.primary.health().status === "error") await this.onPrimaryFailure?.();
      await this.switching;
      if (!this.usingFallback || generation !== this.generation || this.stopped) throw error;
      // Snapshots replace the prior partial for the same sentence ids. There is
      // just one replay; a fallback failure propagates to the explicit retry UI.
      yield* this.fallback.translate(batch, ctx);
    }
  }

  summarize(transcript: string): Promise<MeetingBrief> {
    return this.active.summarize(transcript);
  }

  complete(request: CompletionRequest): Promise<Completion> {
    return this.active.complete(request);
  }

  /**
   * Subscribe to usage from BOTH engines, so accounting is continuous across a
   * switch AND across a stop/start cycle. The subscription is durable until the
   * returned unsubscribe is called — `stop()` does not clear it (#38).
   */
  onUsage(listener: (usage: Usage) => void): () => void {
    const offPrimary = this.primary.onUsage(listener);
    const offFallback = this.fallback.onUsage(listener);
    return () => {
      offPrimary();
      offFallback();
    };
  }
}
