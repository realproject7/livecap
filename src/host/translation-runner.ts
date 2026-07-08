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
  /** Rolling-context pairs retained. Default 8. */
  maxPairs?: number;
}

/**
 * Map a whole-batch translation snapshot onto its sentences: the prompt
 * contract is one output line per input sentence, in input order. Extra lines
 * beyond the batch are folded into the last sentence.
 *
 * Blank lines are dropped BEFORE mapping (#137): they carry no translation and
 * are not a mapping unit, so the positional map uses the SAME non-empty lines
 * {@link countOutputLines} counts. Otherwise an internal blank line makes
 * split("\n") longer than the id count and folds/shifts later captions while the
 * count guard still reads "matched" — persisting a mis-attributed mapping.
 */
export function assignLines(ids: number[], text: string): RunnerItem[] {
  if (ids.length === 0) return [];
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > ids.length) {
    const folded = lines.splice(ids.length - 1).join(" ");
    lines[ids.length - 1] = folded;
  }
  return ids.map((id, i) => ({ id, text: lines[i] ?? "" }));
}

/**
 * Count the model's actual output lines — the unit {@link assignLines} maps
 * positionally onto sentence ids. Blank lines carry no translation and are
 * excluded, matching the same lines assignLines maps (blanks can't shift the
 * map — they are dropped there too). A count that differs from the batch size
 * means the model merged fragments (fewer lines) or emitted an extra non-blank
 * preamble line (more), which WOULD shift every subsequent caption's mapping —
 * so positional attribution is unsafe and the batch is re-translated 1:1 (#137).
 */
export function countOutputLines(text: string): number {
  return text.split("\n").reduce((n, line) => (line.trim() === "" ? n : n + 1), 0);
}

export class TranslationRunner {
  private readonly engine: RunnerEngine;
  private readonly callbacks: RunnerCallbacks;
  private readonly maxPairs: number;

  private readonly queue = new TranslationQueue();
  private pairs: TranslationPair[] = [];
  private running = false;
  private idleWaiters: (() => void)[] = [];
  /** User-initiated retranslates, dispatched ahead of the live queue (#139). */
  private readonly priority: Sentence[] = [];
  /** Ids queued (live queue or priority) but not yet dispatched — for dedup. */
  private readonly pendingIds = new Set<number>();
  /** Ids in the currently-running batch — for dedup while a batch is in flight. */
  private readonly inFlightIds = new Set<number>();

  constructor(options: RunnerOptions) {
    this.engine = options.engine;
    this.callbacks = options.callbacks;
    this.maxPairs = options.maxPairs ?? 8;
  }

  /** Sentences waiting plus the in-flight batch indicator (for tests). */
  get busy(): boolean {
    return this.running || this.queue.size > 0 || this.priority.length > 0;
  }

  enqueue(sentence: RunnerSentence): void {
    // Dedup (#139): an id already waiting or in flight must not be queued again —
    // it would otherwise land twice, even twice in one batch.
    if (this.pendingIds.has(sentence.id) || this.inFlightIds.has(sentence.id)) return;
    this.pendingIds.add(sentence.id);
    // id doubles as the monotonic sequence number (assigned by Rust).
    this.queue.enqueue({ id: String(sentence.id), text: sentence.text, seq: sentence.id });
    this.pump();
  }

  /**
   * Re-translate an already-shown sentence on user request (#139). It jumps
   * AHEAD of the live queue — a "fix this line now" gesture must get the best
   * latency, not wait behind the backlog + mutex — and is deduped like enqueue so
   * it can't coexist with the id's still-pending original or double up in a
   * batch. Its result is kept OUT of the live rolling context (it is historical).
   */
  retranslate(sentence: RunnerSentence): void {
    if (this.pendingIds.has(sentence.id) || this.inFlightIds.has(sentence.id)) return;
    this.pendingIds.add(sentence.id);
    this.priority.push({ id: String(sentence.id), text: sentence.text, seq: sentence.id });
    this.pump();
  }

