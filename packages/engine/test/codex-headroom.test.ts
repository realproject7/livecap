import { describe, it, expect } from "vitest";

import {
  CodexHeadroomSource,
  readingFromRateLimits,
  resetsAtMs,
  toHeadroomWindow,
  windowLabel,
  type CodexRateLimits,
} from "../src/codex-headroom";
import { quotaHeadroom } from "../src/headroom";

// #204: Codex exposes quota percentage, never USD — which is precisely what the
// #205 seam consumes. These lock in the two facts MEASURED against the real
// codex-cli 0.146.0 (not read off the schema): `secondary` can be null, and
// `resetsAt` is epoch SECONDS while the seam documents milliseconds.

/** The exact shape observed from `account/rateLimits/read` on a real account. */
const MEASURED: CodexRateLimits = {
  primary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_786_449_404 },
  secondary: null,
};

describe("windowLabel (#204)", () => {
  it("names the windows Codex actually reports", () => {
    expect(windowLabel(10_080)).toBe("weekly"); // the measured value
    expect(windowLabel(1440)).toBe("daily");
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(4320)).toBe("3d");
    expect(windowLabel(90)).toBe("90m");
  });

  it("degrades to a neutral label rather than inventing one", () => {
    expect(windowLabel(null)).toBe("quota");
    expect(windowLabel(undefined)).toBe("quota");
    expect(windowLabel(0)).toBe("quota");
    expect(windowLabel(Number.NaN)).toBe("quota");
  });
});

