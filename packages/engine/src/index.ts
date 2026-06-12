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
  ParsedEvent,
} from "./types";

export { StreamJsonParser } from "./stream-parser";
export { sanitizeChildEnv } from "./env";
export { buildClaudeArgs, ISOLATION_ARGS, DEFAULT_MODEL } from "./args";
export type { ClaudeArgsOptions } from "./args";
export {
  buildSystemPrompt,
  buildTranslateMessage,
  buildSummaryMessage,
  formatUserMessageLine,
} from "./prompt";
export type { PromptOptions } from "./prompt";
export { findCliBins, probeCapabilities, DEFAULT_CLI_NAMES } from "./detect";
export type { FindCliOptions, CommandRunner, CommandResult, Capabilities } from "./detect";
export { TranslationQueue } from "./queue";
export type { QueueOptions } from "./queue";
export { ClaudeCliEngine, EngineTurnError } from "./claude-cli-engine";
export type { ClaudeCliEngineConfig } from "./claude-cli-engine";
