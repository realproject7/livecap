import { describe, it, expect } from "vitest";

import { CreditAccountant, type CreditEvent, type GaugeState } from "../src/credit-ledger";
import {
  DEFAULT_PERCENT_PER_HOUR,
  hoursFromRate,
  quotaHeadroom,
  ratePerHour,
  type HeadroomReading,
  type HeadroomSource,
} from "../src/headroom";

// #205: the fallback decision is denominated in estimated meeting-HOURS, not
// dollars. These cover the seam that makes the derivation pluggable — and, just
// as importantly, that plugging it in changed nothing for the Claude tier.

const MS_PER_HOUR = 3_600_000;

/** In-memory ledger fs (same shape the credit-ledger tests use). */
function memFs(store: Record<string, string> = {}) {
  return {
    exists: (p: string) => p in store,
    readFile: (p: string) => store[p] ?? "",
    writeFile: (p: string, d: string) => {
      store[p] = d;
    },
    rename: (from: string, to: string) => {
      store[to] = store[from] ?? "";
      delete store[from];
    },
  };
}

/** A FAKE source — this ticket must not depend on any external CLI existing. */
function fakeSource(reading: HeadroomReading | (() => Promise<HeadroomReading>)): HeadroomSource {
  return {
    kind: "quota",
    read: typeof reading === "function" ? reading : () => Promise.resolve(reading),
  };
}

