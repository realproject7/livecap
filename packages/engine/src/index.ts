// @livecap/engine — translation engine interface and adapters.
// Issue #5: the TranslationEngine interface, the Claude CLI adapter, and the
// stream-json parser. Local-model engine lands with #6; credit accounting #7.

export type {
  Sentence,
  TranslationPair,
  RollingContext,
  Translation,
  Usage,
  MeetingBrief,
  EngineStatus,
  EngineHealth,
  TranslationEngine,
  CompletionRequest,
  Completion,
  ParsedEvent,
} from "./types";

export { StreamJsonParser } from "./stream-parser";
export { sanitizeChildEnv, detectProxy, detectCustomEndpoint } from "./env";
export { buildClaudeArgs, ISOLATION_ARGS, DEFAULT_MODEL } from "./args";
export type { ClaudeArgsOptions } from "./args";
export {
  buildSystemPrompt,
  buildTranslateMessage,
  buildSummaryMessage,
  buildGlossarySetupMessage,
  buildReseedMessage,
  formatUserMessageLine,
} from "./prompt";
export type { PromptOptions } from "./prompt";
export { findCliBins, probeCapabilities, DEFAULT_CLI_NAMES } from "./detect";
export type { FindCliOptions, CommandRunner, CommandResult, Capabilities } from "./detect";
export { TranslationQueue } from "./queue";
export type { QueueOptions } from "./queue";
export { ClaudeCliEngine, EngineTurnError, EngineTimeoutError } from "./claude-cli-engine";
export type { ClaudeCliEngineConfig, EngineHealthEvent } from "./claude-cli-engine";

// Issue #6 — local LLM fallback tier (PROPOSAL §4 tier 2).
export { LocalLlmEngine } from "./local-llm-engine";
export type { LocalLlmEngineConfig } from "./local-llm-engine";
export { stripNonTranslation } from "./translation-guard";
export {
  ensureModel,
  ModelChecksumError,
  ModelDownloadStallError,
  nodeDownloadFs,
  nodeRangeFetcher,
} from "./model-download";
export type {
  DownloadFs,
  RangeFetcher,
  RangeResponse,
  EnsureModelOptions,
} from "./model-download";
export { QWEN3_4B_Q4_K_M, LLAMA_CPP_RELEASE } from "./pins";
export type { ModelArtifact, LlamaCppAsset, LlamaCppReleasePin } from "./pins";

// Issue #7 — credit accounting + auto-fallback policy (PROPOSAL §6/§8.7).
export { CreditAccountant, periodKeyFor, POOL_PRESETS } from "./credit-ledger";
export type {
  CreditConfig,
  CreditEvent,
  GaugeState,
  LedgerFs,
  PlanId,
} from "./credit-ledger";
export { nodeLedgerFs } from "./credit-fs";
export { FallbackRouter } from "./fallback-router";
export type { FallbackRouterOptions } from "./fallback-router";

// Issue #9 — LLM extras pipeline (live summary/board, reply suggestions, quick translate).
export { ExtrasPipeline } from "./extras-pipeline";
export type {
  ExtrasPipelineConfig,
  CompletionEngine,
  SummaryBoardResult,
  SummaryBoardPrevious,
  TextResult,
  AnalyzeRespondPipelineResult,
  CoachPipelineResult,
} from "./extras-pipeline";
export {
  buildSummaryBoardPrompt,
  buildIncrementalSummaryBoardPrompt,
  buildReplyPrompt,
  buildAnalyzeRespondPrompt,
  buildQuickTranslatePrompt,
  buildCoachPrompt,
  parseSummaryBoard,
  parseAnalyzeRespond,
  parseCoachResult,
} from "./extras-prompts";
export type {
  MeetingBoard,
  ReplyIntent,
  SummaryBoardParse,
  AnalyzeRespondResult,
  CoachChange,
  CoachResult,
} from "./extras-prompts";
export { SummaryCadence } from "./summary-cadence";
export type { SummaryCadenceOptions } from "./summary-cadence";

// Issue #55 — per-session extras budget cap (flows into the gauge).
export { ExtrasBudget, ExtrasBudgetExceededError, DEFAULT_EXTRAS_BUDGET_USD } from "./extras-budget";
export type { ExtrasBudgetOptions, ExtrasBudgetState } from "./extras-budget";

// Issue #78 — meeting metrics (talk-time ratio + Smooth Score; deterministic, no LLM).
export { computeMeetingMetrics } from "./meeting-metrics";
export type {
  MetricsChannel,
  FinalizedRecord,
  TalkTime,
  SmoothSignals,
  MeetingMetrics,
} from "./meeting-metrics";
