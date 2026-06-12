// Regression for #55: the #9 extras summary pipeline re-sent the ACCUMULATED
// transcript every cadence tick, so over a long meeting the per-call input grew
// linearly and the session token total grew QUADRATICALLY — the root of #13's
// real-world 6× cost blow-up ($4.03 vs the #3 PoC's $0.64/hr translation-only
// projection). The fix makes summarization INCREMENTAL: each tick sends only the
// transcript delta + the previous summary/board, so per-call input is bounded
// and the session total grows LINEARLY.
//
// These tests drive the REAL ExtrasPipeline (both the incremental and the
// full-transcript paths it still supports) through a fake completion engine that
// reports token usage proportional to the actual prompt it receives — so the
// assertions measure the genuine prompt economics, not a mock.

import { describe, it, expect } from "vitest";

import { ExtrasPipeline, type SummaryBoardPrevious } from "../src/extras-pipeline";
import type { Completion, CompletionRequest, Usage } from "../src/types";

// --- #13-grounded scenario --------------------------------------------------
// #13's 66-min run finalized 378 captions (~5.7/min) into the transcript the
// summary kept re-sending. We simulate a 60-min session at that rate.
const CAPTIONS_PER_MIN = 6;
// One finalized caption line as it lands in the transcript (~60 chars / ~12 words).
const CAPTION = "Them: lorem ipsum dolor sit amet consectetur adipiscing elit sed.";

// Token pricing shape (relative units): output priced ~5× input, mirroring the
// public Claude pricing ratio. Absolute scale is irrelevant — every assertion is
// a ratio between two runs of the same model.
const PRICE_IN = 1;
const PRICE_OUT = 5;

// A bounded board the fake model "returns" every call. Because it is fixed-size,
// the previous-summary the incremental prompt feeds back stays bounded — exactly
// the property the incremental prompt is designed to instruct the real model to
// preserve ("merge, keep concise"), so the simulation reflects intended behavior.
const FIXED_BOARD = [
  "SUMMARY",
  "- Kickoff scope and the rollout timeline were reviewed",
  "- Budget pressure on the contractor expansion was raised",
  "- The team aligned on stack-rank scoring over raw excitement",
  "- Open risk on the data-migration cutover window",
  "DECISIONS",
  "- Use stack rank, not raw excitement scores",
  "ACTION ITEMS",
  "- Mike → share the apps shortlist",
  "- Me → draft the budget memo by Friday",
  "OPEN QUESTIONS",
  "- Which MAU definition wins for the dashboard?",
].join("\n");

/** Fake engine: usage tokens are proportional to the ACTUAL prompt size. */
class MeteringEngine {
  cumulativeCostUsd = 0;
  totalCostUsd = 0;
  lastInputTokens = 0;

  complete(request: CompletionRequest): Promise<Completion> {
    const inChars = (request.system?.length ?? 0) + request.user.length;
    const inputTokens = Math.ceil(inChars / 4);
    const outputTokens = Math.ceil(FIXED_BOARD.length / 4);
    const turnCostUsd = inputTokens * PRICE_IN + outputTokens * PRICE_OUT;
    this.cumulativeCostUsd += turnCostUsd;
    this.totalCostUsd += turnCostUsd;
    this.lastInputTokens = inputTokens;
    const usage: Usage = {
      cumulativeCostUsd: this.cumulativeCostUsd,
      turnCostUsd,
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
    };
    return Promise.resolve({ text: FIXED_BOARD, usage });
  }
}

interface RunResult {
  inputPerCall: number[];
  extrasCostUsd: number;
}

/**
 * Drive the pipeline across a simulated session at a fixed cadence.
 * - "incremental": each tick sends only the new captions + previous summary.
 * - "full": each tick re-sends the whole accumulated transcript (pre-#55).
 */
