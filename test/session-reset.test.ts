// #171 regression: session-scoped webview state must NOT survive a Stop → Start
// in the same app run. The feed is a long-lived singleton; before this fix a
// second session inherited the first's caption blocks and — worse — its own mic
// utterances, so session 2's post-meeting coaching (openReview reads
// feed.micUtterances()) could rewrite lines actually spoken in session 1.
//
// FeedState.reset() is the model half of that reset (main.ts also clears the
// block/card DOM + the summary/board/archivePath/metrics accumulators — those
// are DOM/Tauri-coupled and exercised in the running app). This drives the exact
// start → feed content → stop → start sequence against the real FeedState.

import { describe, expect, it } from "vitest";

import { FeedState } from "../src/feed-state";

function finalized(id: number, channel: "them" | "me", text: string) {
  return {
    type: "finalized" as const,
    id,
    channel,
    text,
    lang: "en",
    lowConfidence: false,
    epochMs: 1_000 + id,
    durationMs: 900,
  };
}

describe("FeedState.reset (#171 session-scoped reset)", () => {
  it("clears all state so a second session starts empty", () => {
    const feed = new FeedState();

    // --- Session 1: real content across both channels, a pin, a live partial ---
    feed.applyCaption(finalized(1, "me", "I think we should ship it"));
    feed.applyCaption(finalized(2, "them", "agreed, let us do it"));
    feed.applyCaption(finalized(3, "me", "great, I will start today"));
    feed.applyTranslation([{ id: 2, text: "동의합니다" }], true);
    feed.setPinned(2, true);
    feed.applyCaption({ type: "partial", channel: "them", text: "one more thing" });

    // Sanity: session 1 has content the review/coaching path would read.
    expect(feed.blocks.length).toBeGreaterThan(0);
    expect(feed.micUtterances().map((b) => b.source)).toEqual([
      "I think we should ship it",
      "great, I will start today",
    ]);
    expect(feed.get(2)?.pinned).toBe(true);
    expect(feed.latest()).not.toBeNull();

    // --- Stop → Start: the new-session reset boundary ---
    feed.reset();

    // Session 2 starts with a clean slate: no blocks, no ids, no pins, no live
    // partials, no history counter, and crucially no leftover mic utterances.
    expect(feed.blocks).toHaveLength(0);
    expect(feed.micUtterances()).toEqual([]);
    expect(feed.pinnedBlocks()).toEqual([]);
    expect(feed.latest()).toBeNull();
    expect(feed.get(1)).toBeNull();
    expect(feed.get(2)).toBeNull();
    expect(feed.evictedCount).toBe(0);
  });

  it("resets the render-key counter so session 2 keys do not collide with session 1", () => {
    const feed = new FeedState();
    const first = feed.applyCaption({ type: "partial", channel: "me", text: "hello" });

    feed.reset();

    // A fresh session's first block reuses the initial key — no stale-key reuse
    // that could alias a session-1 DOM node still keyed the same way.
    const afterReset = feed.applyCaption({ type: "partial", channel: "me", text: "new session" });
    expect(afterReset.key).toBe(first.key);
    expect(feed.blocks).toHaveLength(1);
  });

  it("drops live partials so a mid-utterance stop does not linger into the next session", () => {
    const feed = new FeedState();
    // A partial with no finalized event (e.g. a session stopped mid-sentence).
    feed.applyCaption({ type: "partial", channel: "me", text: "I was saying" });
    expect(feed.blocks).toHaveLength(1);

    feed.reset();

    // The next session's first partial is genuinely new, not a reused partial.
    expect(feed.blocks).toHaveLength(0);
    const fresh = feed.applyCaption({ type: "partial", channel: "me", text: "brand new" });
    expect(fresh.source).toBe("brand new");
    expect(feed.blocks).toHaveLength(1);
  });
});
