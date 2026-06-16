// #78: meeting metrics — talk-time ratio + Smooth Score. Pure, deterministic,
// no LLM/network — driven entirely by synthetic record arrays.

import { describe, it, expect } from "vitest";

import { computeMeetingMetrics, type FinalizedRecord } from "../src/meeting-metrics";

const MIN = 60_000; // ms per minute

function mic(text: string, durationMs = 1000, lowConfidence = false): FinalizedRecord {
  return { channel: "mic", durationMs, text, lowConfidence };
}
function system(text: string, durationMs = 1000, lowConfidence = false): FinalizedRecord {
  return { channel: "system", durationMs, text, lowConfidence };
}

describe("computeMeetingMetrics — talk-time ratio", () => {
  it("computes the mic share from per-channel spoken duration (8m mic / 12m system → 40%)", () => {
    const { talkTime } = computeMeetingMetrics([
      mic("hello there", 8 * MIN),
      system("and from us", 12 * MIN),
    ]);
    expect(talkTime.micMs).toBe(8 * MIN);
    expect(talkTime.systemMs).toBe(12 * MIN);
    expect(talkTime.totalMs).toBe(20 * MIN);
    expect(talkTime.micShare).toBeCloseTo(0.4, 10);
  });

  it("sums durations across many records of each channel", () => {
    const { talkTime } = computeMeetingMetrics([
      mic("a", 1000),
      system("b", 2000),
      mic("c", 3000),
      system("d", 4000),
    ]);
    expect(talkTime.micMs).toBe(4000);
    expect(talkTime.systemMs).toBe(6000);
    expect(talkTime.micShare).toBeCloseTo(0.4, 10);
  });

  it("returns a 0 share (not NaN) when there is no speech at all", () => {
    const { talkTime } = computeMeetingMetrics([]);
    expect(talkTime).toEqual({ micMs: 0, systemMs: 0, totalMs: 0, micShare: 0 });
  });

  it("ignores negative / non-positive durations rather than corrupting the ratio", () => {
    const { talkTime } = computeMeetingMetrics([
      mic("a", 1000),
      mic("bad", -500),
      system("b", 1000),
      system("bad", 0),
    ]);
    expect(talkTime.micMs).toBe(1000);
    expect(talkTime.systemMs).toBe(1000);
    expect(talkTime.micShare).toBeCloseTo(0.5, 10);
  });

  it("treats non-finite durations (Infinity/-Infinity/NaN) as zero — micShare stays in [0,1] (#88)", () => {
    // Without the finiteness gate, Infinity > 0 passes through and micShare
    // becomes Infinity/Infinity = NaN. It must read as 0 here.
    const a = computeMeetingMetrics([
      mic("a", Number.POSITIVE_INFINITY),
      system("b", 1000),
    ]).talkTime;
    expect(Number.isNaN(a.micShare)).toBe(false);
    expect(a.micShare).toBe(0);
    expect(a.micMs).toBe(0);
    expect(a.systemMs).toBe(1000);

    // Infinity mic with no system speech → no finite speech at all → 0, not NaN.
    const b = computeMeetingMetrics([mic("a", Number.POSITIVE_INFINITY)]).talkTime;
    expect(Number.isNaN(b.micShare)).toBe(false);
    expect(b.micShare).toBe(0);
    expect(b.totalMs).toBe(0);

    // -Infinity and NaN are likewise dropped; only the finite mic duration counts.
    const c = computeMeetingMetrics([
      mic("a", 1000),
      mic("bad", Number.NEGATIVE_INFINITY),
      mic("bad", Number.NaN),
      system("s", Number.POSITIVE_INFINITY),
    ]).talkTime;
    expect(c.micMs).toBe(1000);
    expect(c.systemMs).toBe(0);
    expect(c.micShare).toBe(1);
    expect(c.micShare).toBeGreaterThanOrEqual(0);
    expect(c.micShare).toBeLessThanOrEqual(1);
  });
});

