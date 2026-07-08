// TranslationRunner (#11): consumes the engine package's queue discipline and
// streams progressive per-sentence snapshots. Fake engine — fully headless.
//
// Dispatch model (#142): the runner is idle-fast — a lone finalized sentence is
// dispatched as a batch-of-1 the moment the engine is idle (no 400ms wait).
// Batching only shapes the BUSY path: sentences that arrive while a batch is in
// flight accumulate and go out together. Tests that need a genuine multi-sentence
// batch therefore hold the first (lone) dispatch with a gate so the rest pile up.
import { describe, expect, it } from "vitest";

import type { RollingContext, Sentence, Translation } from "@livecap/engine";
import {
  assignLines,
  countOutputLines,
  TranslationRunner,
  type RunnerCallbacks,
  type RunnerItem,
  type RunnerResult,
} from "../src/host/translation-runner";

interface Call {
  batch: Sentence[];
  ctx: RollingContext;
}

/** One output line per sentence: `tr-<id>` in input order. */
const respondTr = (batch: Sentence[]): string => batch.map((s) => `tr-${s.id}`).join("\n");

/** An engine that yields one streaming snapshot then a done snapshot, with
 *  per-batch text produced by `respond`. */
function fakeEngine(calls: Call[], respond: (batch: Sentence[]) => string, fail = false) {
  return {
    async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
      calls.push({ batch, ctx });
      if (fail) throw new Error("translation turn failed (api_error_status=429)");
      const ids = batch.map((s) => s.id);
      const text = respond(batch);
      yield { sentenceIds: ids, text: text.slice(0, Math.ceil(text.length / 2)), done: false };
      yield { sentenceIds: ids, text, done: true };
    },
  };
}

