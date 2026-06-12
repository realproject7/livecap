// Credit accounting + auto-fallback policy (issue #7, PROPOSAL §6/§8.7).
// Accumulates usage cost into a locally-persisted monthly ledger, derives the
// in-app gauge (spent / remaining / meeting-hours left), and recommends an
// engine switch BEFORE the Agent SDK pool runs out — captions must never stop.
//
// Pure TS, fixture-driven. The ledger path and clock are injected; the package
// hardcodes no path and reads no real clock.

import type { Usage } from "./types";

/** Agent SDK monthly pool presets (PROPOSAL §6). */
export const POOL_PRESETS = { pro: 20, max5x: 100, max20x: 200 } as const;
export type PlanId = keyof typeof POOL_PRESETS;

/** Atomic-write filesystem surface (injected). */
export interface LedgerFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Overwrite a file (creating parent dirs as needed). */
  writeFile(path: string, data: string): void;
  /** Atomic rename (same volume). */
  rename(from: string, to: string): void;
}

export interface CreditConfig {
  fs: LedgerFs;
  /** Ledger JSON path (injected — never resolved inside the package). */
  ledgerPath: string;
  /** Monthly pool size in USD (preset value or a custom amount). */
  poolUsd: number;
  /** Billing reset day of month (1–28). The pool resets on this day, not the
   *  calendar 1st. Default 1. */
  resetDay?: number;
  /** Emit an engine-switch recommendation when est. hours left drops below this.
   *  Default 2. */
  fallbackThresholdHours?: number;
  /** $/hr used until enough real usage accrues (PROPOSAL §6 estimate). Default 0.40. */
  defaultDollarsPerHour?: number;
  /** Injected clock (epoch ms). */
  now: () => number;
}

interface LedgerData {
  version: 1;
  /** Billing period this data belongs to, e.g. "2026-06". */
  periodKey: string;
  spentUsd: number;
  /** Metered meeting time this period, for the rolling $/hr. */
  meteredMs: number;
}

export interface GaugeState {
  periodKey: string;
  poolUsd: number;
  spentUsd: number;
  /** Never negative. */
  remainingUsd: number;
  /** Rolling cost per meeting-hour (falls back to the default until metered). */
  dollarsPerHour: number;
  /** Never negative. */
  estimatedHoursRemaining: number;
  /** 0–1. */
  fractionUsed: number;
}

export type CreditEvent =
  | { type: "gauge"; gauge: GaugeState }
  | { type: "engine-switch"; reason: "credit-low"; gauge: GaugeState }
  // A ledger persistence failure, surfaced (not thrown) so it never crashes the
  // caption stream — accounting can be lost; captions must not.
  | { type: "ledger-error"; error: unknown };

const MS_PER_HOUR = 3_600_000;

/**
 * Billing period containing `nowMs`, keyed by the month the period started.
 * NOTE: boundaries are evaluated in UTC, so the reset happens at UTC midnight,
 * not the user's local midnight (up to ~half a day of skew). Fine for a gauge;
 * #12's Settings copy should not promise an exact local-time reset.
 */
