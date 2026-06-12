// Claude Code CLI adapter (PROPOSAL §4 tier 1, §5). One persistent
// `claude -p` stream-json process per meeting: each batch is one stdin JSONL
// line, each response streams back as text_delta events. Implements the
// provider-agnostic TranslationEngine.
//
// Tauri-free and Linux-headless: the binary path, cwd, and base env are
// injected by the consumer — nothing is resolved inside the package.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { buildClaudeArgs } from "./args";
import { sanitizeChildEnv } from "./env";
import { AsyncChannel } from "./internal/channel";
import { Mutex } from "./internal/mutex";
import {
  buildSummaryMessage,
  buildSystemPrompt,
  buildTranslateMessage,
  formatUserMessageLine,
} from "./prompt";
import { StreamJsonParser } from "./stream-parser";
import type {
  Completion,
  CompletionRequest,
  EngineHealth,
  MeetingBrief,
  ParsedEvent,
  RollingContext,
  Sentence,
  Translation,
  TranslationEngine,
  Usage,
} from "./types";

export interface ClaudeCliEngineConfig {
  /** Absolute path (or PATH-resolvable name) of the CLI binary. Injected. */
  bin: string;
  /** Working directory — an empty dir, so no project CLAUDE.md/.mcp leaks in. */
  cwd: string;
  /** Base environment to sanitize. Injected (e.g. the host process env). */
  env: Record<string, string | undefined>;
  /** Whether the probed CLI supports `--include-partial-messages`. */
  includePartialMessages: boolean;
  /** App-generated session id; one is created if omitted. */
  sessionId?: string;
  /** Model pin; defaults to Haiku via buildClaudeArgs. */
  model?: string;
  /** Target language name (default Korean). */
  targetLanguage?: string;
  /** Session-fixed glossary (cacheable system prompt). */
  glossary?: Record<string, string>;
  /** How many recent pairs to include per request (default 4). */
  contextPairs?: number;
  /** Resume a prior session by id after a crash, instead of starting fresh. */
  resume?: string;
}

/** Cap on the retained stderr tail folded into exit errors (chars). */
const MAX_STDERR_TAIL = 2000;

/** Thrown when a turn ends with an error result (e.g. invalid model → 404). */
export class EngineTurnError extends Error {
  constructor(
    message: string,
    readonly apiErrorStatus: number | null,
  ) {
    super(message);
    this.name = "EngineTurnError";
  }
}

export class ClaudeCliEngine implements TranslationEngine {
  private readonly config: ClaudeCliEngineConfig;
  private readonly sessionId: string;
  private readonly systemPrompt: string;
  private readonly parser = new StreamJsonParser();
  private readonly turnMutex = new Mutex();
  private readonly usageListeners = new Set<(usage: Usage) => void>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  /** Last MAX_STDERR_TAIL chars of child stderr, surfaced in exit errors only. */
  private stderrTail = "";
  private currentTurn: AsyncChannel<ParsedEvent> | null = null;
  private statusValue: EngineHealth = { status: "stopped" };
  private cumulativeCostUsd = 0;
  private latestUsage: Usage = {
    cumulativeCostUsd: 0,
    turnCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
  };

  constructor(config: ClaudeCliEngineConfig) {
    this.config = config;
    this.sessionId = config.sessionId ?? randomUUID();
    this.systemPrompt = buildSystemPrompt({
      targetLanguage: config.targetLanguage,
      glossary: config.glossary,
    });
  }

  health(): EngineHealth {
    return this.statusValue;
  }