describe("resetsAtMs (#204 seconds → milliseconds)", () => {
  // Without this conversion the seam's "resets in …" line renders a 1970 date,
  // because #205 documents epoch ms and Codex reports epoch seconds.
  it("converts the measured epoch-seconds value to milliseconds", () => {
    expect(resetsAtMs(1_786_449_404)).toBe(1_786_449_404_000);
    expect(new Date(resetsAtMs(1_786_449_404) as number).getUTCFullYear()).toBe(2026);
  });

  // The failure mode this conversion prevents, made checkable rather than
  // inferred: `formatResetsIn` computes `resetsAt - nowMs` with no unit guard,
  // so a RAW seconds value is ~1.79e12 ms in the past and renders "resets now"
  // forever — a string that reads as correct while being permanently wrong.
  it("prevents the permanent 'resets now' string a raw seconds value produces", () => {
    const NOW = 1_786_400_000_000; // ms, shortly before the measured reset
    const raw = 1_786_449_404; // what Codex actually sends
    const unconverted = quotaHeadroom(
      { known: true, windows: [{ label: "weekly", usedPercent: 18, resetsAt: raw }] },
      3,
      NOW,
    );
    expect(unconverted.nativeDetail).toBe("18% used, resets now"); // the bug

    const converted = quotaHeadroom(
      { known: true, windows: [{ label: "weekly", usedPercent: 18, resetsAt: resetsAtMs(raw) }] },
      3,
      NOW,
    );
    expect(converted.nativeDetail).toBe("18% used, resets in 13h"); // the fix
    // Display-only either way — the decision is identical (#205 scope 7).
    expect(unconverted.known && unconverted.hoursRemaining).toBe(
      converted.known && converted.hoursRemaining,
    );
  });

  it("returns null for anything unusable, so the display just omits the reset", () => {
    expect(resetsAtMs(null)).toBeNull();
    expect(resetsAtMs(undefined)).toBeNull();
    expect(resetsAtMs(Number.NaN)).toBeNull();
    expect(resetsAtMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("toHeadroomWindow (#204)", () => {
  it("carries percentage, label, and converted reset across", () => {
    const w = toHeadroomWindow(MEASURED.primary);
    expect(w).toEqual({
      label: "weekly",
      usedPercent: 18,
      resetsAt: 1_786_449_404_000,
      windowDurationMins: 10_080,
    });
  });

  it("rejects a window with no usable percentage", () => {
    expect(toHeadroomWindow(null)).toBeNull();
    expect(toHeadroomWindow(undefined)).toBeNull();
    expect(toHeadroomWindow({})).toBeNull();
    expect(toHeadroomWindow({ usedPercent: Number.NaN })).toBeNull();
    expect(toHeadroomWindow({ usedPercent: -1 })).toBeNull();
  });
});

describe("readingFromRateLimits — 1..N windows (#204 / Head's requirement)", () => {
  // The measured account reports ONE window. A design that assumed two would
  // have produced an unknown reading here and silently disabled the safety net.
  it("accepts a single window when secondary is null (the MEASURED case)", () => {
    const reading = readingFromRateLimits(MEASURED);
    expect(reading.known).toBe(true);
    expect(reading.known && reading.windows).toHaveLength(1);
    expect(reading.known && reading.windows[0]?.label).toBe("weekly");
  });

  it("accepts both windows when a plan reports two", () => {
    const reading = readingFromRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 300 },
      secondary: { usedPercent: 90, windowDurationMins: 10_080 },
    });
    expect(reading.known && reading.windows.map((w) => w.label)).toEqual(["5h", "weekly"]);
  });

  it("is unknown — not empty — when the read failed", () => {
    expect(readingFromRateLimits(null)).toEqual({ known: false, reason: "unreadable" });
  });

  it("is unknown when neither window carries a percentage", () => {
    expect(readingFromRateLimits({ primary: null, secondary: null })).toEqual({
      known: false,
      reason: "no-windows",
    });
  });
});

describe("CodexHeadroomSource (#204 → #205 seam)", () => {
  const NOW = 1_786_400_000_000;

  it("reports the seam's kind tag", () => {
    expect(new CodexHeadroomSource(async () => MEASURED).kind).toBe("codex-quota");
  });

  it("drives the seam end-to-end from the MEASURED response", async () => {
    const source = new CodexHeadroomSource(async () => MEASURED);
    const reading = await source.read();
    // 18% used over 3 metered hours ⇒ 6%/hr; 82% left ⇒ ~13.7h.
    const headroom = quotaHeadroom(reading, 3, NOW);
    expect(headroom.known).toBe(true);
    expect(headroom.known && headroom.hoursRemaining).toBeCloseTo(82 / 6, 6);
    expect(headroom.nativeDetail.startsWith("18% used")).toBe(true);
    expect(headroom.nativeDetail).toContain("resets in");
  });

  // The #205 contract: a headroom failure must never escape into the caption
  // stream, and unknown must not be mistaken for empty.
  it("turns a rejecting reader into an explicit unknown", async () => {
    const source = new CodexHeadroomSource(() => Promise.reject(new Error("app-server gone")));
    await expect(source.read()).resolves.toEqual({ known: false, reason: "unreadable" });
  });

  it("turns a null read into an explicit unknown", async () => {
    const source = new CodexHeadroomSource(async () => null);
    expect(await source.read()).toEqual({ known: false, reason: "unreadable" });
  });

  // Security (#204): only numbers cross the boundary. Even if the transport
  // hands us a response carrying plan/account fields, they are not modelled and
  // cannot reach a gauge event or a log line.
  it("carries no identifying fields into the seam", async () => {
    const withIdentity = {
      ...MEASURED,
      planType: "prolite",
      accountId: "acct_should_never_appear",
      limitId: "codex",
    } as CodexRateLimits;
    const reading = await new CodexHeadroomSource(async () => withIdentity).read();
    const serialized = JSON.stringify(reading);
    expect(serialized).not.toContain("acct_should_never_appear");
    expect(serialized).not.toContain("prolite");
    expect(reading.known && reading.windows[0]).toEqual({
      label: "weekly",
      usedPercent: 18,
      resetsAt: 1_786_449_404_000,
      windowDurationMins: 10_080,
    });
  });
});
