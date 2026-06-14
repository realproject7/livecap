// Host metrics-record mapping (#81/#78): the per-id caption meta the host
// accumulates → the FinalizedRecord[] the engine's computeMeetingMetrics
// consumes. Pure and headless (no HostSession spin-up).
import { describe, expect, it } from "vitest";

import { computeMeetingMetrics } from "@livecap/engine";

import { toFinalizedRecords, type MetricsMeta } from "../src/host/metrics-records";

function meta(channel: "me" | "them", text: string, durationMs: number, lowConfidence = false): MetricsMeta {
  return { channel, text, durationMs, lowConfidence };
}

describe("toFinalizedRecords (#81 host → metrics)", () => {
  it("maps the webview channel onto the metrics channel ('me'→'mic', 'them'→'system')", () => {
    const records = toFinalizedRecords([meta("me", "hi", 100), meta("them", "yo", 200)]);
    expect(records.map((r) => r.channel)).toEqual(["mic", "system"]);
  });

  it("carries spoken duration, text, and the low-confidence flag through", () => {
    const records = toFinalizedRecords([meta("me", "uh hello", 1234, true)]);
    expect(records[0]).toEqual({
      channel: "mic",
      durationMs: 1234,
      text: "uh hello",
      lowConfidence: true,
    });
  });

  it("preserves input order", () => {
    const records = toFinalizedRecords([meta("them", "a", 10), meta("me", "b", 20), meta("them", "c", 30)]);
    expect(records.map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("feeds computeMeetingMetrics so the talk ratio reflects the mic/system split", () => {
    // 600ms mic vs 400ms system → mic share 0.6.
    const records = toFinalizedRecords([
      meta("me", "a clean sentence here", 600),
      meta("them", "they spoke as well", 400),
    ]);
    const metrics = computeMeetingMetrics(records);
    expect(metrics.talkTime.micMs).toBe(600);
    expect(metrics.talkTime.systemMs).toBe(400);
    expect(metrics.talkTime.micShare).toBeCloseTo(0.6, 5);
    // A fluent mic line → a high Smooth Score.
    expect(metrics.smoothScore).toBeGreaterThan(80);
  });

  it("yields micShare 0 and smoothScore 100 when the user never spoke", () => {
    const metrics = computeMeetingMetrics(toFinalizedRecords([meta("them", "only them", 500)]));
    expect(metrics.talkTime.micShare).toBe(0);
    expect(metrics.smoothScore).toBe(100);
  });
});
