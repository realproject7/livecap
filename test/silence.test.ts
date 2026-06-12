// Silence watchdog (#11): fires once per silent stretch; activity and snooze
// re-arm it. Clock-injected — no real timers.
import { describe, expect, it } from "vitest";

import { SilenceWatchdog } from "../src/host/silence";

describe("SilenceWatchdog", () => {
  it("fires once after the threshold of no activity", () => {
    const fired: number[] = [];
    const dog = new SilenceWatchdog(600_000, (since) => fired.push(since));
    dog.activity(0);
    dog.check(599_999);
    expect(fired).toHaveLength(0);
    dog.check(600_000);
    expect(fired).toEqual([600_000]);
    dog.check(700_000); // still silent — no second prompt
    expect(fired).toHaveLength(1);
  });

  it("re-arms on new activity", () => {
    const fired: number[] = [];
    const dog = new SilenceWatchdog(1_000, (since) => fired.push(since));
    dog.activity(0);
    dog.check(1_500);
    dog.activity(2_000);
    dog.check(2_500);
    expect(fired).toHaveLength(1);
    dog.check(3_100);
    expect(fired).toHaveLength(2);
  });

  it("snooze restarts the window without speech", () => {
    const fired: number[] = [];
    const dog = new SilenceWatchdog(1_000, (since) => fired.push(since));
    dog.activity(0);
    dog.check(1_000);
    expect(fired).toHaveLength(1);
    dog.snooze(1_000);
    dog.check(1_900);
    expect(fired).toHaveLength(1);
    dog.check(2_000);
    expect(fired).toHaveLength(2);
  });

  it("baselines from the first check when no activity was recorded", () => {
    const fired: number[] = [];
    const dog = new SilenceWatchdog(1_000, (since) => fired.push(since));
    dog.check(5_000); // baseline
    dog.check(5_500);
    expect(fired).toHaveLength(0);
    dog.check(6_000);
    expect(fired).toEqual([1_000]);
  });
});