  onUsage(listener: (usage: Usage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.statusValue = { status: "starting" };

    const args = buildClaudeArgs({
      sessionId: this.sessionId,
      systemPrompt: this.systemPrompt,
      includePartialMessages: this.config.includePartialMessages,
      model: this.config.model,
      resume: this.config.resume,
    });
    const env = sanitizeChildEnv(this.config.env);

    const child = spawn(this.config.bin, args, {
      cwd: this.config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        child.removeListener("spawn", onSpawn);
        this.statusValue = { status: "error", detail: err.message };
        this.child = null;
        reject(err);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    // Drain stderr: an unread stderr pipe fills its ~64KB kernel buffer and
    // wedges the CLI mid-write during a long session. We keep only a capped
    // tail (surfaced in exit errors, never logged — it may echo content).
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
    child.once("exit", (code, signal) => this.onExit(code, signal));

    this.statusValue = { status: "ready" };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.statusValue = { status: "stopped" };
    this.currentTurn?.end(new Error("engine stopped"));
    this.currentTurn = null;
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed.
    }
    child.kill();
  }

  /**
   * Translate a batch, yielding progressive snapshots until `done`. On an error
   * turn this throws `EngineTurnError` AFTER possibly yielding in-progress
   * snapshots (an error result can carry synthetic assistant text). Consumers
   * must discard any prior snapshots for this batch when it throws — do not
   * render the partial as a caption.
   */
  async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
    const ids = batch.map((s) => s.id);
    const line = formatUserMessageLine(buildTranslateMessage(batch, ctx, this.config.contextPairs));

    let text = "";
    for await (const event of this.runTurn(line)) {
      if (event.kind === "text_delta") {
        text += event.text;
        yield { sentenceIds: ids, text: text.trim(), done: false };
      } else if (event.kind === "usage") {
        this.recordUsage(event);
      } else if (event.kind === "turn_end" && event.isError) {
        throw new EngineTurnError(event.message ?? "translation turn failed", event.apiErrorStatus);
      }
    }
    // Final snapshot — emitted even when the model output nothing (allowed).
    yield { sentenceIds: ids, text: text.trim(), done: true };
  }

  async summarize(transcript: string): Promise<MeetingBrief> {
    const text = await this.runTextTurn(buildSummaryMessage(transcript), "summary");
    return { ...parseBrief(text), usage: this.latestUsage };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    // The CLI session's system prompt is fixed at spawn, so a per-call system
    // instruction is folded into the message.
    const message = request.system ? `${request.system}\n\n${request.user}` : request.user;
    const text = await this.runTextTurn(message, "completion");
    return { text, usage: this.latestUsage };
  }

  /** Run one turn over stdin, returning the trimmed assistant text. */
  private async runTextTurn(message: string, label: string): Promise<string> {
    const line = formatUserMessageLine(message);
    let text = "";
    for await (const event of this.runTurn(line)) {
      if (event.kind === "text_delta") {
        text += event.text;
      } else if (event.kind === "usage") {
        this.recordUsage(event);
      } else if (event.kind === "turn_end" && event.isError) {
        throw new EngineTurnError(event.message ?? `${label} turn failed`, event.apiErrorStatus);
      }
    }
    return text.trim();
  }

  /** Run a single turn: write one stdin line, stream its events until turn_end. */
  private async *runTurn(line: string): AsyncGenerator<ParsedEvent> {
    const release = await this.turnMutex.acquire();
    const child = this.child;
    if (!child) {
      release();
      throw new Error("engine not started");
    }
    const channel = new AsyncChannel<ParsedEvent>();
    this.currentTurn = channel;
    try {
      child.stdin.write(line);
      for await (const event of channel) {
        yield event;
        if (event.kind === "turn_end") break;
      }
    } finally {
      this.currentTurn = null;
      release();
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      for (const event of this.parser.pushLine(line)) {
        this.currentTurn?.push(event);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null;
    let detail = `cli exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
    const tail = this.stderrTail.trim();
    if (tail !== "") detail += `; stderr tail: ${tail}`;
    if (this.statusValue.status !== "stopped") {
      this.statusValue = { status: "error", detail };
    }
    this.currentTurn?.end(new Error(detail));
    this.currentTurn = null;
  }

  private recordUsage(event: Extract<ParsedEvent, { kind: "usage" }>): void {
    const turnCostUsd = Math.max(0, event.cumulativeCostUsd - this.cumulativeCostUsd);
    this.cumulativeCostUsd = event.cumulativeCostUsd;
    const usage: Usage = {
      cumulativeCostUsd: event.cumulativeCostUsd,
      turnCostUsd,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
    };
    this.latestUsage = usage;
    for (const listener of this.usageListeners) listener(usage);
  }
}

/** Split a summary response into the running paragraph and board lines. */
function parseBrief(text: string): { summary: string; board: string[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const summary = lines.find((l) => !l.startsWith("[")) ?? "";
  const board = lines.filter((l) => l.startsWith("["));
  return { summary, board };
}
