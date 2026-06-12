// TranslationRunner (#11): consumes the engine package's queue discipline and
// streams progressive per-sentence snapshots. Fake engine, injected timers —
// fully headless.
import { describe, expect, it } from "vitest";

import type { RollingContext, Sentence, Translation } from "@livecap/engine";
import {
  assignLines,
  TranslationRunner,
  type RunnerCallbacks,
  type RunnerItem,
  type RunnerResult,
} from "../src/host/translation-runner";

interface Call {
  batch: Sentence[];
  ctx: RollingContext;
}

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

/** Manually-driven timers so flush windows are deterministic. */
function manualTimers() {
  const timers: { fn: () => void }[] = [];
  return {
    schedule: (fn: () => void) => {
      const handle = { fn };
      timers.push(handle);
      return handle;
    },
    cancel: (handle: unknown) => {
      const index = timers.indexOf(handle as { fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
    fire: () => {
      for (const timer of timers.splice(0)) timer.fn();
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
});

describe("TranslationRunner", () => {
  it("releases a normal batch at minBatch (2) and streams progressive snapshots", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const timers = manualTimers();
    const runner = new TranslationRunner({
      engine: fakeEngine(calls, (batch) => batch.map((s) => `tr-${s.id}`).join("\n")),
      callbacks,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    runner.enqueue({ id: 1, text: "one" });
    runner.enqueue({ id: 2, text: "two" });
    await runner.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0].batch.map((s) => s.seq)).toEqual([1, 2]);
    // At least one non-done snapshot arrived before the done one.
    expect(recorded.snapshots.some((s) => !s.done)).toBe(true);
    expect(recorded.snapshots.at(-1)?.done).toBe(true);
    expect(recorded.batches[0].map((r) => r.text)).toEqual(["tr-1", "tr-2"]);
  });

  it("flushes a lone sentence after the idle window (display must not wait for a batch)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const timers = manualTimers();
    const runner = new TranslationRunner({
      engine: fakeEngine(calls, (batch) => batch.map((s) => `tr-${s.id}`).join("\n")),
      callbacks,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    runner.enqueue({ id: 1, text: "lone sentence" });
    expect(calls).toHaveLength(0); // below minBatch — waiting on the window
    timers.fire();
    await tick();
    expect(calls).toHaveLength(1);
    expect(recorded.batches[0]).toEqual([{ id: 1, source: "lone sentence", text: "tr-1" }]);
  });

  it("merges a backlog newest-first while a batch is in flight (PROPOSAL §3)", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (calls.length === 1) await gate; // first batch hangs until released
        yield {
          sentenceIds: batch.map((s) => s.id),
          text: batch.map((s) => `tr-${s.id}`).join("\n"),
          done: true,
        };
      },
    };
    const timers = manualTimers();
    const runner = new TranslationRunner({ engine, callbacks, schedule: timers.schedule, cancel: timers.cancel });

    runner.enqueue({ id: 1, text: "a" });
    runner.enqueue({ id: 2, text: "b" });
    await tick(); // batch [1,2] in flight, gated
    for (let id = 3; id <= 8; id++) runner.enqueue({ id, text: `s${id}` }); // 6 > maxBatch backlog
    release();
    await runner.drain();

    expect(calls).toHaveLength(2);
    // The merged backlog goes out newest-first so the latest speech leads.
    expect(calls[1].batch.map((s) => s.seq)).toEqual([8, 7, 6, 5, 4, 3]);
    // Archive-facing results come back in spoken order regardless.
    expect(recorded.batches[1].map((r) => r.id)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("feeds completed pairs into the next request's rolling context", async () => {
    const calls: Call[] = [];
    const { callbacks } = recorder();
    const timers = manualTimers();
    const runner = new TranslationRunner({
      engine: fakeEngine(calls, (batch) => batch.map((s) => `tr-${s.id}`).join("\n")),
      callbacks,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    runner.enqueue({ id: 1, text: "one" });
    runner.enqueue({ id: 2, text: "two" });
    await runner.drain();
    runner.enqueue({ id: 3, text: "three" });
    runner.enqueue({ id: 4, text: "four" });
    await runner.drain();

    expect(calls[1].ctx.pairs).toEqual([
      { source: "one", target: "tr-1" },
      { source: "two", target: "tr-2" },
    ]);
  });

  it("reports failed batches with a content-free detail and keeps running", async () => {
    const calls: Call[] = [];
    const { callbacks, recorded } = recorder();
    const timers = manualTimers();
    let failNext = true;
    const engine = {
      async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
        calls.push({ batch, ctx });
        if (failNext) {
          failNext = false;
          throw new Error("translation turn failed (api_error_status=500)");
        }
        yield { sentenceIds: batch.map((s) => s.id), text: "ok", done: true };
      },
    };
    const runner = new TranslationRunner({ engine, callbacks, schedule: timers.schedule, cancel: timers.cancel });

    runner.enqueue({ id: 1, text: "fails" });
    runner.enqueue({ id: 2, text: "fails too" });
    await runner.drain();
    expect(recorded.failures).toEqual([
      { ids: [1, 2], detail: "translation turn failed (api_error_status=500)" },
    ]);

    runner.enqueue({ id: 3, text: "works" });
    timers.fire();
    await runner.drain();
    expect(recorded.batches.at(-1)?.[0]).toEqual({ id: 3, source: "works", text: "ok" });
  });
});