describe("hoursFromRate / ratePerHour (#205 shared primitive)", () => {
  it("divides remaining allowance by the per-hour rate, in any unit", () => {
    expect(hoursFromRate(10, 2)).toBe(5); // $10 left at $2/hr
    expect(hoursFromRate(50, 25)).toBe(2); // 50% left at 25%/hr
  });

  // The old USD path returned 0 rather than dividing by zero; preserved exactly.
  it("returns 0 — never Infinity — when the rate is zero or unusable", () => {
    expect(hoursFromRate(10, 0)).toBe(0);
    expect(hoursFromRate(10, -1)).toBe(0);
    expect(hoursFromRate(Number.NaN, 2)).toBe(0);
    expect(hoursFromRate(10, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("never reports negative headroom", () => {
    expect(hoursFromRate(-5, 2)).toBe(0);
  });

  it("measures the rolling rate as consumed/metered-hours, with a default until metered", () => {
    expect(ratePerHour(6, 3, 0.4)).toBe(2);
    expect(ratePerHour(6, 0, 0.4)).toBe(0.4); // nothing metered yet
    expect(ratePerHour(0, 3, 0.4)).toBe(0.4); // metered, but nothing consumed
  });
});

describe("quotaHeadroom (#205 quota derivation)", () => {
  const NOW = 1_760_000_000_000;

  it("derives hours from percent remaining and the measured percent/hour", () => {
    // 60% used over 3 metered hours ⇒ 20%/hr; 40% left ⇒ 2h.
    const headroom = quotaHeadroom(
      { known: true, windows: [{ label: "5h", usedPercent: 60 }] },
      3,
      NOW,
    );
    expect(headroom.known).toBe(true);
    expect(headroom.known && headroom.hoursRemaining).toBeCloseTo(2, 10);
  });

  it("falls back to the default rate before any metered time", () => {
    const headroom = quotaHeadroom(
      { known: true, windows: [{ label: "5h", usedPercent: 50 }] },
      0,
      NOW,
    );
    // 50% left at the default rate.
    expect(headroom.known && headroom.hoursRemaining).toBeCloseTo(50 / DEFAULT_PERCENT_PER_HOUR, 10);
  });

  // Scope 4: whichever wall is hit first is the real constraint.
  it("takes the MINIMUM across windows, not the first or the rolling one", () => {
    const headroom = quotaHeadroom(
      {
        known: true,
        windows: [
          { label: "5h", usedPercent: 20 }, // looks healthy
          { label: "weekly", usedPercent: 90 }, // nearly exhausted — governs
        ],
      },
      2,
      NOW,
    );
    // weekly: 90% used over 2h ⇒ 45%/hr, 10% left ⇒ 0.222h.
    expect(headroom.known && headroom.hoursRemaining).toBeCloseTo(10 / 45, 10);
    // #204: with MORE THAN ONE window the binding one is named, because "90%
    // used" alone does not say which wall is being hit. This is the reader for
    // `HeadroomWindow.label` — without it the field would be written and never
    // consumed, which looks like it works.
    expect(headroom.nativeDetail).toBe("weekly: 90% used");
  });

  // ...and with a single window (what a real plan reports) the label is omitted
  // rather than padding every line with a name that disambiguates nothing.
  it("omits the window name when there is only one window", () => {
    const headroom = quotaHeadroom(
      { known: true, windows: [{ label: "weekly", usedPercent: 90 }] },
      2,
      NOW,
    );
    expect(headroom.nativeDetail).toBe("90% used");
  });

  it("is unaffected by window order", () => {
    const windows = [
      { label: "weekly", usedPercent: 90 },
      { label: "5h", usedPercent: 20 },
    ];
    const forward = quotaHeadroom({ known: true, windows }, 2, NOW);
    const reversed = quotaHeadroom({ known: true, windows: [...windows].reverse() }, 2, NOW);
    expect(forward.known && forward.hoursRemaining).toBeCloseTo(
      reversed.known && reversed.hoursRemaining ? reversed.hoursRemaining : -1,
      10,
    );
  });

  it("reports an exhausted window as zero hours, never negative", () => {
    const headroom = quotaHeadroom(
      { known: true, windows: [{ label: "5h", usedPercent: 130 }] },
      2,
      NOW,
    );
    expect(headroom.known && headroom.hoursRemaining).toBe(0);
  });

  // Scope 5: unknown must fail loud, not open.
  it("returns unknown — never infinite — for an unreadable reading", () => {
    const headroom = quotaHeadroom({ known: false, reason: "unreadable" }, 2, NOW);
    expect(headroom.known).toBe(false);
    expect(headroom).not.toHaveProperty("hoursRemaining");
    expect(JSON.stringify(headroom)).not.toContain("Infinity");
  });

  it("returns unknown when a source reports no usable windows", () => {
    expect(quotaHeadroom({ known: true, windows: [] }, 2, NOW).known).toBe(false);
    expect(
      quotaHeadroom({ known: true, windows: [{ label: "x", usedPercent: Number.NaN }] }, 2, NOW)
        .known,
    ).toBe(false);
  });

  // Scope 7: resetsAt is display-only. Same allowance + rate ⇒ same hours,
  // whether the window resets in a minute or not at all.
  it("lets resetsAt change the detail string but NOT the hours", () => {
    const base = { label: "5h", usedPercent: 60 };
    const without = quotaHeadroom({ known: true, windows: [base] }, 3, NOW);
    const soon = quotaHeadroom(
      { known: true, windows: [{ ...base, resetsAt: NOW + 3 * MS_PER_HOUR }] },
      3,
      NOW,
    );
    expect(soon.known && soon.hoursRemaining).toBe(without.known && without.hoursRemaining);
    expect(soon.nativeDetail).toBe("60% used, resets in 3h");
    expect(without.nativeDetail).toBe("60% used");
  });

  // Security invariant: a source cannot smuggle an account id through the
  // unknown path, because the reason is a closed set of literals.
  it("carries only a closed-set reason, never source-supplied text", () => {
    const headroom = quotaHeadroom({ known: false, reason: "invalid" }, 1, NOW);
    expect(headroom.known === false && headroom.reason).toBe("invalid");
    expect(headroom.nativeDetail).toBe("usage unknown");
  });
});

describe("CreditAccountant — Claude/USD behaviour is unchanged (#205 scope 2)", () => {
  /** The pre-#205 derivation, inlined as an oracle to compare against. */
  function legacyGauge(poolUsd: number, spentUsd: number, meteredMs: number, defaultRate = 0.4) {
    const pool = Math.max(0, poolUsd);
    const remaining = Math.max(0, pool - spentUsd);
    const meteredHours = meteredMs / MS_PER_HOUR;
    const dollarsPerHour =
      meteredHours > 0 && spentUsd > 0 ? spentUsd / meteredHours : defaultRate;
    return {
      remainingUsd: remaining,
      dollarsPerHour,
      estimatedHoursRemaining: dollarsPerHour > 0 ? remaining / dollarsPerHour : 0,
      fractionUsed: pool > 0 ? Math.min(1, spentUsd / pool) : 1,
    };
  }

  function accountantFor(poolUsd: number) {
    return new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd,
      now: () => 1_760_000_000_000,
    });
  }

  it("matches the pre-#205 gauge on a matrix of pools, spend, and metered time", () => {
    for (const poolUsd of [0, 20, 100, 200]) {
      for (const spentUsd of [0, 0.01, 5, 19.99, 20, 500]) {
        for (const meteredMs of [0, 60_000, MS_PER_HOUR, 7 * MS_PER_HOUR]) {
          const accountant = accountantFor(poolUsd);
          if (meteredMs > 0) accountant.recordMeetingTime(meteredMs);
          if (spentUsd > 0) accountant.recordCost(spentUsd);
          const gauge = accountant.gauge();
          const legacy = legacyGauge(poolUsd, spentUsd, meteredMs);
          expect(gauge.remainingUsd).toBe(legacy.remainingUsd);
          expect(gauge.dollarsPerHour).toBe(legacy.dollarsPerHour);
          expect(gauge.estimatedHoursRemaining).toBe(legacy.estimatedHoursRemaining);
          expect(gauge.fractionUsed).toBe(legacy.fractionUsed);
        }
      }
    }
  });

  it("switches at exactly the same point as before", () => {
    // $0.40/hr default, 2h threshold ⇒ the crossing is at $0.80 remaining.
    for (const [spent, expected] of [
      [19.19, false], // $0.81 left ⇒ 2.025h
      [19.21, true], // $0.79 left ⇒ 1.975h
    ] as const) {
      const accountant = accountantFor(20);
      accountant.recordCost(spent);
      expect(accountant.isBelowThreshold()).toBe(expected);
    }
  });

  it("keeps headroom known on the USD path, so the gate never blocks a real switch", () => {
    const accountant = accountantFor(20);
    expect(accountant.gauge().headroomKnown).toBe(true);
    accountant.recordCost(19.99);
    expect(accountant.gauge().headroomKnown).toBe(true);
    expect(accountant.isBelowThreshold()).toBe(true);
  });

  it("carries the USD figures as native detail (display only)", () => {
    const accountant = accountantFor(20);
    accountant.recordCost(3.4);
    expect(accountant.gauge().nativeDetail).toBe("$3.40 of $20.00");
  });
});

describe("CreditAccountant — quota source drives the decision (#205 scope 3/4)", () => {
  function accountantWith(source: HeadroomSource, meteredMs = 3 * MS_PER_HOUR) {
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      headroomSource: source,
      now: () => 1_760_000_000_000,
    });
    if (meteredMs > 0) accountant.recordMeetingTime(meteredMs);
    return accountant;
  }

  it("is below threshold when the quota source says hours are short", () => {
    // 90% used over 3h ⇒ 30%/hr; 10% left ⇒ 0.33h < 2h.
    const accountant = accountantWith(
      fakeSource({ known: true, windows: [{ label: "5h", usedPercent: 90 }] }),
    );
    return accountant.refreshHeadroom().then(() => {
      const gauge = accountant.gauge();
      expect(gauge.headroomKnown).toBe(true);
      expect(gauge.estimatedHoursRemaining).toBeCloseTo(10 / 30, 10);
      expect(accountant.isBelowThreshold()).toBe(true);
      expect(gauge.nativeDetail).toBe("90% used");
    });
  });

  it("is above threshold when plenty of quota remains", async () => {
    // 10% used over 3h ⇒ 3.33%/hr; 90% left ⇒ 27h.
    const accountant = accountantWith(
      fakeSource({ known: true, windows: [{ label: "5h", usedPercent: 10 }] }),
    );
    await accountant.refreshHeadroom();
    expect(accountant.isBelowThreshold()).toBe(false);
    expect(accountant.gauge().estimatedHoursRemaining).toBeGreaterThan(2);
  });

  it("honours the two-window minimum end-to-end", async () => {
    const accountant = accountantWith(
      fakeSource({
        known: true,
        windows: [
          { label: "5h", usedPercent: 10 }, // 27h left on its own
          { label: "weekly", usedPercent: 95 }, // the real wall
        ],
      }),
    );
    await accountant.refreshHeadroom();
    // weekly: 95% over 3h ⇒ 31.67%/hr, 5% left ⇒ 0.158h.
    expect(accountant.gauge().estimatedHoursRemaining).toBeCloseTo(5 / (95 / 3), 10);
    expect(accountant.isBelowThreshold()).toBe(true);
  });

  // #204 (RE2's catch): on a non-USD tier `spent / pool` is permanently 0, so a
  // gauge bar driven by it renders "budget untouched" for the whole session
  // while the real constraint sits unread in nativeDetail. The fraction must
  // come from the headroom source instead.
  it("takes the bar's fraction from the quota source, not the empty USD ledger", async () => {
    const accountant = accountantWith(
      fakeSource({ known: true, windows: [{ label: "weekly", usedPercent: 62 }] }),
    );
    await accountant.refreshHeadroom();
    const gauge = accountant.gauge();
    expect(gauge.fractionUsed).toBeCloseTo(0.62, 10);
    // The USD figures are still zero — they are structurally meaningless here,
    // which is exactly why nothing should render them.
    expect(gauge.spentUsd).toBe(0);
    expect(gauge.nativeDetail).toBe("62% used");
  });

  it("reports a zero fraction with headroomKnown false when the source is unreadable", async () => {
    const accountant = accountantWith(fakeSource({ known: false, reason: "unreadable" }));
    await accountant.refreshHeadroom();
    const gauge = accountant.gauge();
    expect(gauge.headroomKnown).toBe(false);
    expect(gauge.fractionUsed).toBe(0);
    // A consumer must render "unknown" here rather than an empty bar implying
    // a full allowance.
    expect(gauge.nativeDetail).toBe("usage unknown");
  });

  it("emits an engine-switch exactly once when the quota crossing happens", async () => {
    const events: CreditEvent[] = [];
    const accountant = accountantWith(
      fakeSource({ known: true, windows: [{ label: "5h", usedPercent: 90 }] }),
    );
    accountant.onEvent((e) => events.push(e));
    await accountant.refreshHeadroom();
    await accountant.refreshHeadroom();
    expect(events.filter((e) => e.type === "engine-switch")).toHaveLength(1);
  });
});

