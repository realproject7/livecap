import { describe, it, expect } from "vitest";

import { CreditAccountant, periodKeyFor } from "../src/credit-ledger";
import type { CreditConfig, CreditEvent, LedgerFs } from "../src/credit-ledger";

class FakeLedgerFs implements LedgerFs {
  files = new Map<string, string>();
  failNextWrite = false;
  failNextRename = false;
  exists(path: string): boolean {
    return this.files.has(path);
  }
  readFile(path: string): string {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  }
  writeFile(path: string, data: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("crash during writeFile");
    }
    this.files.set(path, data);
  }
  rename(from: string, to: string): void {
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error("crash during rename");
    }
    if (!this.files.has(from)) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, this.files.get(from) as string);
    this.files.delete(from);
  }
}

const PATH = "/data/credit/ledger.json";

function make(overrides: Partial<CreditConfig> & { now: () => number }): CreditAccountant {
  return new CreditAccountant({
    fs: new FakeLedgerFs(),
    ledgerPath: PATH,
    poolUsd: 20,
    resetDay: 1,
    fallbackThresholdHours: 2,
    defaultDollarsPerHour: 1,
    ...overrides,
  });
}

describe("periodKeyFor", () => {
  it("keys by calendar month when resetDay is 1", () => {
    expect(periodKeyFor(Date.UTC(2026, 5, 10), 1)).toBe("2026-06");
    expect(periodKeyFor(Date.UTC(2026, 0, 1), 1)).toBe("2026-01");
  });

  it("keys by billing period when resetDay is mid-month", () => {
    // resetDay 15: the 20th is in June's period, the 10th still in May's.
    expect(periodKeyFor(Date.UTC(2026, 5, 20), 15)).toBe("2026-06");
    expect(periodKeyFor(Date.UTC(2026, 5, 10), 15)).toBe("2026-05");
  });

  it("wraps the year at January", () => {
    expect(periodKeyFor(Date.UTC(2026, 0, 5), 15)).toBe("2025-12");
  });
});

describe("CreditAccountant — accumulation & gauge", () => {
  it("accumulates cost and derives spent/remaining", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) });
    acc.recordCost(0.1);
    acc.recordCost(0.2);
    const g = acc.gauge();
    expect(g.spentUsd).toBeCloseTo(0.3, 6);
    expect(g.remainingUsd).toBeCloseTo(19.7, 6);
    expect(g.fractionUsed).toBeCloseTo(0.015, 6);
  });

  it("ignores non-positive / non-finite costs", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) });
    acc.recordCost(-1);
    acc.recordCost(0);
    acc.recordCost(Number.NaN);
    expect(acc.gauge().spentUsd).toBe(0);
  });

  it("derives rolling $/hr from metered time once available", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) });
    acc.recordMeetingTime(3_600_000); // 1 hour
    acc.recordCost(0.8);
    const g = acc.gauge();
    expect(g.dollarsPerHour).toBeCloseTo(0.8, 6);
    expect(g.estimatedHoursRemaining).toBeCloseTo((20 - 0.8) / 0.8, 4);
  });

  it("falls back to the default $/hr before any metered time", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10), defaultDollarsPerHour: 0.4 });
    expect(acc.gauge().dollarsPerHour).toBe(0.4);
    expect(acc.gauge().estimatedHoursRemaining).toBeCloseTo(20 / 0.4, 4);
  });

  it("records cost from an engine's usage events via attach()", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) });
    let emit: (u: { turnCostUsd: number }) => void = () => {};
    const fakeEngine = {
      onUsage(listener: (u: { turnCostUsd: number; cumulativeCostUsd: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number }) => void) {
        emit = listener as never;
        return () => {};
      },
    };
    acc.attach(fakeEngine as never);
    emit({ turnCostUsd: 0.5 });
    expect(acc.gauge().spentUsd).toBeCloseTo(0.5, 6);
  });
});

describe("CreditAccountant — period rollover", () => {
  it("resets spend when the calendar month rolls over (resetDay 1)", () => {
    let now = Date.UTC(2026, 5, 10);
    const acc = make({ now: () => now });
    acc.recordCost(5);
    expect(acc.gauge().spentUsd).toBe(5);

    now = Date.UTC(2026, 6, 2); // July
    const g = acc.gauge();
    expect(g.periodKey).toBe("2026-07");
    expect(g.spentUsd).toBe(0);
  });

  it("resets on the billing day, not the calendar 1st (resetDay 15)", () => {
    let now = Date.UTC(2026, 5, 20); // June 20 → period 2026-06
    const acc = make({ now: () => now, resetDay: 15 });
    acc.recordCost(5);

    now = Date.UTC(2026, 6, 10); // July 10 — still BEFORE the 15th → same period
    expect(acc.gauge().spentUsd).toBe(5);
    expect(acc.gauge().periodKey).toBe("2026-06");

    now = Date.UTC(2026, 6, 16); // July 16 — past the reset day → new period
    expect(acc.gauge().spentUsd).toBe(0);
    expect(acc.gauge().periodKey).toBe("2026-07");
  });
});

