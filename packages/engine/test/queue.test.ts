import { describe, it, expect } from "vitest";

import { TranslationQueue } from "../src/queue";
import type { Sentence } from "../src/types";

function s(seq: number): Sentence {
  return { id: `s${seq}`, text: `sentence ${seq}`, seq };
}

describe("TranslationQueue — normal batching", () => {
  it("withholds a batch until minBatch is reached", () => {
    const q = new TranslationQueue();
    q.enqueue(s(1));
    expect(q.nextBatch()).toBeNull();
    q.enqueue(s(2));
    expect(q.nextBatch()?.map((x) => x.seq)).toEqual([1, 2]);
    expect(q.size).toBe(0);
  });

  it("releases at most maxBatch in spoken (FIFO) order", () => {
    const q = new TranslationQueue();
    for (let i = 1; i <= 4; i++) q.enqueue(s(i));
    expect(q.nextBatch()?.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("TranslationQueue — backlog discipline", () => {
  it("merges the whole backlog newest-first once past maxBatch", () => {
    const q = new TranslationQueue();
    for (let i = 1; i <= 6; i++) q.enqueue(s(i));
    expect(q.isBacklogged).toBe(true);
    const batch = q.nextBatch();
    expect(batch?.map((x) => x.seq)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(q.size).toBe(0);
  });

  it("prioritizes the newest sentence at the head of the merged batch", () => {
    const q = new TranslationQueue({ minBatch: 2, maxBatch: 2 });
    [10, 11, 12].forEach((n) => q.enqueue(s(n)));
    expect(q.nextBatch()?.[0]?.seq).toBe(12);
  });
});

describe("TranslationQueue — flush", () => {
  it("returns a sub-minBatch remainder in FIFO order", () => {
    const q = new TranslationQueue();
    q.enqueue(s(1));
    expect(q.nextBatch()).toBeNull();
    expect(q.flush()?.map((x) => x.seq)).toEqual([1]);
    expect(q.flush()).toBeNull();
  });
});

describe("TranslationQueue — validation", () => {
  it("rejects an inverted batch range", () => {
    expect(() => new TranslationQueue({ minBatch: 3, maxBatch: 2 })).toThrow();
  });
});
