// Feed state reducer (#11): the five caption-block states, channel identity,
// partial→finalized in-place settling, progressive translation, failure
// discard, pins, and the Strip/Capsule latest-line view.
import { describe, expect, it } from "vitest";

import { FeedState } from "../src/feed-state";

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
