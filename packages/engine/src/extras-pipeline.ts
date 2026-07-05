// LLM-extras pipeline (issue #9): live summary + meeting board, reply
// suggestions, and quick translate — all over the SAME meeting session via the
// engine's generic complete(), so it works identically on the CLI and local
// tiers and its cost flows through #7 accounting. UI integration is #11/#12.

import { ExtrasBudget, ExtrasBudgetExceededError } from "./extras-budget";
import {
  buildAnalyzeRespondPrompt,
  buildCoachBatchPrompt,
  buildCoachPrompt,
  buildIncrementalSummaryBoardPrompt,
  buildQuickTranslatePrompt,
  buildReplyPrompt,
  buildSummaryBoardPrompt,
  parseAnalyzeRespond,
  parseCoachBatch,
  parseCoachResult,
  parseSummaryBoard,
  type AnalyzeRespondResult,
  type CoachResult,
  type MeetingBoard,
  type ReplyIntent,
} from "./extras-prompts";
import type { Completion, CompletionRequest, Usage } from "./types";

/** The single capability the pipeline needs from an engine. */
export interface CompletionEngine {
  complete(request: CompletionRequest): Promise<Completion>;
}

/** Prior summary/board state, fed back for an INCREMENTAL summary (#55). */
export interface SummaryBoardPrevious {
  summary: string[];
  board: MeetingBoard;
}

export interface ExtrasPipelineConfig {
  engine: CompletionEngine;
  /** Output language for summary/board (default; switchable per call). §8.4 toggle. */
  summaryLanguage: string;
  /** Language for reply suggestions and quick-translate output (the meeting language). */
  meetingLanguage: string;
  /** How many recent captions to feed a reply suggestion (default 10). */
  contextCaptions?: number;
  /** Optional per-session extras budget cap (#55). When present, every extras
   *  call's cost is tallied against it, and the recurring summary stops calling
   *  the model once the cap is reached. */
  budget?: ExtrasBudget;
}

export interface SummaryBoardResult {
  summary: string[];
  board: MeetingBoard;
  usage: Usage;
}

export interface TextResult {
  text: string;
  usage: Usage;
}

/** Result of {@link ExtrasPipeline.analyzeAndRespond} (#77). */
export interface AnalyzeRespondPipelineResult extends AnalyzeRespondResult {
  usage: Usage;
}

/** Result of {@link ExtrasPipeline.coachUtterance} (#79). */
export interface CoachPipelineResult extends CoachResult {
  usage: Usage;
}

/** Usage for a result produced WITHOUT calling the model (a no-op coaching
 *  result on degenerate input) — no tokens spent, nothing to meter. */
const ZERO_USAGE: Usage = {
  cumulativeCostUsd: 0,
  turnCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
};

/** A trivial/degenerate utterance (empty or a single word, e.g. "Yeah") has
 *  nothing to coach — counting whitespace-separated words. */
function isDegenerateUtterance(text: string): boolean {
  return text.trim().split(/\s+/).filter((w) => w !== "").length <= 1;
}

/** Max utterances coached per grouped `complete()` turn (#112). Batching cuts
 *  the ~one-turn-per-utterance wall-clock ~N×; the cap keeps each batched
 *  prompt/response small enough to parse reliably, and overflow spills into
 *  additional turns. */
const COACH_BATCH_SIZE = 5;

/**
 * Split one batch turn's {@link Usage} into `count` even shares whose fields sum
 * back to the original EXACTLY (#112). Token fields (integers) distribute their
 * division remainder one-per-item across the first items; cost fields (floats)
 * carry any rounding residual on the first share. So summing a batch's per-item
 * usages always reconstructs the turn total, with no drift.
 */
function divideUsage(usage: Usage, count: number): Usage[] {
  const ints = (total: number): number[] => {
    const base = Math.floor(total / count);
    const remainder = total - base * count;
    return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
  };
  const floats = (total: number): number[] => {
    const each = total / count;
    const parts = Array.from({ length: count }, () => each);
    parts[0] = each + (total - each * count); // absorb float residual on the first share
    return parts;
  };
  const cumulative = floats(usage.cumulativeCostUsd);
  const turn = floats(usage.turnCostUsd);
  const input = ints(usage.inputTokens);
  const output = ints(usage.outputTokens);
  const cacheRead = ints(usage.cacheReadInputTokens);
  return Array.from({ length: count }, (_, i) => ({
    cumulativeCostUsd: cumulative[i]!,
    turnCostUsd: turn[i]!,
    inputTokens: input[i]!,
    outputTokens: output[i]!,
    cacheReadInputTokens: cacheRead[i]!,
  }));
}

