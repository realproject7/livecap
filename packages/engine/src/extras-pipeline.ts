// LLM-extras pipeline (issue #9): live summary + meeting board, reply
// suggestions, and quick translate — all over the SAME meeting session via the
// engine's generic complete(), so it works identically on the CLI and local
// tiers and its cost flows through #7 accounting. UI integration is #11/#12.

import { ExtrasBudget, ExtrasBudgetExceededError } from "./extras-budget";
import {
  buildAnalyzeRespondPrompt,
  buildIncrementalSummaryBoardPrompt,
  buildQuickTranslatePrompt,
  buildReplyPrompt,
  buildSummaryBoardPrompt,
  parseAnalyzeRespond,
  parseSummaryBoard,
  type AnalyzeRespondResult,
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
}
