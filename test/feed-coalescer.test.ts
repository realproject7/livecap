// #143: the caption/translation → DOM path is rAF-coalesced so an unthrottled
// translation-snapshot burst produces one flush per frame (deduped block writes
// + a single scroll-stick read/write) instead of a forced sync reflow per event.
// The coalescing bookkeeping and the shimmer cap are factored as pure helpers so
// they are testable headless; the on-device smoothness is the PO's visual gate.
import { describe, expect, it } from "vitest";

import { FeedCoalescer, latestPendingKey } from "../src/feed-coalescer";

interface Block {
  key: string;
  state: string;
}

describe("FeedCoalescer (#143)", () => {
  it("dedups repeated dirty writes to the same key — latest value wins", () => {
    const c = new FeedCoalescer<Block>();
    c.markDirty({ key: "a", state: "pending" });
    c.markDirty({ key: "a", state: "translated" }); // same block, later snapshot
    c.markDirty({ key: "b", state: "pending" });

    const { dirty } = c.drain();
    expect(dirty).toHaveLength(2); // a collapsed to one write, not two
    expect(dirty.find((x) => x.key === "a")?.state).toBe("translated");
    expect(dirty.map((x) => x.key).sort()).toEqual(["a", "b"]);
  });

  it("absorbs a 20-snapshot burst on one block into a single write", () => {
    const c = new FeedCoalescer<Block>();
    for (let i = 0; i < 20; i++) c.markDirty({ key: "x", state: `s${i}` });
    const { dirty } = c.drain();
    expect(dirty).toHaveLength(1);
    expect(dirty[0].state).toBe("s19");
  });

  it("tracks the appended flag independently of dirty writes", () => {
    const c = new FeedCoalescer<Block>();
    c.markAppended();
    const frame = c.drain();
    expect(frame.appended).toBe(true);
    expect(frame.dirty).toEqual([]);
  });

  it("drain resets the accumulator for the next frame", () => {
    const c = new FeedCoalescer<Block>();
    c.markDirty({ key: "a", state: "pending" });
    c.markAppended();
    c.drain();
    const frame = c.drain();
    expect(frame.dirty).toEqual([]);
    expect(frame.appended).toBe(false);
  });

  it("drop() forgets an evicted/cleared block so the flush never re-materializes it", () => {
    const c = new FeedCoalescer<Block>();
    c.markDirty({ key: "gone", state: "pending" });
    c.markDirty({ key: "kept", state: "pending" });
    c.drop("gone");
    const { dirty } = c.drain();
    expect(dirty.map((x) => x.key)).toEqual(["kept"]);
  });
});

describe("latestPendingKey (#143 shimmer cap)", () => {
  it("returns null when nothing is pending", () => {
    expect(latestPendingKey([{ key: "a", state: "translated" }])).toBeNull();
    expect(latestPendingKey([])).toBeNull();
  });

  it("returns the newest (last) pending block's key", () => {
    const blocks = [
      { key: "a", state: "pending" },
      { key: "b", state: "translated" },
      { key: "c", state: "pending" }, // newest pending
      { key: "d", state: "streaming" },
    ];
    expect(latestPendingKey(blocks)).toBe("c");
  });
});
