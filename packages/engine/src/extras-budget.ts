// Per-session extras budget cap (issue #55). The #9 extras pipeline (live
// summary/board, replies, quick translate) runs on a cadence, so a long or
// pathological session could keep paying for summaries indefinitely — one of the
// two causes of #13's real-world 6× cost blow-up. This caps the TOTAL extras
// spend within a single session: once the cap is reached the recurring
// auto-summary stops calling the model. The spend it tallies is the same
// `Usage.turnCostUsd` the credit ledger meters, so it flows straight into the
// gauge the host surfaces.
//
// Pure and tally-based — no clock, no I/O — so it unit-tests directly.

/** Default per-session extras cap (USD). Chosen to keep speaker-mode extras
 *  inside the #3 PoC envelope (≈ the translation-only spend), not to gate the
 *  occasional user-driven reply/quick-translate. Overridable per session. */
export const DEFAULT_EXTRAS_BUDGET_USD = 0.5;

export interface ExtrasBudgetOptions {
  /** Hard ceiling on extras spend for this session (USD). 0 disables extras. */
  capUsd: number;
}

/** Read-only snapshot for the gauge. */
export interface ExtrasBudgetState {
  capUsd: number;
  spentUsd: number;
  /** Never negative. */
  remainingUsd: number;
  /** 0–1. */
  fractionUsed: number;
  /** True once the cap is reached — the auto-summary loop should stand down. */
  exhausted: boolean;
}

/** Raised when an extras call is attempted after the session cap is reached.
 *  The message is content-free (#23): it never echoes the transcript/prompt. */
export class ExtrasBudgetExceededError extends Error {
  constructor() {
    super("extras budget exceeded");
    this.name = "ExtrasBudgetExceededError";
  }
}

export class ExtrasBudget {
  private readonly cap: number;
  private spent = 0;

  constructor(options: ExtrasBudgetOptions) {
    this.cap = Number.isFinite(options.capUsd) && options.capUsd > 0 ? options.capUsd : 0;
  }

  get capUsd(): number {
    return this.cap;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.cap - this.spent);
  }

  /** Whether another extras call is still within the cap. */
  canSpend(): boolean {
    return this.spent < this.cap;
  }

  /** Tally a completed extras call's cost. Ignores non-positive / non-finite. */
  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.spent += costUsd;
  }

  snapshot(): ExtrasBudgetState {
    return {
      capUsd: this.cap,
      spentUsd: this.spent,
      remainingUsd: this.remainingUsd,
      fractionUsed: this.cap > 0 ? Math.min(1, this.spent / this.cap) : 1,
      exhausted: !this.canSpend(),
    };
  }
}