/** A one-shot promise the test resolves to release a held engine turn, so later
 *  sentences accumulate into a multi-sentence batch while the first is in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve: () => resolve() };
}

interface Recorded {
  snapshots: { items: RunnerItem[]; done: boolean }[];
  batches: RunnerResult[][];
  failures: { ids: number[]; detail: string }[];
}

function recorder(): { callbacks: RunnerCallbacks; recorded: Recorded } {
  const recorded: Recorded = { snapshots: [], batches: [], failures: [] };
  return {
    recorded,
    callbacks: {
      onSnapshot: (items, done) => recorded.snapshots.push({ items, done }),
      onBatchDone: (results) => recorded.batches.push(results),
      onFailed: (ids, detail) => recorded.failures.push({ ids, detail }),
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("assignLines", () => {
  it("maps one output line per sentence, in order", () => {
    expect(assignLines([4, 5], "안녕\n좋아요")).toEqual([
      { id: 4, text: "안녕" },
      { id: 5, text: "좋아요" },
    ]);
  });

  it("yields empty strings for not-yet-streamed sentences", () => {
    expect(assignLines([1, 2, 3], "첫")).toEqual([
      { id: 1, text: "첫" },
      { id: 2, text: "" },
      { id: 3, text: "" },
    ]);
  });

  it("folds surplus lines into the last sentence", () => {
    expect(assignLines([1], "한 줄\n두 줄")).toEqual([{ id: 1, text: "한 줄 두 줄" }]);
  });

  it("drops internal blank lines so they never shift the mapping (#137)", () => {
    // 3 real translations with a spurious internal blank line: split("\n") would
    // be length 4 and fold/shift, but the blank is not a mapping unit.
    expect(assignLines([1, 2, 3], "tr-1\n\ntr-2\ntr-3")).toEqual([
      { id: 1, text: "tr-1" },
      { id: 2, text: "tr-2" },
      { id: 3, text: "tr-3" },
    ]);
    // Leading/trailing blanks are ignored too.
    expect(assignLines([1, 2], "\ntr-1\ntr-2\n")).toEqual([
      { id: 1, text: "tr-1" },
      { id: 2, text: "tr-2" },
    ]);
  });
});

describe("countOutputLines", () => {
  it("counts non-empty trimmed lines", () => {
    expect(countOutputLines("a\nb\nc")).toBe(3);
    expect(countOutputLines("a")).toBe(1);
  });

  it("ignores blank and whitespace-only lines", () => {
    expect(countOutputLines("a\n\nb\n   \nc")).toBe(3);
    expect(countOutputLines("")).toBe(0);
    expect(countOutputLines("   ")).toBe(0);
  });
});

describe("TranslationRunner", () => {
  it("dispatches a lone sentence immediately as a batch-of-1 when idle — no wait for company (#142)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const runner = new TranslationRunner({ engine: fakeEngine(calls, respondTr), callbacks });

    runner.enqueue({ id: 1, text: "lone" });
    await tick();
    // Dispatched on its own the moment the engine was idle — no minBatch companion
    // and no 400ms flush window (both gone under idle-fast).
    expect(calls).toHaveLength(1);
    expect(calls[0].batch.map((s) => Number(s.id))).toEqual([1]);

    await runner.drain();
    expect(recorded.batches[0]).toEqual([{ id: 1, source: "lone", text: "tr-1" }]);
  });

  it("streams progressive in-progress snapshots for a single-sentence batch", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const runner = new TranslationRunner({ engine: fakeEngine(calls, respondTr), callbacks });

    runner.enqueue({ id: 1, text: "lone sentence" });
    await runner.drain();

    // A lone id can't be mis-mapped, so live streaming is preserved (<1.5s display).
    expect(recorded.snapshots.some((s) => !s.done)).toBe(true);
    expect(recorded.snapshots.at(-1)?.done).toBe(true);
    expect(recorded.batches[0]).toEqual([{ id: 1, source: "lone sentence", text: "tr-1" }]);
  });

  it("batches sentences that arrive while a batch is in flight, and never caption-binds interim text for a multi-sentence batch (#142/#137)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        const ids = batch.map((s) => s.id);
        const text = respondTr(batch);
        // An interim (non-done) snapshot, to prove it is never caption-bound for a
        // multi-sentence batch.
        yield { sentenceIds: ids, text: text.slice(0, Math.ceil(text.length / 2)), done: false };
        if (calls.length === 1) await gate; // hold the lone first dispatch
        yield { sentenceIds: ids, text, done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "one" }); // idle → dispatched alone, then held
    await tick();
    runner.enqueue({ id: 2, text: "two" }); // queued while [1] is in flight
    runner.enqueue({ id: 3, text: "three" }); // queued → batches with 2
    release();
    await runner.drain();

    // First the lone sentence, then the two that arrived during it as ONE batch.
    expect(calls.map((c) => c.batch.map((s) => Number(s.id)))).toEqual([[1], [2, 3]]);
    // The multi-sentence [2,3] batch never bound an interim snapshot to a caption:
    // only the single [1] batch (which can't be mis-mapped) streamed a non-done one.
    for (const snap of recorded.snapshots) {
      if (!snap.done) expect(snap.items.map((i) => i.id)).toEqual([1]);
    }
    expect(recorded.batches).toEqual([
      [{ id: 1, source: "one", text: "tr-1" }],
      [
        { id: 2, source: "two", text: "tr-2" },
        { id: 3, source: "three", text: "tr-3" },
      ],
    ]);
  });

  it("merges a backlog newest-first while a batch is in flight (PROPOSAL §3)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (calls.length === 1) await gate; // first (lone) batch hangs until released
        yield { sentenceIds: batch.map((s) => s.id), text: respondTr(batch), done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "a" }); // dispatched alone, held
    await tick();
    for (let id = 2; id <= 8; id++) runner.enqueue({ id, text: `s${id}` }); // 7 > maxBatch backlog
    release();
    await runner.drain();

    expect(calls).toHaveLength(2);
    // The merged backlog goes out newest-first so the latest speech leads.
    expect(calls[1].batch.map((s) => s.seq)).toEqual([8, 7, 6, 5, 4, 3, 2]);
    // Archive-facing results come back in spoken order regardless.
    expect(recorded.batches[1].map((r) => r.id)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("feeds completed pairs into the next request's rolling context", async () => {
    const calls: Call[] = [];
    const { callbacks } = recorder();
    const runner = new TranslationRunner({ engine: fakeEngine(calls, respondTr), callbacks });

    runner.enqueue({ id: 1, text: "one" });
    await runner.drain();
    runner.enqueue({ id: 2, text: "two" });
    await runner.drain();

    // The second request carries the first completed pair as rolling context.
    expect(calls[1].ctx.pairs).toEqual([{ source: "one", target: "tr-1" }]);
  });

  it("reports a failed batch with a content-free detail and keeps running", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        const ids = batch.map((s) => s.id);
        if (calls.length === 1) {
          await gate; // warm the engine so ids 2 & 3 accumulate into one batch
          yield { sentenceIds: ids, text: "tr-1", done: true };
          return;
        }
        if (batch.length > 1) throw new Error("translation turn failed (api_error_status=500)");
        yield { sentenceIds: ids, text: "ok", done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" });
    await tick();
    runner.enqueue({ id: 2, text: "fails" });
    runner.enqueue({ id: 3, text: "fails too" });
    release();
    await runner.drain();
    expect(recorded.failures).toEqual([
      { ids: [2, 3], detail: "translation turn failed (api_error_status=500)" },
    ]);

    runner.enqueue({ id: 4, text: "works" });
    await runner.drain();
    expect(recorded.batches.at(-1)?.[0]).toEqual({ id: 4, source: "works", text: "ok" });
  });

  it("does not re-translate when the output line count matches the batch (#137)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (calls.length === 1) await gate;
        yield { sentenceIds: batch.map((s) => s.id), text: respondTr(batch), done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" });
    await tick();
    runner.enqueue({ id: 2, text: "two" });
    runner.enqueue({ id: 3, text: "three" });
    release();
    await runner.drain();

    // The [2,3] batch's line count matched → the positional map is used; no 1:1.
    expect(calls.map((c) => c.batch.length)).toEqual([1, 2]);
    expect(recorded.batches[1]).toEqual([
      { id: 2, source: "two", text: "tr-2" },
      { id: 3, source: "three", text: "tr-3" },
    ]);
  });

  it("re-translates 1:1 when the model returns fewer lines than the batch — no caption shows another's (#137)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        const ids = batch.map((s) => s.id);
        if (calls.length === 1) {
          await gate;
          yield { sentenceIds: ids, text: "tr-1", done: true };
          return;
        }
        if (batch.length > 1) {
          // The model MERGED two fragments into a single output line: 1 line for
          // 2 ids. A positional map would shift id 3 onto nothing (or a neighbor).
          // Emit a non-done interim too, to prove it is never bound to a caption.
          yield { sentenceIds: ids, text: "merged-one", done: false };
          yield { sentenceIds: ids, text: "merged-one-two", done: true };
          return;
        }
        yield { sentenceIds: ids, text: `tr-${batch[0].id}`, done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" });
    await tick();
    runner.enqueue({ id: 2, text: "two" });
    runner.enqueue({ id: 3, text: "three" });
    release();
    await runner.drain();

    // The [2,3] batch mismatched, so each sentence was re-requested 1:1.
    expect(calls.map((c) => c.batch.length)).toEqual([1, 2, 1, 1]);
    // Each caption is attributed to its OWN translation — never a neighbor's, and
    // the merged line is never persisted under any id.
    expect(recorded.batches).toEqual([
      [{ id: 1, source: "warm", text: "tr-1" }],
      [
        { id: 2, source: "two", text: "tr-2" },
        { id: 3, source: "three", text: "tr-3" },
      ],
    ]);
    // No snapshot — interim OR done — ever bound the merged line to a caption.
    for (const snap of recorded.snapshots) {
      for (const item of snap.items) {
        expect(item.text === "" || item.text === `tr-${item.id}`).toBe(true);
      }
    }
    expect(recorded.failures).toEqual([]);
  });

  it("re-translates 1:1 when the model prepends an extra preamble line (#137)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        const ids = batch.map((s) => s.id);
        if (calls.length === 1) {
          await gate;
          yield { sentenceIds: ids, text: "tr-1", done: true };
          return;
        }
        if (batch.length > 1) {
          // A preamble line before the two translations: 3 lines for 2 ids.
          yield { sentenceIds: ids, text: "Here is the translation:\ntr-2\ntr-3", done: true };
          return;
        }
        yield { sentenceIds: ids, text: `tr-${batch[0].id}`, done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" });
    await tick();
    runner.enqueue({ id: 2, text: "two" });
    runner.enqueue({ id: 3, text: "three" });
    release();
    await runner.drain();

    expect(calls.map((c) => c.batch.length)).toEqual([1, 2, 1, 1]);
    expect(recorded.batches).toEqual([
      [{ id: 1, source: "warm", text: "tr-1" }],
      [
        { id: 2, source: "two", text: "tr-2" },
        { id: 3, source: "three", text: "tr-3" },
      ],
    ]);
  });

  it("does not persist a shifted map when a >=3-sentence batch has internal blank lines (#137)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        const ids = batch.map((s) => s.id);
        if (calls.length === 1) {
          await gate; // hold [1] so ids 2,3,4 merge into one >=3-sentence batch
          yield { sentenceIds: ids, text: "tr-1", done: true };
          return;
        }
        // One line per sentence with a spurious internal blank line injected.
        const text = respondTr(batch).replace("\n", "\n\n");
        yield { sentenceIds: ids, text, done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" });
    await tick();
    runner.enqueue({ id: 2, text: "two" });
    runner.enqueue({ id: 3, text: "three" });
    runner.enqueue({ id: 4, text: "four" });
    release();
    await runner.drain();

    // The internal blank made split("\n") length 4 for 3 ids — pre-fix this
    // folded/shifted while the count guard still read "matched" (3 non-empty ==
    // 3). Each caption must map to its OWN translation; nothing shifted, nothing
    // persisted under the wrong id, and no 1:1 re-request was needed.
    expect(calls).toHaveLength(2);
    expect(recorded.batches[1]).toEqual([
      { id: 2, source: "two", text: "tr-2" },
      { id: 3, source: "three", text: "tr-3" },
      { id: 4, source: "four", text: "tr-4" },
    ]);
  });

  it("marks an un-mappable id failed when its 1:1 re-translation throws; source preserved (#137)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        const ids = batch.map((s) => s.id);
        if (calls.length === 1) {
          await gate;
          yield { sentenceIds: ids, text: "tr-1", done: true };
          return;
        }
        if (batch.length > 1) {
          yield { sentenceIds: ids, text: "only-one-line", done: true }; // 1 line, 2 ids → mismatch
          return;
        }
        if (Number(batch[0].id) === 3) throw new Error("translation turn failed (api_error_status=500)");
        yield { sentenceIds: ids, text: `tr-${batch[0].id}`, done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" });
    await tick();
    runner.enqueue({ id: 2, text: "two" });
    runner.enqueue({ id: 3, text: "three" });
    release();
    await runner.drain();

    // id 3's re-translation failed → reported failed (host preserves its source);
    // id 2 succeeded and is persisted. Neither is shown under the wrong id.
    expect(recorded.failures).toEqual([{ ids: [3], detail: "translation turn failed (api_error_status=500)" }]);
    expect(recorded.batches).toEqual([
      [{ id: 1, source: "warm", text: "tr-1" }],
      [{ id: 2, source: "two", text: "tr-2" }],
    ]);
  });

  it("dedups an id already pending — it can't appear twice in one batch (#139)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (calls.length === 1) await gate; // hold [1] so ids 5 & 6 queue behind it
        yield { sentenceIds: batch.map((s) => s.id), text: respondTr(batch), done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" }); // dispatched alone, held
    await tick();
    runner.enqueue({ id: 5, text: "five" }); // queued while [1] is in flight
    runner.enqueue({ id: 5, text: "five dup" }); // same id still pending → coalesced
    runner.enqueue({ id: 6, text: "six" }); // queued → batches with 5
    release();
    await runner.drain();

    expect(calls[1].batch.map((s) => Number(s.id))).toEqual([5, 6]); // no second 5
    expect(recorded.batches[1]).toEqual([
      { id: 5, source: "five", text: "tr-5" },
      { id: 6, source: "six", text: "tr-6" },
    ]);
  });

  it("dispatches a user retranslate ahead of queued live captions (#139)", async () => {
    const calls: Call[] = [];
    const { callbacks } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (calls.length === 1) await gate; // hold [1] so a live caption queues behind it
        yield { sentenceIds: batch.map((s) => s.id), text: respondTr(batch), done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" }); // dispatched alone, held
    await tick();
    runner.enqueue({ id: 5, text: "live caption" }); // queued behind the in-flight batch
    runner.retranslate({ id: 99, text: "fix this old line" }); // jumps ahead of the queued caption
    release();
    await runner.drain();

    // After the in-flight batch, the retranslate goes out BEFORE the queued caption.
    expect(calls[1].batch.map((s) => Number(s.id))).toEqual([99]);
    expect(calls[2].batch.map((s) => Number(s.id))).toEqual([5]);
  });

  it("coalesces a retranslate of an id whose original is still pending (#139)", async () => {
    const calls: Call[] = [];
    const { callbacks } = recorder();
    const { promise: gate, resolve: release } = deferred();
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (calls.length === 1) await gate;
        yield { sentenceIds: batch.map((s) => s.id), text: respondTr(batch), done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks });

    runner.enqueue({ id: 1, text: "warm" }); // dispatched alone, held
    await tick();
    runner.enqueue({ id: 5, text: "orig" }); // queued, still pending
    runner.retranslate({ id: 5, text: "orig" }); // id 5 already pending → coalesced, no priority dispatch
    runner.enqueue({ id: 6, text: "six" }); // releases [5,6]
    release();
    await runner.drain();

    const allIds = calls.flatMap((c) => c.batch.map((s) => Number(s.id)));
    expect(allIds.filter((id) => id === 5)).toHaveLength(1); // id 5 dispatched exactly once
  });

  it("keeps a retranslate result out of the live rolling context (#139)", async () => {
    const calls: Call[] = [];
    const { callbacks } = recorder();
    const runner = new TranslationRunner({ engine: fakeEngine(calls, respondTr), callbacks });

    runner.retranslate({ id: 99, text: "historical line" });
    await runner.drain();
    runner.enqueue({ id: 1, text: "one" });
    await runner.drain();

    // The live batch sees NO context from the historical retranslate (its pairing
    // was never pushed into the rolling window).
    const liveCall = calls.find((c) => c.batch.some((s) => Number(s.id) === 1));
    expect(liveCall?.ctx.pairs).toEqual([]);
  });

  it("feeds NORMAL completed pairs into context but not retranslate results (#139)", async () => {
    const calls: Call[] = [];
    const { callbacks } = recorder();
    const runner = new TranslationRunner({ engine: fakeEngine(calls, respondTr), callbacks });

    runner.enqueue({ id: 1, text: "one" });
    await runner.drain();
    runner.enqueue({ id: 2, text: "two" });
    await runner.drain();
    runner.retranslate({ id: 99, text: "old" }); // must NOT enter context
    await runner.drain();
    runner.enqueue({ id: 3, text: "three" });
    await runner.drain();

    // Live pairs carry the earlier live batches, never the retranslate.
    const lastLive = calls.find((c) => c.batch.some((s) => Number(s.id) === 3));
    expect(lastLive?.ctx.pairs).toEqual([
      { source: "one", target: "tr-1" },
      { source: "two", target: "tr-2" },
    ]);
  });
});
