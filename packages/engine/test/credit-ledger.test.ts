import { describe, it, expect } from "vitest";

import { CreditAccountant, periodKeyFor } from "../src/credit-ledger";
import type { CreditConfig, CreditEvent, GaugeState, LedgerFs } from "../src/credit-ledger";
import type { Usage } from "../src/types";

const ZERO_USAGE: Usage = {
  cumulativeCostUsd: 0,
  turnCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
};

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

  it("re-delivers the recommendation when a process relaunches already below threshold", () => {
    // Persist a below-threshold ledger (spent $19 of $20, $1/hr → ~1h left).
    const fs = new FakeLedgerFs();
    const now = () => Date.UTC(2026, 5, 10);
    const first = new CreditAccountant({
      fs,
      ledgerPath: PATH,
      poolUsd: 20,
      fallbackThresholdHours: 2,
      defaultDollarsPerHour: 1,
      now,
    });
    first.recordCost(19);

    // Relaunch: a brand-new accountant loads the below-threshold ledger.
    const relaunched = new CreditAccountant({
      fs,
      ledgerPath: PATH,
      poolUsd: 20,
      fallbackThresholdHours: 2,
      defaultDollarsPerHour: 1,
      now,
    });
    expect(relaunched.isBelowThreshold()).toBe(true);

    const switches: CreditEvent[] = [];
    relaunched.onEvent((e) => {
      if (e.type === "engine-switch") switches.push(e);
    });
    relaunched.recordCost(0.1); // first usage after relaunch re-fires it once
    relaunched.recordCost(0.1); // still below → must NOT fire again
    expect(switches).toHaveLength(1);
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

describe("CreditAccountant — rollover read-path resilience (#37)", () => {
  it("gauge() does not throw on a disk error during rollover-on-read", () => {
    const fs = new FakeLedgerFs();
    let now = Date.UTC(2026, 5, 10); // 2026-06
    const acc = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now: () => now });
    const events: CreditEvent[] = [];
    acc.onEvent((e) => events.push(e));
    acc.recordCost(5);

    now = Date.UTC(2026, 6, 10); // advance to 2026-07 → next read rolls over
    fs.failNextWrite = true; // disk error on the rollover persist
    let gauge: GaugeState | undefined;
    expect(() => {
      gauge = acc.gauge();
    }).not.toThrow(); // pre-fix this threw (rollover commit failed in a read)
    expect(gauge?.periodKey).toBe("2026-07");
    expect(gauge?.spentUsd).toBe(0); // rolled over in memory despite the failed persist
    expect(events.some((e) => e.type === "ledger-error")).toBe(true);
  });

  it("isBelowThreshold() survives a rollover disk error (so startOnFallback can't fail session start)", () => {
    const fs = new FakeLedgerFs();
    let now = Date.UTC(2026, 5, 10);
    const acc = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now: () => now });
    acc.recordCost(5);
    now = Date.UTC(2026, 6, 10);
    fs.failNextRename = true;
    expect(() => acc.isBelowThreshold()).not.toThrow();
  });
});

describe("CreditAccountant — failure isolation", () => {
  it("surfaces a ledger write failure as an event instead of throwing into the engine callback", () => {
    const fs = new FakeLedgerFs();
    const acc = new CreditAccountant({ fs, ledgerPath: PATH, poolUsd: 20, now: () => Date.UTC(2026, 5, 10) });
    const events: CreditEvent[] = [];
    acc.onEvent((e) => events.push(e));

    let listener: (u: Usage) => void = () => {};
    const fakeEngine = {
      onUsage(l: (u: Usage) => void) {
        listener = l;
        return () => {};
      },
    };
    acc.attach(fakeEngine);

    fs.failNextRename = true;
    // The engine invokes this synchronously inside its stdout data handler — it
    // must never throw there.
    expect(() => listener({ ...ZERO_USAGE, turnCostUsd: 0.5 })).not.toThrow();
    expect(events.some((e) => e.type === "ledger-error")).toBe(true);

    // A later usage (disk recovered) still records normally.
    listener({ ...ZERO_USAGE, turnCostUsd: 0.5 });
    expect(acc.gauge().spentUsd).toBeCloseTo(0.5, 6);
  });

  it("isolates a throwing event subscriber from accounting", () => {
    const acc = make({ now: () => Date.UTC(2026, 5, 10) });
    acc.onEvent(() => {
      throw new Error("bad UI subscriber");
    });
    expect(() => acc.recordCost(1)).not.toThrow();
    expect(acc.gauge().spentUsd).toBe(1);
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