  /** Translate everything still queued, then resolve. Used at session stop. */
  drain(): Promise<void> {
    this.pump();
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.running) return;
    // User-initiated retranslates jump ahead of the live backlog (#139).
    if (this.priority.length > 0) {
      void this.run(this.priority.splice(0), true);
      return;
    }
    // Idle-fast dispatch (#142): the engine is idle here (nothing in flight), so
    // ship the next work NOW rather than waiting for a lone sentence to gather
    // company. nextBatch() still absorbs an accumulated backlog (newest-first
    // when backlogged, up to maxBatch otherwise); a lone below-minBatch sentence
    // falls through to flush() and goes out as a batch-of-1 — no 400ms wait.
    // Batching now only shapes the BUSY path: sentences that arrive while a batch
    // is in flight pile up and leave together on the next pump (bursts batch).
    const batch = this.queue.nextBatch() ?? this.queue.flush();
    if (batch) {
      void this.run(batch, false);
      return;
    }
    this.settleIfIdle();
  }

  private async run(batch: Sentence[], retranslate: boolean): Promise<void> {
    this.running = true;
    const ids = batch.map((s) => Number(s.id));
    // Move this batch's ids from pending to in-flight so a duplicate enqueue/
    // retranslate arriving while it runs is coalesced, not double-dispatched (#139).
    for (const id of ids) {
      this.pendingIds.delete(id);
      this.inFlightIds.add(id);
    }
    try {
      let finalText = "";
      // Snapshot the rolling pairs: the live array mutates as batches finish,
      // and the engine streams against this context asynchronously.
      //
      // Stream in-progress snapshots ONLY for a single-sentence batch — a lone id
      // can't be mis-mapped (all output folds into it). For a MULTI-sentence
      // batch, bind NOTHING to captions until the line-count guard below
      // validates the finalized mapping (#137): a positional interim snapshot
      // could briefly render one caption's translation under another id before
      // the guard corrects it. The validated `done` mapping (or the 1:1-corrected
      // one) is the first thing these captions ever show.
      for await (const snapshot of this.engine.translate(batch, { pairs: this.pairs.slice() })) {
        finalText = snapshot.text;
        if (!snapshot.done && ids.length === 1) {
          this.callbacks.onSnapshot(assignLines(ids, snapshot.text), false);
        }
      }
      // Line-mapping guard (#137): the prompt contract is one output line per
      // input sentence, in order. If the model MERGED fragments (an 800ms
      // redemption routinely splits a sentence) or emitted an extra preamble/
      // blank line, the finalized line count != the id count and a positional
      // map would render each caption under the WRONG id — and persist it that
      // way. Never show/persist that: re-translate the batch as 1:1 single-
      // sentence turns, where a lone id can't be mis-attributed. This guards
      // BOTH tiers, since the runner sees each tier's final joined text (the
      // local tier's stripNonTranslation can itself drop an empty line and
      // shift alignment — the same count check catches it).
      if (ids.length > 1 && countOutputLines(finalText) !== ids.length) {
        await this.runOneToOne(batch, retranslate);
        return;
      }
      const mapped = assignLines(ids, finalText);
      this.callbacks.onSnapshot(mapped, true);
      const textById = new Map(mapped.map((item) => [item.id, item.text]));
      const results: RunnerResult[] = batch
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((s) => ({ id: Number(s.id), source: s.text, text: textById.get(Number(s.id)) ?? "" }));
      // A retranslate is a HISTORICAL sentence — keep its pairing OUT of the live
      // rolling context so it can't bias the next live batch (#139).
      if (!retranslate) {
        for (const result of results) {
          if (result.text !== "") this.pairs.push({ source: result.source, target: result.text });
        }
        if (this.pairs.length > this.maxPairs) this.pairs = this.pairs.slice(-this.maxPairs);
      }
      this.callbacks.onBatchDone(results);
    } catch (error) {
      // Engine errors are content-free by contract (#23); forward the message.
      this.callbacks.onFailed(ids, error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
      for (const id of ids) this.inFlightIds.delete(id);
      this.pump();
    }
  }

  /**
   * Fallback for a batch whose finalized output line count didn't match its id
   * count (#137): re-translate each sentence as its own single-sentence turn, so
   * every caption is attributed to its own id (a lone id folds all output lines
   * into itself — mis-attribution is impossible). A sentence whose re-translation
   * throws is reported failed (its source is preserved by the host) rather than
   * shown under the wrong id. Runs inside run()'s `running` slot, so no other
   * batch starts meanwhile; single-sentence turns never re-enter this guard.
   */
  private async runOneToOne(batch: Sentence[], retranslate: boolean): Promise<void> {
    const results: RunnerResult[] = [];
    // Spoken order keeps the archive chronological and the rolling context
    // coherent (each turn sees the prior sentences' freshly-added pairs).
    for (const sentence of batch.slice().sort((a, b) => a.seq - b.seq)) {
      const id = Number(sentence.id);
      try {
        let text = "";
        for await (const snapshot of this.engine.translate([sentence], { pairs: this.pairs.slice() })) {
          text = snapshot.text;
          this.callbacks.onSnapshot(assignLines([id], snapshot.text), snapshot.done);
        }
        const finalText = assignLines([id], text)[0]?.text ?? "";
        // Historical retranslate results stay out of the live rolling context (#139).
        if (!retranslate && finalText !== "") {
          this.pairs.push({ source: sentence.text, target: finalText });
          if (this.pairs.length > this.maxPairs) this.pairs = this.pairs.slice(-this.maxPairs);
        }
        results.push({ id, source: sentence.text, text: finalText });
      } catch (error) {
        // Content-free by contract (#23); the host preserves the source and a
        // later retranslate can fill the target — never a shifted mapping.
        this.callbacks.onFailed([id], error instanceof Error ? error.message : String(error));
      }
    }
    if (results.length > 0) this.callbacks.onBatchDone(results);
  }

  private settleIfIdle(): void {
    if (!this.busy && this.idleWaiters.length > 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