/** Sum two {@link Usage} records field-by-field (#112). Used when a batched item
 *  had to be re-run individually: its attribution is the batch share it already
 *  cost PLUS the re-run turn, so overall per-item usage still accounts for every
 *  token actually spent. */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    cumulativeCostUsd: a.cumulativeCostUsd + b.cumulativeCostUsd,
    turnCostUsd: a.turnCostUsd + b.turnCostUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

export class ExtrasPipeline {
  private readonly engine: CompletionEngine;
  private readonly summaryLanguage: string;
  private readonly meetingLanguage: string;
  private readonly contextCaptions: number;
  private readonly budget?: ExtrasBudget;

  constructor(config: ExtrasPipelineConfig) {
    this.engine = config.engine;
    this.summaryLanguage = config.summaryLanguage;
    this.meetingLanguage = config.meetingLanguage;
    this.contextCaptions = config.contextCaptions ?? 10;
    this.budget = config.budget;
  }

  /**
   * One engine call → live summary + structured board (PROPOSAL §8.4).
   *
   * When `options.previous` is given, the call is INCREMENTAL (#55): `transcript`
   * is treated as only the NEW transcript since the last summary, and the prior
   * summary/board is fed back so the model folds the delta in — keeping per-call
   * input bounded instead of re-sending the whole growing transcript. With no
   * `previous` (the first run, and the final-summary path) it summarizes
   * `transcript` in full.
   *
   * The recurring driver of cost, so this is the call gated by the per-session
   * budget: once the cap is reached it throws `ExtrasBudgetExceededError` WITHOUT
   * calling the model, and the consumer stands the auto-summary loop down.
   */
  async generateSummaryBoard(
    transcript: string,
    options: { language?: string; previous?: SummaryBoardPrevious | null } = {},
  ): Promise<SummaryBoardResult> {
    if (this.budget && !this.budget.canSpend()) throw new ExtrasBudgetExceededError();
    const language = options.language ?? this.summaryLanguage;
    const prompt = options.previous
      ? buildIncrementalSummaryBoardPrompt(options.previous, transcript, language)
      : buildSummaryBoardPrompt(transcript, language);
    const { text, usage } = await this.engine.complete(prompt);
    this.budget?.record(usage.turnCostUsd);
    const parsed = parseSummaryBoard(text);
    return { summary: parsed.summary, board: parsed.board, usage };
  }

  /** Suggest one reply for the chip intent from the last ~N captions (§8.5). */
  async suggestReply(
    intent: ReplyIntent,
    recentCaptions: string[],
    options: { language?: string } = {},
  ): Promise<TextResult> {
    const language = options.language ?? this.meetingLanguage;
    const { text, usage } = await this.engine.complete(
      buildReplyPrompt(intent, recentCaptions, language, this.contextCaptions),
    );
    // User-driven and bounded — metered against the budget but never blocked by it.
    this.budget?.record(usage.turnCostUsd);
    return { text: text.trim(), usage };
  }

  /**
   * Analyze ONE targeted caption block (usually a question aimed at the user) and
   * suggest a reply (#77). Returns `{ analysis, reply }` where `analysis` is a short
   * strategy read in the user's target language (`summaryLanguage`) and `reply` is a
   * natural response in the meeting language (`meetingLanguage`). `options.language`
   * overrides the meeting (reply) language per call, mirroring the other methods.
   *
   * On-demand only (never auto-invoked); user-driven and bounded, so its cost is
   * metered against the budget but never blocked by it. Parsing is graceful — a
   * model that omits a section never throws (see {@link parseAnalyzeRespond}).
   */
  async analyzeAndRespond(
    targetText: string,
    recentCaptions: string[],
    options: { language?: string } = {},
  ): Promise<AnalyzeRespondPipelineResult> {
    const replyLanguage = options.language ?? this.meetingLanguage;
    const { text, usage } = await this.engine.complete(
      buildAnalyzeRespondPrompt(
        targetText,
        recentCaptions,
        replyLanguage,
        this.summaryLanguage,
        this.contextCaptions,
      ),
    );
    this.budget?.record(usage.turnCostUsd);
    const parsed = parseAnalyzeRespond(text);
    return { analysis: parsed.analysis, reply: parsed.reply, usage };
  }

  /** Quick translate free text into the meeting language (§8.5). */
  async quickTranslate(text: string, options: { language?: string } = {}): Promise<TextResult> {
    const language = options.language ?? this.meetingLanguage;
    const result = await this.engine.complete(buildQuickTranslatePrompt(text, language));
    this.budget?.record(result.usage.turnCostUsd);
    return { text: result.text.trim(), usage: result.usage };
  }

