// Domain types and the provider-agnostic translation engine interface.
// One interface, three implementations (PROPOSAL §4): the CLI adapter lands
// here with #5, the local-LLM fallback with #6, BYO-API post-MVP.

/** A finalized source sentence handed off from the STT pipeline. */
export interface Sentence {
  /** Stable id assigned by the caller; echoed back on the Translation. */
  id: string;
  /** Source-language text (punctuation-finalized after a VAD pause). */
  text: string;
  /** Monotonic sequence number — higher means more recently spoken. */
  seq: number;
}

/** One source→target pair, used to seed rolling context. */
export interface TranslationPair {
  source: string;
  target: string;
}

/**
 * Per-request context: the last N translated pairs (so the model keeps
 * terminology and pronouns consistent) plus an optional glossary. A glossary
 * fixed for the whole session is set once at engine start (cacheable system
 * prompt, PROPOSAL §4); one passed here applies to this request only.
 */
export interface RollingContext {
  /** Recent pairs, oldest first. The engine uses the last N (default 4). */
  pairs: TranslationPair[];
  /** Optional source-term → preferred-target-term overrides for this request. */
  glossary?: Record<string, string>;
}

/**
 * A translation snapshot. `translate()` streams these: an empty/growing `text`
 * while deltas arrive, then a final snapshot. One output line per input
 * sentence; an empty line is valid (non-translatable fragment, PROPOSAL §4).
 */
export interface Translation {
  /** Ids of the sentences covered, in input order. */
  sentenceIds: string[];
  /** Target-language text accumulated so far. */
  text: string;
  /** True on the final snapshot for this batch. */
  done: boolean;
}

/** Cost/usage accounting, surfaced for the in-app credit gauge (PROPOSAL §6). */
export interface Usage {
  /** `total_cost_usd` from the CLI — CUMULATIVE within a session. */
  cumulativeCostUsd: number;
  /** Cost attributable to the turn that just completed (cumulative delta). */
  turnCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/** A running meeting summary + board lines (PROPOSAL §8.4). */
export interface MeetingBrief {
  /** Free-form running summary paragraph. */
  summary: string;
  /** Structured board lines (decisions, actions, open questions), as emitted. */
  board: string[];
  /** Usage accumulated up to the moment the brief completed. */
  usage: Usage;
}

export type EngineStatus = "stopped" | "starting" | "ready" | "error";

export interface EngineHealth {
  status: EngineStatus;
  /**
   * Human-readable detail when status is "error". Carries only non-content
   * metadata (exit code/signal, a stderr byte count + hash) — never raw stderr
   * or model output — so it is safe to log/surface (#23, SECURITY.md).
   */
  detail?: string;
}

/**
 * The pluggable translation provider. `sentence + rolling context + glossary
 * in → translation out`, plus summary/board, lifecycle, and usage events.
 */
export interface TranslationEngine {
  /** Spin up the underlying engine (spawn the CLI session for the adapter). */
  start(): Promise<void>;
  /** Tear it down. Safe to call when already stopped. */
  stop(): Promise<void>;
  /** Current lifecycle state. */
  health(): EngineHealth;
  /** Translate a batch, streaming progressive snapshots until `done`. */
  translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation>;
  /** Summarize the accumulated transcript into a brief + board. */
  summarize(transcript: string): Promise<MeetingBrief>;
  /**
   * Generic single-turn completion over the same meeting session. Powers the
   * LLM-extras pipeline (#9) — summary/board in a chosen language, reply
   * suggestions, quick translate — uniformly across both engine tiers.
   */
  complete(request: CompletionRequest): Promise<Completion>;
  /** Subscribe to usage events. Returns an unsubscribe function. */
  onUsage(listener: (usage: Usage) => void): () => void;
}

/** A single-turn generation request. */
export interface CompletionRequest {
  /** System/instruction text. The CLI tier folds this into the message (its
   *  session system prompt is fixed); the local tier uses a system role. */
  system?: string;
  /** User message text. */
  user: string;
}

/** The result of a `complete()` call. */
export interface Completion {
  text: string;
  usage: Usage;
}

/**
 * Events produced by the stream-json parser. The adapter maps these onto
 * Translation / Usage; keeping the parser at this level lets it be unit-tested
 * against recorded fixtures with no process or I/O involved.
 */
export type ParsedEvent =
  | { kind: "text_delta"; index: number; text: string }
  | {
      kind: "turn_end";
      stopReason: string | null;
      isError: boolean;
      apiErrorStatus: number | null;
      message: string | null;
    }
  | {
      kind: "usage";
      cumulativeCostUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
    };
