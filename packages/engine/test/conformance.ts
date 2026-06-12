// Shared TranslationEngine conformance suite (issue #6 AC: "same suite runs
// against both engines"). Both the Claude CLI adapter (#5) and the local LLM
// engine (#6) must satisfy these behaviors so #7 can hot-swap between them.

import { describe, it, expect } from "vitest";

import type { Sentence, Translation, TranslationEngine, Usage } from "../src/types";

export interface ConformanceTarget {
  label: string;
  /** Build a fresh, UNSTARTED engine (each call: a new process under the hood). */
  makeEngine: () => Promise<TranslationEngine>;
}

const BATCH: Sentence[] = [{ id: "s1", text: "We are committed to the dual mandate.", seq: 1 }];

export function runTranslationEngineConformance(target: ConformanceTarget): void {
  describe(`TranslationEngine conformance — ${target.label}`, () => {
    it("transitions stopped → ready → stopped", async () => {
      const engine = await target.makeEngine();
      expect(engine.health().status).toBe("stopped");
      await engine.start();
      try {
        expect(engine.health().status).toBe("ready");
      } finally {
        await engine.stop();
      }
      expect(engine.health().status).toBe("stopped");
    });

    it("translate yields a final snapshot carrying the batch ids", async () => {
      const engine = await target.makeEngine();
      await engine.start();
      try {
        const snapshots: Translation[] = [];
        for await (const snapshot of engine.translate(BATCH, { pairs: [] })) snapshots.push(snapshot);
        const final = snapshots.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.sentenceIds).toEqual(["s1"]);
        expect(typeof final?.text).toBe("string");
      } finally {
        await engine.stop();
      }
    });

    it("emits at least one usage event during translate", async () => {
      const engine = await target.makeEngine();
      const usages: Usage[] = [];
      engine.onUsage((u) => usages.push(u));
      await engine.start();
      try {
        const snapshots: Translation[] = [];
        for await (const snapshot of engine.translate(BATCH, { pairs: [] })) snapshots.push(snapshot);
        expect(snapshots.length).toBeGreaterThan(0);
        expect(usages.length).toBeGreaterThan(0);
        expect(typeof usages[0]?.cumulativeCostUsd).toBe("number");
      } finally {
        await engine.stop();
      }
    });

    it("summarize returns a brief with a board array and usage", async () => {
      const engine = await target.makeEngine();
      await engine.start();
      try {
        const brief = await engine.summarize("A short meeting transcript.");
        expect(typeof brief.summary).toBe("string");
        expect(Array.isArray(brief.board)).toBe(true);
        expect(brief.usage).toBeDefined();
      } finally {
        await engine.stop();
      }
    });
  });
}
