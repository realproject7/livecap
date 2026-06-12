// Summary cadence (issue #9): drive the 60s summary/board refresh, backing off
// when the transcript hasn't changed so an idle meeting doesn't keep paying for
// identical summaries. Pure and clock-injected — no real timers — so the
// scheduling logic tests deterministically.

export interface SummaryCadenceOptions {
  /** Base interval between summaries (ms). Default 60_000. */
  baseMs?: number;
  /** Cap on the backed-off interval (ms). Default 300_000. */
  maxMs?: number;
  /** Multiplier applied each time the transcript is unchanged. Default 2. */
  backoffFactor?: number;
}

export class SummaryCadence {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly backoffFactor: number;

  private lastRunAt: number | null = null;
  private lastTranscript: string | null = null;
  private intervalMs: number;

  constructor(options: SummaryCadenceOptions = {}) {
    this.baseMs = options.baseMs ?? 60_000;
    this.maxMs = options.maxMs ?? 300_000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.intervalMs = this.baseMs;
  }

  /** Current (possibly backed-off) interval, for inspection/tests. */
  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  /**
   * Whether a summary is due at `nowMs` for `transcript`. The first non-empty
   * transcript is always due. When the interval has elapsed but the transcript
   * is unchanged, the cadence backs off (and returns false) instead of paying
   * for an identical summary.
   */
  shouldRun(nowMs: number, transcript: string): boolean {
    if (transcript.trim() === "") return false;
    if (this.lastRunAt === null) return true;
    if (nowMs - this.lastRunAt < this.intervalMs) return false;
    if (transcript === this.lastTranscript) {
      // Due by time but nothing new — back off and reset the timer.
      this.intervalMs = Math.min(this.maxMs, this.intervalMs * this.backoffFactor);
      this.lastRunAt = nowMs;
      return false;
    }
    return true;
  }

  /** Record that a summary ran at `nowMs`; resets the cadence to the base. */
  markRun(nowMs: number, transcript: string): void {
    this.lastRunAt = nowMs;
    this.lastTranscript = transcript;
    this.intervalMs = this.baseMs;
  }
}