describe("CreditAccountant — unknown headroom fails loud, not open (#205 scope 5)", () => {
  const unreadable = fakeSource({ known: false, reason: "unreadable" });

  it("does not report infinite headroom for an unreadable source", async () => {
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      headroomSource: unreadable,
      now: () => 1_760_000_000_000,
    });
    await accountant.refreshHeadroom();
    const gauge = accountant.gauge();
    expect(gauge.headroomKnown).toBe(false);
    expect(Number.isFinite(gauge.estimatedHoursRemaining)).toBe(true);
    expect(gauge.estimatedHoursRemaining).not.toBe(Number.POSITIVE_INFINITY);
  });

  // The failure this seam exists to prevent: an unreadable source must not
  // silently disable the safety net, NOR trip it. Unknown is not "low".
  it("does not auto-switch on unknown headroom", async () => {
    const events: CreditEvent[] = [];
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      headroomSource: unreadable,
      now: () => 1_760_000_000_000,
    });
    accountant.onEvent((e) => events.push(e));
    await accountant.refreshHeadroom();
    expect(accountant.isBelowThreshold()).toBe(false);
    expect(events.filter((e) => e.type === "engine-switch")).toHaveLength(0);
  });

  it("treats a source that THROWS as unknown rather than letting it escape", async () => {
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      headroomSource: fakeSource(() => Promise.reject(new Error("network down"))),
      now: () => 1_760_000_000_000,
    });
    await expect(accountant.refreshHeadroom()).resolves.toBeUndefined();
    expect(accountant.gauge().headroomKnown).toBe(false);
    expect(accountant.isBelowThreshold()).toBe(false);
  });

  // A configured source that has never been read is unknown, not unlimited —
  // otherwise the window between session start and the first refresh would be
  // an unguarded free-for-all.
  it("starts unknown before the first refresh", () => {
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      headroomSource: unreadable,
      now: () => 1_760_000_000_000,
    });
    expect(accountant.gauge().headroomKnown).toBe(false);
    expect(accountant.isBelowThreshold()).toBe(false);
  });

  it("surfaces the unknown state on the gauge so it can be displayed", async () => {
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      headroomSource: unreadable,
      now: () => 1_760_000_000_000,
    });
    await accountant.refreshHeadroom();
    expect(accountant.gauge().nativeDetail).toBe("usage unknown");
  });
});

