// Drives finalized sentences through the engine package's queue discipline
// (PROPOSAL §3: batch 2–4, newest-first merged backlog) and streams progressive
// per-sentence snapshots out (PoC finding: display must start <1.5s after
// sentence end — never wait for batch completion). App-side glue only: the
// queue and the engine both come from @livecap/engine.

import { TranslationQueue } from "@livecap/engine";
import type { RollingContext, Sentence, Translation, TranslationPair } from "@livecap/engine";

export interface RunnerEngine {
  translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation>;
}

export interface RunnerSentence {
  id: number;
  text: string;
}

export interface RunnerItem {
  id: number;
  text: string;
}

export interface RunnerResult {
  id: number;
  source: string;
  text: string;
}

export interface RunnerCallbacks {
  /** Progressive per-sentence snapshots while a batch streams. */
  onSnapshot(items: RunnerItem[], done: boolean): void;
  /** A batch completed; results are in spoken (ascending id) order. */
  onBatchDone(results: RunnerResult[]): void;
  /** A batch failed; any prior snapshots for these ids must be discarded. */
  onFailed(ids: number[], detail: string): void;
}

export interface RunnerOptions {
  engine: RunnerEngine;
  callbacks: RunnerCallbacks;
  /** Release a below-minBatch backlog after this idle window so a lone
   *  sentence still displays fast. Default 400. */
  flushAfterMs?: number;
  /** Rolling-context pairs retained. Default 8. */
  maxPairs?: number;
  /** Timer injection for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Map a whole-batch translation snapshot onto its sentences: the prompt
 * contract is one output line per input sentence, in input order. Extra lines
 * beyond the batch are folded into the last sentence.
 */
export function assignLines(ids: number[], text: string): RunnerItem[] {
  if (ids.length === 0) return [];
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.length > ids.length) {
    const folded = lines
      .splice(ids.length - 1)
      .filter((line) => line !== "")
      .join(" ");
    lines[ids.length - 1] = folded;
  }
  return ids.map((id, i) => ({ id, text: lines[i] ?? "" }));
}

export class TranslationRunner {
  private readonly engine: RunnerEngine;
  private readonly callbacks: RunnerCallbacks;
  private readonly flushAfterMs: number;
  private readonly maxPairs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  private readonly queue = new TranslationQueue();
  private pairs: TranslationPair[] = [];
  private running = false;
  private flushTimer: unknown = null;
  private idleWaiters: (() => void)[] = [];

  constructor(options: RunnerOptions) {
    this.engine = options.engine;
    this.callbacks = options.callbacks;
    this.flushAfterMs = options.flushAfterMs ?? 400;
    this.maxPairs = options.maxPairs ?? 8;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Sentences waiting plus the in-flight batch indicator (for tests). */
  get busy(): boolean {
    return this.running || this.queue.size > 0;
  }

  enqueue(sentence: RunnerSentence): void {
    // id doubles as the monotonic sequence number (assigned by Rust).
    this.queue.enqueue({ id: String(sentence.id), text: sentence.text, seq: sentence.id });
    this.pump();
  }

  /** Translate everything still queued, then resolve. Used at session stop. */
  drain(): Promise<void> {
    this.clearFlushTimer();
    if (!this.running) {
      const batch = this.queue.flush();
      if (batch) void this.run(batch);
    }
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.running) return;
    const batch = this.queue.nextBatch();
    if (batch) {
      this.clearFlushTimer();
      void this.run(batch);
      return;
    }
    if (this.queue.size > 0 && this.flushTimer === null) {
      // Below minBatch: release after a short idle window so a lone final
      // sentence is never stranded waiting for company.
      this.flushTimer = this.schedule(() => {
        this.flushTimer = null;
        if (this.running) return;
        const flushed = this.queue.flush();
        if (flushed) void this.run(flushed);
      }, this.flushAfterMs);
    }
    this.settleIfIdle();
  }

  private async run(batch: Sentence[]): Promise<void> {
    this.running = true;
    const ids = batch.map((s) => Number(s.id));
    try {
      let finalText = "";
      // Snapshot the rolling pairs: the live array mutates as batches finish,
      // and the engine streams against this context asynchronously.
      for await (const snapshot of this.engine.translate(batch, { pairs: this.pairs.slice() })) {
        finalText = snapshot.text;
        this.callbacks.onSnapshot(assignLines(ids, snapshot.text), snapshot.done);
      }
      const textById = new Map(assignLines(ids, finalText).map((item) => [item.id, item.text]));
      const results: RunnerResult[] = batch
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((s) => ({ id: Number(s.id), source: s.text, text: textById.get(Number(s.id)) ?? "" }));
      for (const result of results) {
        if (result.text !== "") this.pairs.push({ source: result.source, target: result.text });
      }
      if (this.pairs.length > this.maxPairs) this.pairs = this.pairs.slice(-this.maxPairs);
      this.callbacks.onBatchDone(results);
    } catch (error) {
      // Engine errors are content-free by contract (#23); forward the message.
      this.callbacks.onFailed(ids, error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
      this.pump();
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      this.cancel(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private settleIfIdle(): void {
    if (!this.busy && this.idleWaiters.length > 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
