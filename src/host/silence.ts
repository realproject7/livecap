// 10-minute silence watchdog (PROPOSAL §8.9): when no finalized caption has
// arrived for the threshold, fire once so the UI can prompt to auto-stop.
// Clock-injected and timerless — the host drives check() on its own interval —
// so it tests deterministically.

export const SILENCE_THRESHOLD_MS = 10 * 60 * 1000;

export class SilenceWatchdog {
  private lastActivityMs: number | null = null;
  private fired = false;

  constructor(
    private readonly thresholdMs: number,
    private readonly onSilence: (sinceMs: number) => void,
  ) {}

  /** A finalized caption arrived. Re-arms the watchdog. */
  activity(nowMs: number): void {
    this.lastActivityMs = nowMs;
    this.fired = false;
  }

  /** The user chose to keep going — restart the window without new speech. */
  snooze(nowMs: number): void {
    this.activity(nowMs);
  }

  /** Evaluate at `nowMs`; fires the callback once per silent stretch. */
  check(nowMs: number): void {
    if (this.lastActivityMs === null) {
      this.lastActivityMs = nowMs;
      return;
    }
    const since = nowMs - this.lastActivityMs;
    if (!this.fired && since >= this.thresholdMs) {
      this.fired = true;
      this.onSilence(since);
    }
  }
}
