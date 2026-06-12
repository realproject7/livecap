import { describe, it, expect } from "vitest";

import { SummaryCadence } from "../src/summary-cadence";

const T0 = 1_000_000;
const MIN = 60_000;

describe("SummaryCadence", () => {
  it("does not run on an empty transcript", () => {
    const c = new SummaryCadence();
    expect(c.shouldRun(T0, "   ")).toBe(false);
  });

  it("runs the first non-empty transcript immediately", () => {
    const c = new SummaryCadence();
    expect(c.shouldRun(T0, "hello")).toBe(true);
  });

  it("waits the base interval between runs", () => {
    const c = new SummaryCadence({ baseMs: MIN });
    c.markRun(T0, "a");
    expect(c.shouldRun(T0 + 30_000, "a more")).toBe(false); // not due yet
    expect(c.shouldRun(T0 + MIN, "a more")).toBe(true); // due + changed
  });

  it("backs off when the transcript is unchanged at the interval", () => {
    const c = new SummaryCadence({ baseMs: MIN, backoffFactor: 2, maxMs: 10 * MIN });
    c.markRun(T0, "same");
    expect(c.shouldRun(T0 + MIN, "same")).toBe(false); // due but unchanged → back off
    expect(c.currentIntervalMs).toBe(2 * MIN);
    // After backoff the timer was reset; not due until the larger interval.
    expect(c.shouldRun(T0 + MIN + MIN, "same")).toBe(false);
    expect(c.currentIntervalMs).toBe(2 * MIN); // not re-evaluated until due
    expect(c.shouldRun(T0 + MIN + 2 * MIN, "same")).toBe(false); // due again, still unchanged
    expect(c.currentIntervalMs).toBe(4 * MIN); // backs off further
  });

  it("becomes due on the base cadence when new content arrives mid-backoff", () => {
    const c = new SummaryCadence({ baseMs: MIN, backoffFactor: 2, maxMs: 10 * MIN });
    c.markRun(T0, "a");
    expect(c.shouldRun(T0 + MIN, "a")).toBe(false); // unchanged → backoff to 2*MIN, lastRunAt = T0+MIN
    expect(c.currentIntervalMs).toBe(2 * MIN);

    // New content 10s later: must reset to base and become due at T0+2*MIN
    // (base cadence), NOT wait out the backed-off T0+3*MIN.
    expect(c.shouldRun(T0 + MIN + 10_000, "a NEW")).toBe(false); // only 10s in
    expect(c.currentIntervalMs).toBe(MIN); // reset by new content
    expect(c.shouldRun(T0 + 2 * MIN, "a NEW")).toBe(true); // due on the base cadence
  });

  it("resets to the base interval once new content arrives", () => {
    const c = new SummaryCadence({ baseMs: MIN });
    c.markRun(T0, "a");
    c.shouldRun(T0 + MIN, "a"); // unchanged → backoff to 2x
    expect(c.currentIntervalMs).toBe(2 * MIN);
    expect(c.shouldRun(T0 + MIN + 2 * MIN, "a NEW")).toBe(true); // due + changed
    c.markRun(T0 + MIN + 2 * MIN, "a NEW");
    expect(c.currentIntervalMs).toBe(MIN); // reset
  });

  it("caps the backed-off interval at maxMs", () => {
    const c = new SummaryCadence({ baseMs: MIN, backoffFactor: 10, maxMs: 3 * MIN });
    c.markRun(T0, "same");
    c.shouldRun(T0 + MIN, "same"); // 1*10 → capped at 3*MIN
    expect(c.currentIntervalMs).toBe(3 * MIN);
  });
});
