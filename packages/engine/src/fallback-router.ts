// Loss-free engine router (issue #7). Presents one TranslationEngine that
// delegates to an active engine and can switch to the fallback mid-meeting
// WITHOUT losing the in-flight batch: each translate()/summarize() call binds to
// whichever engine is active at call time, so a batch already streaming on the
// primary completes on the primary while the NEXT batch goes to the fallback.
//
// Pair with CreditAccountant: on an "engine-switch" event, call switchToFallback().

import type {
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
}

export class FallbackRouter implements TranslationEngine {
  private readonly primary: TranslationEngine;
  private readonly fallback: TranslationEngine;
  private active: TranslationEngine;
  private usingFallback = false;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(options: FallbackRouterOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.active = options.primary;
  }

  /** True once the router has switched to the fallback engine. */
  get onFallback(): boolean {
    return this.usingFallback;
  }

  async start(): Promise<void> {
    // Start whichever engine is active — normally the primary, but if a switch
    // happened without an intervening stop() this keeps routing consistent.
    await this.active.start();
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribers.splice(0)) off();
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

  /** Subscribe to usage from BOTH engines, so accounting is continuous across a switch. */
  onUsage(listener: (usage: Usage) => void): () => void {
    const offPrimary = this.primary.onUsage(listener);
    const offFallback = this.fallback.onUsage(listener);
    const off = () => {
      offPrimary();
      offFallback();
    };
    this.unsubscribers.push(off);
    return off;
  }
}
