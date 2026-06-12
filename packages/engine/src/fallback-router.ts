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
}

export class FallbackRouter implements TranslationEngine {
  private readonly primary: TranslationEngine;
  private readonly fallback: TranslationEngine;
  private active: TranslationEngine;
  private usingFallback = false;

  private readonly startOnFallback?: () => boolean;

  constructor(options: FallbackRouterOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.active = options.primary;
    this.startOnFallback = options.startOnFallback;
  }

  /** True once the router has switched to the fallback engine. */
  get onFallback(): boolean {
    return this.usingFallback;
  }

  async start(): Promise<void> {
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
    // onUsage subscriptions are durable until the caller invokes the unsubscribe
    // returned by onUsage() — NOT cleared here. Both engines keep their listeners
    // across stop(), so accounting (e.g. accountant.attach(router) once) keeps
    // working after a stop/start cycle (#38).
    // Stop both; the fallback may have been started on a switch.
    await Promise.all([this.primary.stop(), this.fallback.stop()]);
    // Reset routing so the NEXT session begins on the primary again — otherwise
    // a Stop/Start after an auto-fallback would route to the stopped fallback.
    this.active = this.primary;
    this.usingFallback = false;
  }

  health(): EngineHealth {
    return this.active.health();
  }

  /**
   * Switch the active engine to the fallback. The fallback is started if needed;
   * once active, NEW translate/summarize calls route to it. Idempotent.
   */
  async switchToFallback(): Promise<void> {
    if (this.usingFallback) return;
    if (this.fallback.health().status !== "ready") await this.fallback.start();
    this.active = this.fallback;
    this.usingFallback = true;
  }

  translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
    // Bind to the active engine at call time → in-flight batches finish on it.
    return this.active.translate(batch, ctx);
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