export function periodKeyFor(nowMs: number, resetDay: number): string {
  const date = new Date(nowMs);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth(); // 0–11
  if (date.getUTCDate() < resetDay) {
    // Before the reset day → still in the period that began last month.
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export class CreditAccountant {
  private readonly config: CreditConfig;
  private readonly resetDay: number;
  private readonly thresholdHours: number;
  private readonly defaultDollarsPerHour: number;
  private readonly listeners = new Set<(event: CreditEvent) => void>();

  private data: LedgerData;
  /** Latch so an engine-switch fires exactly once per downward crossing. */
  private belowThreshold = false;

  constructor(config: CreditConfig) {
    this.config = config;
    this.resetDay = clampResetDay(config.resetDay ?? 1);
    this.thresholdHours = config.fallbackThresholdHours ?? 2;
    this.defaultDollarsPerHour = config.defaultDollarsPerHour ?? 0.4;
    this.data = this.load();
    // Do NOT pre-latch from loaded state: a process that relaunches already
    // below threshold must still re-deliver the recommendation (the first
    // recorded usage re-fires it; a consumer can also pull isBelowThreshold()
    // at session start). Pre-latching here would silence it for the period.
    this.belowThreshold = false;
  }

  /** Whether est. meeting-hours left is under the fallback threshold right now.
   *  Pull this at session start to decide whether to begin on the fallback. */
  isBelowThreshold(): boolean {
    return this.gauge().estimatedHoursRemaining < this.thresholdHours;
  }

  /** Subscribe to gauge / engine-switch events. Returns an unsubscribe fn. */
  onEvent(listener: (event: CreditEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Wire an engine's usage events into the ledger. Returns an unsubscribe fn.
   * A persistence failure here is caught and surfaced as a "ledger-error" event
   * — it must NOT throw, because this listener runs inside the engine's stdout
   * data handler and an uncaught throw there would take down the caption stream.
   */
  attach(engine: { onUsage(listener: (usage: Usage) => void): () => void }): () => void {
    return engine.onUsage((usage) => {
      try {
        this.recordCost(usage.turnCostUsd);
      } catch (error) {
        this.emit({ type: "ledger-error", error });
      }
    });
  }

  /** Add a turn's cost (USD). Rolls the period over first if needed. */
  recordCost(costUsd: number): void {
    this.rolloverIfNeeded();
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    // Persist the candidate before committing in memory, so a failed write
    // leaves disk and memory consistent (no double-count after a crash).
    this.commit({ ...this.data, spentUsd: this.data.spentUsd + costUsd });
    this.evaluate();
  }

  /** Add metered meeting time (ms) for the rolling $/hr. */
  recordMeetingTime(ms: number): void {
    this.rolloverIfNeeded();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.commit({ ...this.data, meteredMs: this.data.meteredMs + ms });
    this.evaluate();
  }

  /** Current gauge snapshot (period-rollover aware). */
  gauge(): GaugeState {
    this.rolloverIfNeeded();
    const pool = Math.max(0, this.config.poolUsd);
    const spent = this.data.spentUsd;
    const remaining = Math.max(0, pool - spent);
    const meteredHours = this.data.meteredMs / MS_PER_HOUR;
    const dollarsPerHour =
      meteredHours > 0 && spent > 0 ? spent / meteredHours : this.defaultDollarsPerHour;
    const estimatedHoursRemaining = dollarsPerHour > 0 ? remaining / dollarsPerHour : 0;
    const fractionUsed = pool > 0 ? Math.min(1, spent / pool) : 1;
    return {
      periodKey: this.data.periodKey,
      poolUsd: pool,
      spentUsd: spent,
      remainingUsd: remaining,
      dollarsPerHour,
      estimatedHoursRemaining,
      fractionUsed,
    };
  }

  private evaluate(): void {
    const gauge = this.gauge();
    this.emit({ type: "gauge", gauge });
    const below = gauge.estimatedHoursRemaining < this.thresholdHours;
    if (below && !this.belowThreshold) {
      // Downward crossing — recommend the switch exactly once.
      this.emit({ type: "engine-switch", reason: "credit-low", gauge });
    }
    this.belowThreshold = below;
  }

  private rolloverIfNeeded(): void {
    const key = periodKeyFor(this.config.now(), this.resetDay);
    if (key === this.data.periodKey) return;
    // Swap the in-memory period FIRST so read paths (gauge/isBelowThreshold and
    // the synchronous startOnFallback wiring) never throw on a disk error; the
    // persist is best-effort. The new period is still correct in memory, and
    // load() re-rolls a stale file to 0 on next start, so no double-charge (#37).
    this.data = { version: 1, periodKey: key, spentUsd: 0, meteredMs: 0 };
    this.belowThreshold = false; // pool replenished — re-arm the latch
    this.persistBestEffort(this.data);
  }

  private load(): LedgerData {
    const key = periodKeyFor(this.config.now(), this.resetDay);
    if (this.config.fs.exists(this.config.ledgerPath)) {
      try {
        const parsed = JSON.parse(this.config.fs.readFile(this.config.ledgerPath)) as Partial<LedgerData>;
        if (parsed.periodKey === key && typeof parsed.spentUsd === "number") {
          return {
            version: 1,
            periodKey: key,
            spentUsd: parsed.spentUsd,
            meteredMs: typeof parsed.meteredMs === "number" ? parsed.meteredMs : 0,
          };
        }
      } catch {
        // Corrupt ledger — start the period fresh rather than crash.
      }
    }
    return { version: 1, periodKey: key, spentUsd: 0, meteredMs: 0 };
  }

  /** Atomically write `next`, then commit it in memory (write-before-commit). */
  private commit(next: LedgerData): void {
    this.writeAtomic(next);
    this.data = next;
  }

  /** Persist without throwing — a disk error surfaces as a `ledger-error` event. */
  private persistBestEffort(next: LedgerData): void {
    try {
      this.writeAtomic(next);
    } catch (error) {
      this.emit({ type: "ledger-error", error });
    }
  }

  private writeAtomic(next: LedgerData): void {
    const tmp = `${this.config.ledgerPath}.tmp`;
    this.config.fs.writeFile(tmp, JSON.stringify(next));
    this.config.fs.rename(tmp, this.config.ledgerPath);
  }

  private emit(event: CreditEvent): void {
    // Isolate subscribers: a throwing UI listener must not propagate back into
    // recordCost (and thus the engine callback).
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber is its own problem; accounting continues.
      }
    }
  }
}

function clampResetDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.floor(day)));
}