async function runSession(
  mode: "incremental" | "full",
  sessionMin: number,
  intervalSec: number,
): Promise<RunResult> {
  const engine = new MeteringEngine();
  const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "Korean", meetingLanguage: "English" });

  const lines: string[] = [];
  let summarizedThrough = 0;
  let previous: SummaryBoardPrevious | null = null;
  const inputPerCall: number[] = [];

  const captionsPerInterval = (CAPTIONS_PER_MIN * intervalSec) / 60;
  const ticks = Math.floor((sessionMin * 60) / intervalSec);
  let added = 0;

  for (let t = 1; t <= ticks; t++) {
    const target = Math.round(t * captionsPerInterval);
    while (added < target) {
      lines.push(`${CAPTION} #${added}`);
      added++;
    }
    if (mode === "incremental") {
      const delta = previous ? lines.slice(summarizedThrough).join("\n") : lines.join("\n");
      const result = await pipeline.generateSummaryBoard(delta, { previous });
      summarizedThrough = lines.length;
      previous = { summary: result.summary, board: result.board };
    } else {
      await pipeline.generateSummaryBoard(lines.join("\n"));
    }
    inputPerCall.push(engine.lastInputTokens);
  }

  return { inputPerCall, extrasCostUsd: engine.totalCostUsd };
}

/** PoC #3 baseline: translation-only — each caption translated exactly once,
 *  with a rolling-context window of the previous few lines (PROPOSAL §4). */
function translationBaselineCostUsd(sessionMin: number): number {
  const totalCaptions = sessionMin * CAPTIONS_PER_MIN;
  const contextChars = 4 * CAPTION.length; // last ~4 pairs seed terminology
  let cost = 0;
  for (let i = 0; i < totalCaptions; i++) {
    const inputTokens = Math.ceil((CAPTION.length + contextChars) / 4);
    const outputTokens = Math.ceil(CAPTION.length / 4); // translation ≈ source length
    cost += inputTokens * PRICE_IN + outputTokens * PRICE_OUT;
  }
  return cost;
}

const max = (xs: number[]): number => xs.reduce((a, b) => Math.max(a, b), 0);
const min = (xs: number[]): number => xs.reduce((a, b) => Math.min(a, b), Infinity);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe("extras pipeline economics (#55)", () => {
  it("keeps per-call input BOUNDED when incremental — it does not grow with the transcript", async () => {
    const { inputPerCall } = await runSession("incremental", 60, 120);
    // Each call carries previous summary (fixed-size) + one interval of new
    // captions (fixed-size) → roughly constant, regardless of how long the
    // meeting has been running. Allow generous slack for prompt boilerplate.
    expect(max(inputPerCall) / min(inputPerCall)).toBeLessThan(2);
    // The last call (59 min in) is not materially larger than the second.
    const second = inputPerCall[1] ?? 0;
    const last = inputPerCall.at(-1) ?? 0;
    expect(last).toBeLessThan(second * 2);
  });

  it("the pre-#55 full-transcript path grows per-call input LINEARLY with the transcript", async () => {
    const { inputPerCall } = await runSession("full", 60, 120);
    // The accumulating transcript makes the last call dwarf the first.
    const first = inputPerCall[0] ?? 0;
    const last = inputPerCall.at(-1) ?? 0;
    expect(last).toBeGreaterThan(first * 10);
  });

  it("incremental session tokens grow LINEARLY; the full-transcript path grows QUADRATICALLY", async () => {
    const inc30 = sum((await runSession("incremental", 30, 120)).inputPerCall);
    const inc60 = sum((await runSession("incremental", 60, 120)).inputPerCall);
    // Double the duration → ~double the tokens (linear).
    expect(inc60 / inc30).toBeLessThan(2.3);

    const full30 = sum((await runSession("full", 30, 120)).inputPerCall);
    const full60 = sum((await runSession("full", 60, 120)).inputPerCall);
    // Double the duration → ~quadruple the tokens (quadratic). This is the
    // blow-up #55 removes.
    expect(full60 / full30).toBeGreaterThan(3.5);
  });

  it("incremental cuts session extras cost far below the full-transcript path", async () => {
    const inc = (await runSession("incremental", 60, 120)).extrasCostUsd;
    const full = (await runSession("full", 60, 120)).extrasCostUsd;
    expect(full / inc).toBeGreaterThan(3);
  });

  it("keeps the full simulated session cost within 2× of the #3 translation-only PoC baseline", async () => {
    const translation = translationBaselineCostUsd(60);
    const extras = (await runSession("incremental", 60, 120)).extrasCostUsd;
    // Total session = translation + extras must land within 2× of translation
    // alone (i.e. extras ≤ translation), back inside the PoC envelope.
    expect((translation + extras) / translation).toBeLessThanOrEqual(2);
  });
});
