// #98 aggregation tests. Synthetic ParsedSession arrays exercise totals,
// chronological trends, the per-session index, and — per the AC (cf. #88) — the
// NaN-free guarantees on empty/partial/non-finite input.

import { describe, it, expect } from "vitest";

import { aggregateSessions } from "../src/dashboard";
import type { ParsedSession } from "../src/parse";

function session(over: {
  title?: string;
  date: string;
  startClock?: string;
  durationMin?: number;
  costUsd?: number;
  sourceLang?: string;
  targetLang?: string;
  metrics?: { talkRatioMic: number; smoothScore: number };
  isRecording?: boolean;
}): ParsedSession {
  return {
    meta: {
      title: over.title ?? "Session",
      headerDate: over.date,
      startClock: over.startClock ?? "10:00",
      endClock: "11:00",
      durationMin: over.durationMin ?? 0,
      sourceLang: over.sourceLang ?? "EN",
      targetLang: over.targetLang ?? "KO",
      engineName: "Claude CLI",
      costUsd: over.costUsd ?? 0,
    },
    summary: [],
    board: { decisions: [], actionItems: [], openQuestions: [] },
    metrics: over.metrics,
    entries: [],
    isRecording: over.isRecording ?? false,
  };
}

describe("aggregateSessions — empty input", () => {
  it("returns zeros, null averages, and empty arrays — never NaN", () => {
    const stats = aggregateSessions([]);
    expect(stats).toEqual({
      totalSessions: 0,
      completedSessions: 0,
      totalDurationMin: 0,
      totalCostUsd: 0,
      averageTalkRatioMic: null,
      averageSmoothScore: null,
      talkRatioTrend: [],
      smoothScoreTrend: [],
      index: [],
    });
  });
});

describe("aggregateSessions — totals and averages", () => {
  const sessions = [
    session({ date: "2026-06-11", durationMin: 47, costUsd: 0.31, metrics: { talkRatioMic: 0.4, smoothScore: 80 } }),
    session({ date: "2026-06-12", durationMin: 33, costUsd: 0.19, metrics: { talkRatioMic: 0.6, smoothScore: 90 } }),
  ];

  it("sums duration and cost and means the metrics", () => {
    const stats = aggregateSessions(sessions);
    expect(stats.totalSessions).toBe(2);
    expect(stats.completedSessions).toBe(2);
    expect(stats.totalDurationMin).toBe(80);
    expect(stats.totalCostUsd).toBe(0.5); // 0.31 + 0.19, cent-rounded (no float artifact)
    expect(stats.averageTalkRatioMic).toBeCloseTo(0.5, 10);
    expect(stats.averageSmoothScore).toBe(85);
  });

  it("builds a per-session index row for every session", () => {
    const stats = aggregateSessions(sessions);
    expect(stats.index).toHaveLength(2);
    expect(stats.index[0]).toMatchObject({
      date: "2026-06-11",
      durationMin: 47,
      costUsd: 0.31,
      talkRatioMic: 0.4,
      smoothScore: 80,
      sourceLang: "EN",
      targetLang: "KO",
      isRecording: false,
    });
  });
});

describe("aggregateSessions — sessions without metrics", () => {
  it("counts them in totals but excludes them from metric averages and trends", () => {
    const stats = aggregateSessions([
      session({ date: "2026-06-10", durationMin: 20, costUsd: 0.1 }), // no metrics
      session({ date: "2026-06-11", durationMin: 30, costUsd: 0.2, metrics: { talkRatioMic: 0.5, smoothScore: 70 } }),
    ]);
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalDurationMin).toBe(50);
    expect(stats.totalCostUsd).toBe(0.3);
    // Average over the ONE session that has metrics — the metric-less one does not drag it to 0.
    expect(stats.averageTalkRatioMic).toBe(0.5);
    expect(stats.averageSmoothScore).toBe(70);
    expect(stats.talkRatioTrend).toHaveLength(1);
    expect(stats.smoothScoreTrend).toHaveLength(1);
    // The metric-less session's index row carries explicit nulls (not 0).
    expect(stats.index[0]).toMatchObject({ date: "2026-06-10", talkRatioMic: null, smoothScore: null });
  });
});

describe("aggregateSessions — in-progress recording", () => {
  it("counts it in totalSessions but not completedSessions, and never in metric averages", () => {
    const stats = aggregateSessions([
      session({ date: "2026-06-11", durationMin: 40, costUsd: 0.25, metrics: { talkRatioMic: 0.5, smoothScore: 88 } }),
      session({ title: "(recording)", date: "2026-06-12", durationMin: 0, costUsd: 0, isRecording: true }),
    ]);
    expect(stats.totalSessions).toBe(2);
    expect(stats.completedSessions).toBe(1);
    expect(stats.totalDurationMin).toBe(40);
    // Only the finalized session feeds the average.
    expect(stats.averageSmoothScore).toBe(88);
    expect(stats.index.find((r) => r.isRecording)?.title).toBe("(recording)");
  });
});

describe("aggregateSessions — ordering and immutability", () => {
  it("emits trends and index in chronological order regardless of input order", () => {
    const stats = aggregateSessions([
      session({ date: "2026-06-13", startClock: "09:00", metrics: { talkRatioMic: 0.3, smoothScore: 60 } }),
      session({ date: "2026-06-11", startClock: "14:00", metrics: { talkRatioMic: 0.5, smoothScore: 80 } }),
      session({ date: "2026-06-11", startClock: "09:00", metrics: { talkRatioMic: 0.4, smoothScore: 70 } }),
    ]);
    expect(stats.smoothScoreTrend.map((p) => `${p.date} ${p.startClock}`)).toEqual([
      "2026-06-11 09:00",
      "2026-06-11 14:00",
      "2026-06-13 09:00",
    ]);
    expect(stats.smoothScoreTrend.map((p) => p.value)).toEqual([70, 80, 60]);
  });

  it("does not mutate the caller's array", () => {
    const input = [
      session({ date: "2026-06-13" }),
      session({ date: "2026-06-11" }),
    ];
    const before = input.map((s) => s.meta.headerDate);
    aggregateSessions(input);
    expect(input.map((s) => s.meta.headerDate)).toEqual(before);
  });
});

describe("aggregateSessions — NaN safety on non-finite inputs (cf. #88)", () => {
  it("treats non-finite duration/cost/metrics as 0 so totals stay finite", () => {
    const bad = session({ date: "2026-06-11" });
    bad.meta.durationMin = Number.NaN;
    bad.meta.costUsd = Number.POSITIVE_INFINITY;
    bad.metrics = { talkRatioMic: Number.NaN, smoothScore: Number.NaN };

    const stats = aggregateSessions([bad]);
    expect(Number.isFinite(stats.totalDurationMin)).toBe(true);
    expect(Number.isFinite(stats.totalCostUsd)).toBe(true);
    expect(stats.totalDurationMin).toBe(0);
    expect(stats.totalCostUsd).toBe(0);
    // A metrics object exists, so it IS averaged — but the non-finite values
    // are guarded to 0, keeping the average finite rather than NaN.
    expect(stats.averageTalkRatioMic).toBe(0);
    expect(stats.averageSmoothScore).toBe(0);
  });
});