describe("CreditAccountant — auto-fallback threshold", () => {
  it("emits engine-switch exactly once on a downward crossing", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) }); // $1/hr, threshold 2h → switch when remaining < $2
    const events: CreditEvent[] = [];
    acc.onEvent((e) => events.push(e));

    acc.recordCost(10); // remaining $10 → ~10h, fine
    acc.recordCost(8); // remaining $2 → exactly at threshold (not below)
    expect(events.filter((e) => e.type === "engine-switch")).toHaveLength(0);

    acc.recordCost(0.5); // remaining $1.5 → below 2h
    acc.recordCost(0.5); // remaining $1.0 → still below, must NOT re-fire
    acc.recordCost(5); // overspend → remaining 0, still below
    expect(events.filter((e) => e.type === "engine-switch")).toHaveLength(1);
  });

  it("re-arms and fires again after a period rollover re-crosses", () => {
    let now = Date.UTC(2026, 5, 10);
    const acc = make({ now: () => now });
    let switches = 0;
    acc.onEvent((e) => {
      if (e.type === "engine-switch") switches += 1;
    });

    acc.recordCost(19); // remaining $1 → below → fires
    expect(switches).toBe(1);

    now = Date.UTC(2026, 6, 2); // rollover replenishes the pool, re-arms the latch
    acc.recordCost(19); // below again → fires again
    expect(switches).toBe(2);
  });

  it("emits a gauge event on every change", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) });
    const gauges: CreditEvent[] = [];
    acc.onEvent((e) => {
      if (e.type === "gauge") gauges.push(e);
    });
    acc.recordCost(1);
    acc.recordCost(1);
    expect(gauges.length).toBe(2);
  });
});

describe("CreditAccountant — persistence", () => {
  it("round-trips across instances sharing the same ledger file", () => {
    const fs = new FakeLedgerFs();
    const now = () => Date.UTC(2026, 5, 10);
    const a = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now });
    a.recordCost(3.5);

    const b = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now });
    expect(b.gauge().spentUsd).toBeCloseTo(3.5, 6);
  });

  it("starts a fresh period if the persisted ledger is corrupt", () => {
    const fs = new FakeLedgerFs();
    fs.files.set(PATH, "{not json");
    const acc = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now: () => Date.UTC(2026, 5, 10) });
    expect(acc.gauge().spentUsd).toBe(0);
  });

  it("keeps the prior ledger intact when a write/rename crashes mid-update", () => {
    const fs = new FakeLedgerFs();
    const now = () => Date.UTC(2026, 5, 10);
    const acc = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now });
    acc.recordCost(4);
    const persisted = fs.files.get(PATH);

    fs.failNextRename = true;
    expect(() => acc.recordCost(2)).toThrow();
    expect(fs.files.get(PATH)).toBe(persisted); // unchanged on disk

    // A reload sees the last durable value (4), not the crashed 6.
    const reloaded = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now });
    expect(reloaded.gauge().spentUsd).toBeCloseTo(4, 6);
  });
});

describe("CreditAccountant — invariants (property)", () => {
  it("never reports negative remaining; switch fires once under monotonic depletion", () => {
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 50; trial++) {
      const acc = make({ now: () => Date.UTC(2026, 5, 10) });
      let switches = 0;
      acc.onEvent((e) => {
        if (e.type === "engine-switch") switches += 1;
      });
      for (let i = 0; i < 40; i++) {
        acc.recordCost(rnd() * 2);
        const g = acc.gauge();
        expect(g.remainingUsd).toBeGreaterThanOrEqual(0);
        expect(g.estimatedHoursRemaining).toBeGreaterThanOrEqual(0);
        expect(g.fractionUsed).toBeLessThanOrEqual(1);
      }
      const finallyBelow = acc.gauge().estimatedHoursRemaining < 2;
      // Monotonic depletion → at most one downward crossing.
      expect(switches).toBe(finallyBelow ? 1 : 0);
    }
  });
});
