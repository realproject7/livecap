// #139 data-loss guard: a FAILED retranslate of an already-archived caption must
// NOT erase its previously-good target. `applyRetranslation` is the in-place
// archive-merge step recordBatch uses — it ignores an empty/failed result so the
// archive keeps the good value while the UI shows "failed".
import { describe, expect, it } from "vitest";

import type { CaptionEntry } from "@livecap/archive";

import { applyRetranslation } from "../src/host/session";

function entry(target: string): CaptionEntry {
  return {
    speaker: "them",
    timestamp: "09:00",
    source: "original source",
    target,
    pinned: false,
    lowConfidence: false,
  };
}

describe("applyRetranslation (#139)", () => {
  it("overwrites the target with a non-empty result and signals a rewrite", () => {
    const e = entry("old translation");
    expect(applyRetranslation(e, "new translation")).toBe(true);
    expect(e.target).toBe("new translation");
  });

  it("preserves a good archived target when the retranslate failed/empty — no data loss", () => {
    const e = entry("good translation");
    // A failed retranslate reports text: "" via onFailed → recordBatch.
    expect(applyRetranslation(e, "")).toBe(false);
    expect(e.target).toBe("good translation"); // unchanged — the archive keeps the good value
  });

  it("does not signal a rewrite for an empty result (brief is not re-persisted)", () => {
    const e = entry("");
    expect(applyRetranslation(e, "")).toBe(false);
    expect(e.target).toBe("");
  });
});