describe("computeMeetingMetrics — Smooth Score", () => {
  it("is 100 for clean mic speech with no fillers and full confidence", () => {
    const { smoothScore, signals } = computeMeetingMetrics([
      mic("hello there how are you today"),
      mic("let us begin the review now"),
    ]);
    expect(smoothScore).toBe(100);
    expect(signals.fillerCount).toBe(0);
    expect(signals.repairCount).toBe(0);
  });

  it("is 100 (nothing to penalize) when there is no mic speech", () => {
    const { smoothScore } = computeMeetingMetrics([system("um uh you know", 1000, true)]);
    expect(smoothScore).toBe(100);
  });

  it("matches the documented formula exactly for a known input", () => {
    // tokens: um, uh, hello, there, friend = 5 words; fillers um+uh = 2; repairs 0.
    // density = 2/5 = 0.4; penalty = 2.0 * 0.4 = 0.8; score = round(100 * 0.2) = 20.
    const { smoothScore, signals } = computeMeetingMetrics([mic("um uh hello there friend")]);
    expect(signals.micWordCount).toBe(5);
    expect(signals.fillerCount).toBe(2);
    expect(signals.disfluencyDensity).toBeCloseTo(0.4, 10);
    expect(smoothScore).toBe(20);
  });

  it("stays within [0,100] even for pathologically disfluent input", () => {
    const { smoothScore } = computeMeetingMetrics([mic("음 어 um uh um uh", 1000, true)]);
    expect(smoothScore).toBeGreaterThanOrEqual(0);
    expect(smoothScore).toBeLessThanOrEqual(100);
  });

  it("is monotonic in disfluencies: more fillers → a lower (or equal) score", () => {
    const clean = computeMeetingMetrics([mic("we should ship the feature this week")]).smoothScore;
    const some = computeMeetingMetrics([mic("we should um ship the feature this week")]).smoothScore;
    const more = computeMeetingMetrics([mic("we um should um ship uh the feature this week")])
      .smoothScore;
    expect(some).toBeLessThan(clean);
    expect(more).toBeLessThan(some);
  });

  it("is monotonic in low-confidence rate: more low-confidence utterances → lower score", () => {
    const none = computeMeetingMetrics([mic("alpha", 1000, false), mic("beta", 1000, false)])
      .smoothScore;
    const half = computeMeetingMetrics([mic("alpha", 1000, true), mic("beta", 1000, false)])
      .smoothScore;
    const all = computeMeetingMetrics([mic("alpha", 1000, true), mic("beta", 1000, true)])
      .smoothScore;
    expect(half).toBeLessThan(none);
    expect(all).toBeLessThan(half);
  });

  it("detects English fillers, hedge phrases, and Korean fillers", () => {
    const en = computeMeetingMetrics([mic("um so uh you know it works")]).signals;
    // "um", "uh" (words) + "you know" (phrase) = 3 fillers ("so" is not a filler).
    expect(en.fillerCount).toBe(3);

    const ko = computeMeetingMetrics([mic("음 어 그러니까 시작하죠")]).signals;
    // "음", "어" (words) + "그러니까" (phrase) = 3 fillers.
    expect(ko.fillerCount).toBe(3);
  });

  it("detects repairs: em-dash restarts, immediate word repetition, and 'I mean'", () => {
    const emdash = computeMeetingMetrics([mic("take out—take our personalization")]).signals;
    expect(emdash.repairCount).toBe(1);

    const repeat = computeMeetingMetrics([mic("I I would go there")]).signals;
    expect(repeat.repairCount).toBe(1);

    const iMean = computeMeetingMetrics([mic("so i mean let us do it")]).signals;
    expect(iMean.repairCount).toBe(1);
  });

  it("scores the benchmarked disfluent sentence well below a clean rewrite", () => {
    const disfluent = computeMeetingMetrics([
      mic("so I'm—I would aim to take out—take our personalization uh from uh"),
    ]).smoothScore;
    const rewrite = computeMeetingMetrics([
      mic("I'd like to shift our personalization to real-time contextual curation"),
    ]).smoothScore;
    expect(disfluent).toBeLessThan(rewrite);
    expect(rewrite).toBe(100);
  });

  it("ignores the system channel entirely when scoring the user's delivery", () => {
    const withNoisySystem = computeMeetingMetrics([
      mic("we should ship the feature this week"),
      system("um uh you know like erm", 1000, true),
    ]).smoothScore;
    const micOnly = computeMeetingMetrics([
      mic("we should ship the feature this week"),
    ]).smoothScore;
    expect(withNoisySystem).toBe(micOnly);
    expect(withNoisySystem).toBe(100);
  });
});

describe("computeMeetingMetrics — non-space-delimited languages (#86)", () => {
  it("does NOT collapse the score for fluent Japanese (no spaces between words)", () => {
    const { smoothScore, signals } = computeMeetingMetrics([
      mic("今日はとても良い天気ですね、では会議を始めましょう"),
    ]);
    // Before #86 the whole sentence tokenized to ~1 word, spiking density.
    expect(signals.micWordCount).toBeGreaterThan(1);
    expect(signals.fillerCount).toBe(0);
    expect(signals.repairCount).toBe(0);
    expect(smoothScore).toBe(100);
  });

  it("does NOT collapse the score for fluent Chinese", () => {
    const { smoothScore, signals } = computeMeetingMetrics([
      mic("我们今天讨论一下产品路线图和下个季度的目标"),
    ]);
    expect(signals.micWordCount).toBeGreaterThan(1);
    expect(smoothScore).toBe(100);
  });

  it("does NOT count an em-dash as a repair in CJK text (it is ordinary punctuation there)", () => {
    const { smoothScore, signals } = computeMeetingMetrics([
      mic("そうですね——とても良い提案だと思います"),
    ]);
    expect(signals.repairCount).toBe(0);
    expect(smoothScore).toBe(100);
  });

  it("still counts an em-dash restart for Korean (space-delimited, unchanged)", () => {
    const { signals } = computeMeetingMetrics([mic("음 그러니까—그게 말이죠")]);
    // KO has no CJK chars, so it stays on the space-delimited path: em-dash counts.
    expect(signals.repairCount).toBe(1);
  });

  it("handles mixed CJK + Latin without collapsing", () => {
    const { smoothScore } = computeMeetingMetrics([mic("I think 今日は良い提案です")]);
    expect(smoothScore).toBe(100);
  });
});

describe("computeMeetingMetrics — word-boundary-aware phrase matching (#86)", () => {
  it("does not count 'you know' inside 'know-how' (no false positive)", () => {
    const { signals } = computeMeetingMetrics([mic("do you know-how this works")]);
    expect(signals.fillerCount).toBe(0);
  });

  it("still counts a genuine 'you know' as a filler phrase", () => {
    const { signals } = computeMeetingMetrics([mic("you know it works")]);
    expect(signals.fillerCount).toBe(1);
  });

  it("does not count 'i mean' inside 'hi meant' (word-boundary aware)", () => {
    const { signals } = computeMeetingMetrics([mic("hi meant to ask")]);
    expect(signals.repairCount).toBe(0);
  });
});
