// Queue discipline (PROPOSAL §3): batch 2–4 finalized sentences per request.
// When speech outruns translation, merge the whole backlog into one request and
// prioritize the newest sentence — otherwise the translation column drifts 30+
// seconds behind. Pure and synchronous; the engine drives it.

import type { Sentence } from "./types";

export interface QueueOptions {
  /** Minimum sentences before a normal batch is released. Default 2. */
  minBatch?: number;
  /** Maximum sentences in a normal batch. Default 4. */
  maxBatch?: number;
}

export class TranslationQueue {
  private readonly minBatch: number;
  private readonly maxBatch: number;
  private pending: Sentence[] = [];

  constructor(options: QueueOptions = {}) {
    this.minBatch = options.minBatch ?? 2;
    this.maxBatch = options.maxBatch ?? 4;
    if (this.minBatch < 1) throw new Error("minBatch must be >= 1");
    if (this.maxBatch < this.minBatch) throw new Error("maxBatch must be >= minBatch");
  }

  /** Number of sentences waiting to be translated. */
  get size(): number {
    return this.pending.length;
  }

  /** True when the backlog has grown past one normal batch. */
  get isBacklogged(): boolean {
    return this.pending.length > this.maxBatch;
  }

  enqueue(sentence: Sentence): void {
    this.pending.push(sentence);
  }

  /**
   * Pull the next batch to translate, or null if not enough has accumulated.
   * - Backlogged (> maxBatch waiting): merge the ENTIRE backlog into one batch,
   *   newest first, so the most recent speech is translated first.
   * - Otherwise, once at least minBatch is waiting, release up to maxBatch in
   *   spoken (FIFO) order.
   */
  nextBatch(): Sentence[] | null {
    if (this.pending.length === 0) return null;

    if (this.isBacklogged) {
      const merged = this.pending.slice().sort((a, b) => b.seq - a.seq);
      this.pending = [];
      return merged;
    }

    if (this.pending.length >= this.minBatch) {
      const batch = this.pending.slice(0, this.maxBatch);
      this.pending = this.pending.slice(batch.length);
      return batch;
    }

    return null;
  }

  /**
   * Release whatever is pending regardless of minBatch — e.g. at a speech pause
   * or session end, so the last sentence is never stranded below the threshold.
   * Returns FIFO order (no backlog reprioritization on a deliberate flush).
   */
  flush(): Sentence[] | null {
    if (this.pending.length === 0) return null;
    const batch = this.pending;
    this.pending = [];
    return batch;
  }
}
