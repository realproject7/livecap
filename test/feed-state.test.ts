// Feed state reducer (#11): the five caption-block states, channel identity,
// partial→finalized in-place settling, progressive translation, failure
// discard, pins, and the Strip/Capsule latest-line view.
import { describe, expect, it } from "vitest";

import { FEED_WINDOW, FeedState } from "../src/feed-state";

function finalized(id: number, channel: "them" | "me", text: string, lowConfidence = false) {
  return { type: "finalized" as const, id, channel, text, lang: "en", lowConfidence, epochMs: 1_000 + id };
}

describe("FeedState", () => {
  it("streams partials into one reusable block per channel", () => {
    const feed = new FeedState();
    const a = feed.applyCaption({ type: "partial", channel: "them", text: "And I" });
    const b = feed.applyCaption({ type: "partial", channel: "them", text: "And I had, um" });
    expect(b.key).toBe(a.key);
    expect(b.state).toBe("streaming");
    expect(b.source).toBe("And I had, um");
    expect(feed.blocks).toHaveLength(1);
  });

  it("keeps them/me partial streams separate", () => {
    const feed = new FeedState();
    const them = feed.applyCaption({ type: "partial", channel: "them", text: "hello" });
    const me = feed.applyCaption({ type: "partial", channel: "me", text: "I agree" });
    expect(them.key).not.toBe(me.key);
    expect(them.channel).toBe("them");
    expect(me.channel).toBe("me");
  });

  it("finalizes IN PLACE: the streaming block becomes the pending block (no layout shift)", () => {
    const feed = new FeedState();
    const partial = feed.applyCaption({ type: "partial", channel: "them", text: "And I had, um" });
    const final = feed.applyCaption(finalized(1, "them", "And I had — I started by just listing"));
    expect(final.key).toBe(partial.key);
    expect(final.state).toBe("pending");
    expect(final.id).toBe(1);
    expect(feed.blocks).toHaveLength(1);
    // The next partial on the channel opens a NEW block.
    const next = feed.applyCaption({ type: "partial", channel: "them", text: "so the" });
    expect(next.key).not.toBe(final.key);
  });

  it("finalizes without a preceding partial by appending a new block", () => {
    const feed = new FeedState();
    const block = feed.applyCaption(finalized(1, "me", "Have a good day."));
    expect(block.state).toBe("pending");
    expect(block.channel).toBe("me");
  });

  it("carries the low-confidence flag (state 4)", () => {
    const feed = new FeedState();
    const block = feed.applyCaption(finalized(1, "them", "treat it as a stack rank", true));
    expect(block.lowConfidence).toBe(true);
  });

  it("applies progressive translation snapshots, then marks translated on done", () => {
    const feed = new FeedState();
    feed.applyCaption(finalized(1, "them", "Pat, thanks a lot."));
    const partial = feed.applyTranslation([{ id: 1, text: "Pat, 정말" }], false);
    expect(partial[0].translation).toBe("Pat, 정말");
    expect(partial[0].state).toBe("pending");
    const done = feed.applyTranslation([{ id: 1, text: "Pat, 정말 고마워요." }], true);
    expect(done[0].state).toBe("translated");
  });

  it("discards streamed partial translations when the batch fails", () => {
    const feed = new FeedState();
    feed.applyCaption(finalized(1, "them", "hello"));
    feed.applyTranslation([{ id: 1, text: "안" }], false);
    const failed = feed.applyFailed([1]);
    expect(failed[0].state).toBe("failed");
    expect(failed[0].translation).toBe("");
  });

  it("does not regress an already-translated block on a late failure event", () => {
    const feed = new FeedState();
    feed.applyCaption(finalized(1, "them", "hello"));
    feed.applyTranslation([{ id: 1, text: "안녕하세요" }], true);
    expect(feed.applyFailed([1])).toHaveLength(0);
    expect(feed.get(1)?.state).toBe("translated");
  });

  it("tracks pins and exposes pinned blocks for the dock (state 5)", () => {
    const feed = new FeedState();
    feed.applyCaption(finalized(1, "them", "stack rank"));
    feed.applyCaption(finalized(2, "me", "I agree"));
    feed.setPinned(1, true);
    expect(feed.pinnedBlocks().map((b) => b.id)).toEqual([1]);
    feed.setPinned(1, false);
    expect(feed.pinnedBlocks()).toHaveLength(0);
  });

  it("marks a block pending again for retranslation", () => {
    const feed = new FeedState();
    feed.applyCaption(finalized(1, "them", "hello"));
    feed.applyTranslation([{ id: 1, text: "안녕" }], true);
    expect(feed.markRetranslating(1)?.state).toBe("pending");
  });

  it("latest() surfaces the newest block for Strip/Capsule", () => {
    const feed = new FeedState();
    expect(feed.latest()).toBeNull();
    feed.applyCaption(finalized(1, "them", "first"));
    feed.applyCaption({ type: "partial", channel: "me", text: "second…" });
    expect(feed.latest()?.source).toBe("second…");
    expect(feed.latest()?.state).toBe("streaming");
  });
});