describe("CreditAccountant — native detail is display-only (#205 scope 6)", () => {
  // The decision must depend on hours + known-ness alone. Rewriting the detail
  // string to something alarming (or reassuring) must not move the switch.
  it("never consults nativeDetail when deciding to switch", async () => {
    async function decide(detailWindows: { label: string; usedPercent: number }[]) {
      const accountant = new CreditAccountant({
        fs: memFs(),
        ledgerPath: "/ledger.json",
        poolUsd: 20,
        headroomSource: fakeSource({ known: true, windows: detailWindows }),
        now: () => 1_760_000_000_000,
      });
      accountant.recordMeetingTime(3 * MS_PER_HOUR);
      await accountant.refreshHeadroom();
      return { below: accountant.isBelowThreshold(), gauge: accountant.gauge() };
    }

    // Same usedPercent ⇒ same decision, regardless of how the label reads.
    const plain = await decide([{ label: "5h", usedPercent: 90 }]);
    const alarming = await decide([{ label: "CRITICAL — 0% LEFT", usedPercent: 90 }]);
    expect(alarming.below).toBe(plain.below);
    expect(alarming.gauge.estimatedHoursRemaining).toBe(plain.gauge.estimatedHoursRemaining);
  });

  it("keeps the decision fields and the display field independent", () => {
    const accountant = new CreditAccountant({
      fs: memFs(),
      ledgerPath: "/ledger.json",
      poolUsd: 20,
      now: () => 1_760_000_000_000,
    });
    accountant.recordCost(19.99);
    const gauge: GaugeState = accountant.gauge();
    // Mutating the display string cannot change the verdict — it is not read.
    const mutated: GaugeState = { ...gauge, nativeDetail: "$0.00 of $0.00" };
    expect(mutated.estimatedHoursRemaining).toBe(gauge.estimatedHoursRemaining);
    expect(accountant.isBelowThreshold()).toBe(true);
  });
});
