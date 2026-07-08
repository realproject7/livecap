// Summary cadence (issue #9): drive the summary/board refresh, backing off
// when the transcript hasn't changed so an idle meeting doesn't keep paying for
// identical summaries. Pure and clock-injected — no real timers — so the
// scheduling logic tests deterministically.
//
// #55: the base interval is 120s (up from 60s). With incremental summarization
// the per-call cost is bounded, but a longer base cadence still roughly halves
// the call count over a long meeting — directly cutting the #13 cost — while the
// existing idle backoff (up to 300s) keeps a quiet meeting from paying at all.

export interface SummaryCadenceOptions {
  /** Base interval between summaries (ms). Default 120_000 (#55). */
  baseMs?: number;
  /** Cap on the backed-off interval (ms). Default 300_000. */
  maxMs?: number;
  /** Multiplier applied each time the transcript is unchanged. Default 2. */
  backoffFactor?: number;
  /**
   * Minimum age of the transcript before the FIRST summary is allowed to fire
   * (ms). Default 45_000 (#142). Without it the first summary fires on the very
   * first non-empty transcript — ~5s into the meeting on the summary poll — the
   * worst possible moment, colliding with the first live captions. Deferring it
   * keeps the opening seconds clear so the first captions translate promptly.
   * Set to 0 to keep the legacy "first transcript is immediately due" behaviour.
   */
  firstDelayMs?: number;
}

export class SummaryCadence {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly backoffFactor: number;
  private readonly firstDelayMs: number;

  private lastRunAt: number | null = null;
  private lastTranscript: string | null = null;
  private intervalMs: number;
  /** When the first non-empty transcript was seen — the anchor for the first-run
   *  deferral (#142). Null until the first non-empty poll. */
  private firstSeenAt: number | null = null;

  constructor(options: SummaryCadenceOptions = {}) {
    this.baseMs = options.baseMs ?? 120_000;
    this.maxMs = options.maxMs ?? 300_000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.firstDelayMs = options.firstDelayMs ?? 45_000;
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
    if (this.lastRunAt === null) {
      // Defer the first summary (#142): anchor on when the transcript first
      // appeared and hold off until it is at least `firstDelayMs` old, so the
      // opening captions translate without the first summary turn contending.
      if (this.firstSeenAt === null) this.firstSeenAt = nowMs;
      if (nowMs - this.firstSeenAt < this.firstDelayMs) return false;
      // First attempt is now due: pace it (record the attempt) so a run that
      // THROWS — the consumer never reaches markRun — still backs off to the base
      // cadence instead of returning true on every poll tick (#39).
      this.lastRunAt = nowMs;
      return true;
    }
    const changed = transcript !== this.lastTranscript;
    // New content resets the cadence to base BEFORE the due check, so a meeting
    // that resumes after an idle backoff becomes due on the base interval again
    // rather than waiting out the backed-off one.
    if (changed) this.intervalMs = this.baseMs;
    if (nowMs - this.lastRunAt < this.intervalMs) return false;
    if (!changed) {
      // Due by time but nothing new — back off and reset the timer.
      this.intervalMs = Math.min(this.maxMs, this.intervalMs * this.backoffFactor);
      this.lastRunAt = nowMs;
      return false;
    }
    // Due + changed → run. Record the attempt now so a failed run (no markRun)
    // still paces the next poll at `intervalMs`, not every tick (#39).
    this.lastRunAt = nowMs;
    return true;
  }

  /** Record that a summary ran at `nowMs`; resets the cadence to the base. */
  markRun(nowMs: number, transcript: string): void {
    this.lastRunAt = nowMs;
    this.lastTranscript = transcript;
    this.intervalMs = this.baseMs;
  }
}
