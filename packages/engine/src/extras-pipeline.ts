// LLM-extras pipeline (issue #9): live summary + meeting board, reply
// suggestions, and quick translate — all over the SAME meeting session via the
// engine's generic complete(), so it works identically on the CLI and local
// tiers and its cost flows through #7 accounting. UI integration is #11/#12.

import {
  buildQuickTranslatePrompt,
  buildReplyPrompt,
  buildSummaryBoardPrompt,
  parseSummaryBoard,
  type MeetingBoard,
  type ReplyIntent,
} from "./extras-prompts";
import type { Completion, CompletionRequest, Usage } from "./types";

/** The single capability the pipeline needs from an engine. */
export interface CompletionEngine {
  complete(request: CompletionRequest): Promise<Completion>;
}

export interface ExtrasPipelineConfig {
  engine: CompletionEngine;
  /** Output language for summary/board (default; switchable per call). §8.4 toggle. */
  summaryLanguage: string;
  /** Language for reply suggestions and quick-translate output (the meeting language). */
  meetingLanguage: string;
  /** How many recent captions to feed a reply suggestion (default 10). */
  contextCaptions?: number;
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

export class ExtrasPipeline {
  private readonly engine: CompletionEngine;
  private readonly summaryLanguage: string;
  private readonly meetingLanguage: string;
  private readonly contextCaptions: number;

  constructor(config: ExtrasPipelineConfig) {
    this.engine = config.engine;
    this.summaryLanguage = config.summaryLanguage;
    this.meetingLanguage = config.meetingLanguage;
    this.contextCaptions = config.contextCaptions ?? 10;
  }

  /** One engine call → live summary + structured board (PROPOSAL §8.4). */
  async generateSummaryBoard(
    transcript: string,
    options: { language?: string } = {},
  ): Promise<SummaryBoardResult> {
    const language = options.language ?? this.summaryLanguage;
    const { text, usage } = await this.engine.complete(buildSummaryBoardPrompt(transcript, language));
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
    return { text: text.trim(), usage };
  }

  /** Quick translate free text into the meeting language (§8.5). */
  async quickTranslate(text: string, options: { language?: string } = {}): Promise<TextResult> {
    const language = options.language ?? this.meetingLanguage;
    const result = await this.engine.complete(buildQuickTranslatePrompt(text, language));
    return { text: result.text.trim(), usage: result.usage };
  }
}
