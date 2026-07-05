// #114: coached caption ids → the archive's (timestamp, occurrence) amend keys.
// The occurrence MUST be the 1-based position among `me` entries sharing a
// timestamp, computed over archived order — the exact walk render.ts /
// writer.amendCoaching (#113) use — or a persisted rewrite lands on the wrong
// utterance. Pure and headless.

import { describe, expect, it } from "vitest";

import { coachingAmendKeys, type KeyedEntry } from "../src/host/coaching-keys";

const ENTRIES: KeyedEntry[] = [
  { id: 1, speaker: "them", timestamp: "10:45" },
  { id: 2, speaker: "me", timestamp: "10:45" },
  { id: 3, speaker: "me", timestamp: "10:45" },
  { id: 4, speaker: "them", timestamp: "10:46" },
  { id: 5, speaker: "me", timestamp: "10:46" },
  { id: 6, speaker: "me", timestamp: "10:45" }, // clock wrapped / duplicate label later on
];

describe("coachingAmendKeys (#114)", () => {
  it("keys each me entry by its 1-based occurrence among same-timestamp me entries", () => {
    const keys = coachingAmendKeys(ENTRIES, [2, 3, 5, 6]);
    expect(keys.get(2)).toEqual({ timestamp: "10:45", occurrence: 1 });
    expect(keys.get(3)).toEqual({ timestamp: "10:45", occurrence: 2 });
    expect(keys.get(5)).toEqual({ timestamp: "10:46", occurrence: 1 });
    // Occurrence counts ALL me entries at that timestamp so far, not just
    // consecutive ones — same as the renderer's walk.
    expect(keys.get(6)).toEqual({ timestamp: "10:45", occurrence: 3 });
  });

  it("never counts them entries toward an occurrence", () => {
    const keys = coachingAmendKeys(ENTRIES, [5]);
    // id 4 ("them" at 10:46) must not shift id 5 to occurrence 2.
    expect(keys.get(5)).toEqual({ timestamp: "10:46", occurrence: 1 });
  });

  it("gives no key to them entries or unknown ids", () => {
    const keys = coachingAmendKeys(ENTRIES, [1, 4, 99]);
    expect(keys.size).toBe(0);
  });

  it("skipping an id never shifts the occurrence of the ids after it", () => {
    // Only id 3 requested: it is still the SECOND me entry at 10:45.
    const keys = coachingAmendKeys(ENTRIES, [3]);
    expect(keys.get(3)).toEqual({ timestamp: "10:45", occurrence: 2 });
  });

  it("handles no entries and no ids", () => {
    expect(coachingAmendKeys([], [1]).size).toBe(0);
    expect(coachingAmendKeys(ENTRIES, []).size).toBe(0);
  });
});