// #62: a mic finalization suppressed as speaker bleed (#56/#64) never emits a
// finalized event, so the streaming partial it already pushed must be cleared —
// otherwise the orphaned bleed block lingers and the next genuine mic utterance
// reuses it. The pipeline signals this with a `cleared` caption event.
describe("FeedState — suppressed-utterance partial clear (#62)", () => {
  it("clearPartial drops the channel's streaming block and reports it", () => {
    const feed = new FeedState();
    const partial = feed.applyCaption({ type: "partial", channel: "me", text: "the quick brown fox" });
    expect(feed.blocks).toHaveLength(1);
    const gone = feed.clearPartial("me");
    expect(gone?.key).toBe(partial.key);
    expect(feed.blocks).toHaveLength(0);
    expect(feed.latest()).toBeNull();
  });

  it("clearPartial is a no-op (null) when nothing is streaming on the channel", () => {
    const feed = new FeedState();
    expect(feed.clearPartial("me")).toBeNull();
    // A finalized (non-streaming) block is not a live partial and is untouched.
    feed.applyCaption(finalized(1, "me", "Have a good day."));
    expect(feed.clearPartial("me")).toBeNull();
    expect(feed.blocks).toHaveLength(1);
  });

  it("clears only the named channel, leaving the other channel's partial intact", () => {
    const feed = new FeedState();
    const them = feed.applyCaption({ type: "partial", channel: "them", text: "their audio" });
    feed.applyCaption({ type: "partial", channel: "me", text: "bleed echo" });
    feed.clearPartial("me");
    expect(feed.blocks).toHaveLength(1);
    expect(feed.blocks[0].key).toBe(them.key);
    expect(feed.latest()?.channel).toBe("them");
  });

  it("does NOT poison the next genuine utterance after a suppressed one", () => {
    const feed = new FeedState();
    // A bleed utterance streams partials, then its finalization is suppressed.
    feed.applyCaption({ type: "partial", channel: "me", text: "the quick brown fox" });
    feed.clearPartial("me");
    // The next genuine mic utterance opens a FRESH block and finalizes normally.
    const next = feed.applyCaption({ type: "partial", channel: "me", text: "let us begin the" });
    const final = feed.applyCaption(finalized(1, "me", "Let us begin the quarterly review."));
    expect(final.key).toBe(next.key);
    expect(final.state).toBe("pending");
    expect(final.source).toBe("Let us begin the quarterly review.");
    expect(feed.blocks).toHaveLength(1);
    // The finalized block resolves for translation — not orphaned.
    expect(feed.get(1)?.id).toBe(1);
  });
});

describe("FeedState — render window (#57)", () => {
  /** Feed `count` finalized captions, evicting after each like main.ts does. */
  function fill(feed: FeedState, count: number, startId = 1): void {
    for (let i = 0; i < count; i += 1) {
      feed.applyCaption(finalized(startId + i, "them", `line ${startId + i}`));
      feed.evictOverflow();
    }
  }

  it("obeys the cap under 1000 synthetic captions (default window)", () => {
    const feed = new FeedState();
    fill(feed, 1000);
    expect(feed.blocks).toHaveLength(FEED_WINDOW);
    expect(feed.evictedCount).toBe(1000 - FEED_WINDOW);
    expect(feed.blocks[0].id).toBe(1000 - FEED_WINDOW + 1);
    expect(feed.latest()?.id).toBe(1000);
  });

  it("evicts oldest-first and reports the evicted blocks", () => {
    const feed = new FeedState(3);
    fill(feed, 3);
    feed.applyCaption(finalized(4, "them", "line 4"));
    feed.applyCaption(finalized(5, "them", "line 5"));
    const dropped = feed.evictOverflow();
    expect(dropped.map((b) => b.id)).toEqual([1, 2]); // oldest first
    expect(feed.blocks.map((b) => b.id)).toEqual([3, 4, 5]);
  });

  it("never evicts pinned blocks (they outlive the window)", () => {
    const feed = new FeedState(3);
    feed.applyCaption(finalized(1, "them", "keep me"));
    feed.setPinned(1, true);
    fill(feed, 10, 2);
    expect(feed.blocks[0].id).toBe(1);
    expect(feed.blocks[0].pinned).toBe(true);
    expect(feed.blocks).toHaveLength(3);
    expect(feed.blocks.slice(1).map((b) => b.id)).toEqual([10, 11]);
  });

  it("never evicts a live streaming partial", () => {
    const feed = new FeedState(3);
    const partial = feed.applyCaption({ type: "partial", channel: "me", text: "still talking" });
    fill(feed, 10, 1);
    expect(feed.blocks.some((b) => b.key === partial.key)).toBe(true);
    expect(feed.blocks).toHaveLength(3);
  });

  it("evicted ids stop resolving: late translations and pins are no-ops", () => {
    const feed = new FeedState(3);
    fill(feed, 10);
    expect(feed.get(1)).toBeNull();
    expect(feed.applyTranslation([{ id: 1, text: "늦은 번역" }], true)).toHaveLength(0);
    expect(feed.setPinned(1, true)).toBeNull();
  });

  it("does not evict while at or under the window", () => {
    const feed = new FeedState(5);
    fill(feed, 5);
    expect(feed.evictOverflow()).toHaveLength(0);
    expect(feed.evictedCount).toBe(0);
  });
});