  /**
   * Coach ONE of the user's own (disfluent) utterances (#79): a native rewrite
   * (`better`, in the meeting language), the key edits (`changes`, for diff
   * highlighting), and why (`explanation`, in the user's target language).
   * `options.language` overrides the meeting (rewrite) language per call.
   *
   * Degenerate input (empty or a single word, e.g. "Yeah") returns a no-op
   * `{ better: <trimmed input>, changes: [], explanation: "" }` WITHOUT calling
   * the model — never a fabricated rewrite, and no token spend. On-demand only;
   * cost metered against the budget but never blocked by it. Parsing is graceful
   * (see {@link parseCoachResult}).
   */
  async coachUtterance(
    text: string,
    options: { language?: string } = {},
  ): Promise<CoachPipelineResult> {
    if (isDegenerateUtterance(text)) {
      return { better: text.trim(), changes: [], explanation: "", usage: ZERO_USAGE };
    }
    const better = options.language ?? this.meetingLanguage;
    const { text: out, usage } = await this.engine.complete(
      buildCoachPrompt(text, better, this.summaryLanguage),
    );
    this.budget?.record(usage.turnCostUsd);
    const parsed = parseCoachResult(out);
    return { ...parsed, usage };
  }

  /**
   * Batch coaching for "review all my utterances" (#79/#112): results are aligned
   * by index with `texts`. Degenerate items short-circuit to a no-op with no
   * round-trip (so a transcript full of "Yeah"/"Right" is free, still zero model
   * calls). The remaining real items are coached in groups of up to
   * {@link COACH_BATCH_SIZE} per `complete()` turn (#112) — one grouped prompt
   * with hard `### ITEM k` delimiters instead of one turn per utterance, cutting
   * wall-clock ~N× (the CLI runs one serialized session, so fewer turns is the
   * lever). Robustness is preserved: if the batch drops or garbles an item, ONLY
   * that item is re-run through the single-item path, so no utterance is lost.
   *
   * Usage: each batch turn's cost is divided evenly across its items (see
   * {@link divideUsage}); a re-run item additionally carries its re-run turn.
   * Summing the returned per-item usages reconstructs the real turn totals.
   */
  async coachUtterances(
    texts: string[],
    options: { language?: string } = {},
  ): Promise<CoachPipelineResult[]> {
    const results = new Array<CoachPipelineResult>(texts.length);
    // Real (non-degenerate) items, keeping their original position in `texts`.
    const pending: { index: number; text: string }[] = [];
    texts.forEach((text, index) => {
      if (isDegenerateUtterance(text)) {
        results[index] = { better: text.trim(), changes: [], explanation: "", usage: ZERO_USAGE };
      } else {
        pending.push({ index, text });
      }
    });

    for (let start = 0; start < pending.length; start += COACH_BATCH_SIZE) {
      const group = pending.slice(start, start + COACH_BATCH_SIZE);
      if (group.length === 1) {
        // A lone real item gains nothing from a batch prompt — use the direct,
        // already-tested single-item path.
        const only = group[0]!;
        results[only.index] = await this.coachUtterance(only.text, options);
      } else {
        await this.coachBatch(group, options, results);
      }
    }
    return results;
  }

  /**
   * Coach one group of real utterances in a single `complete()` turn (#112),
   * writing each item's result into `results` at its original index. Items the
   * batch drops or garbles (see {@link parseCoachBatch}) are re-run one at a time
   * through {@link coachUtterance} so none is lost.
   */
  private async coachBatch(
    group: { index: number; text: string }[],
    options: { language?: string },
    results: CoachPipelineResult[],
  ): Promise<void> {
    const better = options.language ?? this.meetingLanguage;
    const { text: out, usage } = await this.engine.complete(
      buildCoachBatchPrompt(
        group.map((g) => g.text),
        better,
        this.summaryLanguage,
      ),
    );
    this.budget?.record(usage.turnCostUsd);
    const parsed = parseCoachBatch(out, group.length);
    const shares = divideUsage(usage, group.length);
    for (let j = 0; j < group.length; j += 1) {
      const item = group[j]!;
      const itemParsed = parsed[j];
      if (itemParsed) {
        results[item.index] = { ...itemParsed, usage: shares[j]! };
      } else {
        const rerun = await this.coachUtterance(item.text, options);
        results[item.index] = { ...rerun, usage: addUsage(shares[j]!, rerun.usage) };
      }
    }
  }
}
