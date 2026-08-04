// Credit accounting + auto-fallback policy (issue #7, PROPOSAL §6/§8.7).
// Accumulates usage cost into a locally-persisted monthly ledger, derives the
// in-app gauge (spent / remaining / meeting-hours left), and recommends an
// engine switch BEFORE the Agent SDK pool runs out — captions must never stop.
//
// Pure TS, fixture-driven. The ledger path and clock are injected; the package
// hardcodes no path and reads no real clock.

import {
  hoursFromRate,
  quotaHeadroom,
  ratePerHour,
  usdNativeDetail,
  type Headroom,
  type HeadroomSource,
} from "./headroom";
import type { Usage } from "./types";

/** Agent SDK monthly pool presets (PROPOSAL §6). */
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
  /** Optional engine-agnostic headroom source (#205). Omitted ⇒ the USD
   *  derivation below, i.e. today's Claude behaviour bit-for-bit. When present,
   *  `estimatedHoursRemaining` comes from the last snapshot this source
   *  produced (refresh it with {@link CreditAccountant.refreshHeadroom}). */
  headroomSource?: HeadroomSource;
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
  /** Never negative, and never `Infinity` — see {@link headroomKnown} (#205). */
  estimatedHoursRemaining: number;
  /** 0–1. */
  fractionUsed: number;
  /** Whether {@link estimatedHoursRemaining} is a real measurement (#205).
   *
   *  Always true on the USD path. False only when a headroom source could not
   *  be read: the hours figure then reads 0, which the DECISION path refuses to
   *  act on, rather than an `Infinity` that would silently disable the safety
   *  net. Consumers displaying hours should show "unknown" here. */
  headroomKnown: boolean;
  /** Engine-tagged, human-readable detail for DISPLAY ONLY (#205 scope 6) —
   *  `"$3.40 of $20.00"` on the USD path, `"62% used, resets in 3h"` on a quota
   *  path. The decision path must never read this; the tests assert it. */
  nativeDetail: string;
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
  /** Last snapshot from the headroom source (#205). Unknown until the first
   *  successful refresh — so a configured-but-never-read source is treated as
   *  unknown (and therefore non-switching), never as unlimited. */
  private headroom: Headroom = {
    known: false,
    reason: "unreadable",
    nativeDetail: "usage unknown",
  };

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
   *  Pull this at session start to decide whether to begin on the fallback.
   *
   *  #205: unknown headroom never switches. An unreadable source means we do not
   *  know how much is left — not that it is low — so acting on it would degrade
   *  a working Claude session to the local tier on a transient read failure. It
   *  is surfaced through `headroomKnown` instead of being guessed at. */
  isBelowThreshold(): boolean {
    const gauge = this.gauge();
    return gauge.headroomKnown && gauge.estimatedHoursRemaining < this.thresholdHours;
  }

  /**
   * Refresh the cached headroom snapshot from the configured source (#205).
   *
   * Async because a real source is a network read; the accountant's own read
   * path stays synchronous so `startOnFallback` and the #37 rollover-resilience
   * contract are unaffected. A source that throws is treated as unreadable
   * rather than allowed to escape — a headroom failure must never take down the
   * caption stream, exactly as a ledger write failure never does.
   */
  async refreshHeadroom(): Promise<void> {
    const source = this.config.headroomSource;
    if (!source) return;
    let headroom: Headroom;
    try {
      const reading = await source.read();
      headroom = quotaHeadroom(reading, this.meteredHours(), this.config.now());
    } catch {
      headroom = { known: false, reason: "unreadable", nativeDetail: "usage unknown" };
    }
    this.headroom = headroom;
    this.evaluate();
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

  /** Metered meeting-hours this period — the denominator of every rolling rate. */
  private meteredHours(): number {
    return this.data.meteredMs / MS_PER_HOUR;
  }

  /** Current gauge snapshot (period-rollover aware). */
  gauge(): GaugeState {
    this.rolloverIfNeeded();
    const pool = Math.max(0, this.config.poolUsd);
    const spent = this.data.spentUsd;
    const remaining = Math.max(0, pool - spent);
    const meteredHours = this.meteredHours();
    // The USD derivation, unchanged (#205 scope 2): the shared helpers below are
    // the same arithmetic this path always used — `spent / meteredHours` with a
    // default until metered, then `remaining / rate` — lifted so the quota
    // derivation cannot drift from it. Claude behaviour stays bit-for-bit.
    const dollarsPerHour = ratePerHour(spent, meteredHours, this.defaultDollarsPerHour);
    const fractionUsed = pool > 0 ? Math.min(1, spent / pool) : 1;
    // A configured headroom source REPLACES the USD derivation of hours; without
    // one, the USD path is authoritative and always known.
    const headroom: Headroom = this.config.headroomSource
      ? this.headroom
      : {
          known: true,
          hoursRemaining: hoursFromRate(remaining, dollarsPerHour),
          nativeDetail: usdNativeDetail(spent, pool),
        };
    return {
      periodKey: this.data.periodKey,
      poolUsd: pool,
      spentUsd: spent,
      remainingUsd: remaining,
      dollarsPerHour,
      // Never Infinity: unknown headroom reads 0, which
      // `isBelowThreshold`/`evaluate` refuse to act on (#205 scope 5).
      estimatedHoursRemaining: headroom.known ? headroom.hoursRemaining : 0,
      fractionUsed,
      headroomKnown: headroom.known,
      nativeDetail: headroom.nativeDetail,
    };
  }

  private evaluate(): void {
    const gauge = this.gauge();
    this.emit({ type: "gauge", gauge });
    // #205: same gate as isBelowThreshold — unknown headroom is not "low".
    const below = gauge.headroomKnown && gauge.estimatedHoursRemaining < this.thresholdHours;
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
