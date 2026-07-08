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
import { stderrDigest } from "./internal/redact";
import {
  asTaskMessage,
  buildGlossarySetupMessage,
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
  /**
   * Per-turn idle watchdog (#135): if a turn produces no event for this long
   * (hang, network stall, no `turn_end`), the turn aborts with a content-free
   * {@link EngineTimeoutError} and the hung child is killed so the next turn
   * respawns. Mirrors the local tier's 30s request timeout. Default 30s.
   */
  turnTimeoutMs?: number;
  /**
   * After this many consecutive turn timeouts/crashes, a single `degraded`
   * health event fires so the host can drive #7 fallback to the local tier
   * alongside the credit path. Reset by any healthy turn. Default 3.
   */
  maxTurnFailures?: number;
}

/** Cap on the retained stderr tail used only to derive a non-content hash (chars). */
const MAX_STDERR_TAIL = 2000;
/** Default per-turn idle watchdog window — mirrors the local tier's 30s (#135). */
const DEFAULT_TURN_TIMEOUT = 30_000;
/** Consecutive turn failures before a `degraded` event drives auto-fallback (#135). */
const DEFAULT_MAX_TURN_FAILURES = 3;

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

/** Thrown when a turn produces no event within the watchdog window and is
 *  aborted (#135). Content-free by construction — carries only the timeout. */
export class EngineTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`translation turn timed out (${timeoutMs}ms without a response)`);
    this.name = "EngineTimeoutError";
  }
}

/**
 * A content-free health signal from the CLI tier (#135). `respawned`: the CLI
 * process crashed and was restarted (conversation resumed by id). `degraded`:
 * repeated turn timeouts/crashes — the host should drive #7 fallback to the
 * local tier. Neither carries any caption/model text.
 */
export type EngineHealthEvent = { kind: "respawned" } | { kind: "degraded" };

/** Content-free turn-failure message — never includes the model's result text,
 *  which can echo prompt/caption content (#23). */
function turnErrorMessage(kind: string, apiErrorStatus: number | null): string {
  return apiErrorStatus != null ? `${kind} turn failed (api_error_status=${apiErrorStatus})` : `${kind} turn failed`;
}

export class ClaudeCliEngine implements TranslationEngine {
  private readonly config: ClaudeCliEngineConfig;
  private readonly sessionId: string;
  private readonly systemPrompt: string;
  private readonly parser = new StreamJsonParser();
  private readonly turnMutex = new Mutex();
  private readonly usageListeners = new Set<(usage: Usage) => void>();
  private readonly healthListeners = new Set<(event: EngineHealthEvent) => void>();
  private readonly turnTimeoutMs: number;
  private readonly maxTurnFailures: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  /** True between start() and stop(); gates crash respawn + health accounting. */
  private hasStarted = false;
  /** Consecutive turn timeouts/crashes; reset by any healthy turn (#135). */
  private consecutiveFailures = 0;
  /** Latch so the `degraded` event fires once per unhealthy streak (#135). */
  private degradedNotified = false;
  private stdoutBuffer = "";
  /** Capped tail of child stderr — used ONLY to derive a non-content hash. */
  private stderrTail = "";
  /** Total bytes of child stderr seen (surfaced as a count, never the text). */
  private stderrBytes = 0;
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
    this.turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT;
    this.maxTurnFailures = config.maxTurnFailures ?? DEFAULT_MAX_TURN_FAILURES;
    this.sessionId = config.sessionId ?? randomUUID();
    // The system prompt goes on argv (--system-prompt), so it must stay static
    // and content-free of user data: the glossary is bootstrapped over stdin in
    // start() instead (#26 — argv is world-readable via ps / /proc).
    this.systemPrompt = buildSystemPrompt({ targetLanguage: config.targetLanguage });
  }

  health(): EngineHealth {
    return this.statusValue;
  }

  onUsage(listener: (usage: Usage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  /** Subscribe to content-free health events (respawn / degraded, #135).
   *  Returns an unsubscribe function, mirroring {@link onUsage}. */
  onHealthEvent(listener: (event: EngineHealthEvent) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  private emitHealthEvent(event: EngineHealthEvent): void {
    for (const listener of this.healthListeners) listener(event);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.statusValue = { status: "starting" };
    await this.spawnSession(this.config.resume);
    this.hasStarted = true;
    this.statusValue = { status: "ready" };

    // Bootstrap the user glossary over stdin (never argv). Best-effort: a failed
    // setup turn must not block the session.
    const glossary = this.config.glossary;
    if (glossary && Object.keys(glossary).length > 0) {
      try {
        await this.runTextTurn(asTaskMessage(buildGlossarySetupMessage(glossary)), "glossary-setup");
      } catch {
        // glossary is best-effort; the session still translates without it
      }
    }
  }

  /**
   * Spawn the CLI child and wire its stdio; shared by start() and respawn. On
   * respawn `resume` is this session's id, so the crashed conversation continues
   * from history (#135). Rejects if the process fails to spawn.
   */
  private async spawnSession(resume: string | undefined): Promise<ChildProcessWithoutNullStreams> {
    const args = buildClaudeArgs({
      sessionId: this.sessionId,
      systemPrompt: this.systemPrompt,
      includePartialMessages: this.config.includePartialMessages,
      model: this.config.model,
      resume,
    });
    const env = sanitizeChildEnv(this.config.env);
    // A crashed session may have left a partial line buffered and the parser
    // mid-message; start clean so the fresh process's stream parses correctly.
    this.stdoutBuffer = "";
    this.parser.reset();

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

    this.wireChild(child);
    return child;
  }

  /** Attach stdout/stderr/exit handlers to a freshly spawned child. */
  private wireChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    // Drain stderr: an unread stderr pipe fills its ~64KB kernel buffer and
    // wedges the CLI mid-write during a long session. Only a byte count + a hash
    // of the capped tail are ever surfaced (#23) — never the raw text, which can
    // echo prompt/caption content.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Count actual UTF-8 bytes (not UTF-16 code units), so the digest's
      // "N bytes" label is truthful for multi-byte (e.g. Korean) stderr (#41).
      this.stderrBytes += Buffer.byteLength(chunk, "utf8");
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
    // Bind the child to its own exit handler: after a respawn the previous
    // child's late exit must not tear down the new one (#135).
    child.once("exit", (code, signal) => this.onExit(child, code, signal));
  }

  /**
   * Restart a crashed CLI session, resuming the prior conversation by id so
   * context/continuity survive the crash (#135). Emits a `respawned` health
   * event on success; returns null (staying in error) if the spawn fails.
   */
  private async respawn(): Promise<ChildProcessWithoutNullStreams | null> {
    this.statusValue = { status: "starting" };
    try {
      const child = await this.spawnSession(this.sessionId);
      this.statusValue = { status: "ready" };
      this.emitHealthEvent({ kind: "respawned" });
      return child;
    } catch {
      // spawnSession already recorded the error status/detail.
      return null;
    }
  }

  async stop(): Promise<void> {
    this.hasStarted = false;
    this.consecutiveFailures = 0;
    this.degradedNotified = false;
    const child = this.child;
    this.child = null;
    this.statusValue = { status: "stopped" };
    this.currentTurn?.end(new Error("engine stopped"));
    this.currentTurn = null;
    if (!child) return;
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
        throw new EngineTurnError(turnErrorMessage("translation", event.apiErrorStatus), event.apiErrorStatus);
      }
    }
    // Final snapshot — emitted even when the model output nothing (allowed).
    yield { sentenceIds: ids, text: text.trim(), done: true };
  }

  async summarize(transcript: string): Promise<MeetingBrief> {
    // [TASK]-marked so the session's translation system prompt yields to the
    // summary instructions (see buildSystemPrompt).
    const text = await this.runTextTurn(asTaskMessage(buildSummaryMessage(transcript)), "summary");
    return { ...parseBrief(text), usage: this.latestUsage };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    // The CLI session's system prompt is fixed at spawn, so a per-call system
    // instruction is folded into the message and marked [TASK] so it overrides
    // the default "translate only" contract instead of being translated.
    const folded = request.system ? `${request.system}\n\n${request.user}` : request.user;
    const text = await this.runTextTurn(asTaskMessage(folded), "completion");
    // latestUsage is the just-completed turn's usage — safe because runTurn
    // serializes turns through the mutex (one in flight at a time).
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
        throw new EngineTurnError(turnErrorMessage(label, event.apiErrorStatus), event.apiErrorStatus);
      }
    }
    return text.trim();
  }

  /**
   * Run a single turn: write one stdin line, stream its events until turn_end.
   * A per-turn idle watchdog aborts a hung turn with a content-free error, and a
   * child that crashed on a prior turn is respawned (resumed by id) so this and
   * later turns recover instead of throwing forever (#135).
   */
  private async *runTurn(line: string): AsyncGenerator<ParsedEvent> {
    const release = await this.turnMutex.acquire();
    let child = this.child;
    if (!child && this.hasStarted) {
      // The CLI crashed on a prior turn (onExit nulled the child). Respawn a
      // fresh session before this turn so translation recovers.
      child = await this.respawn();
    }
    if (!child) {
      this.recordTurnOutcome(false);
      release();
      throw new Error("engine not started");
    }
    const channel = new AsyncChannel<ParsedEvent>();
    this.currentTurn = channel;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Re-arm on every event → the watchdog measures the GAP between events, so a
    // slow-but-progressing stream is never cut, only a genuinely stalled one.
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // No event for turnTimeoutMs: abort with a content-free error and kill
        // the hung child so its (possibly late) output can't desync the next
        // turn; the next runTurn respawns.
        this.statusValue = { status: "error", detail: `turn timed out after ${this.turnTimeoutMs}ms` };
        channel.end(new EngineTimeoutError(this.turnTimeoutMs));
        this.killChild();
      }, this.turnTimeoutMs);
    };
    let threw = false;
    try {
      arm();
      child.stdin.write(line);
      for await (const event of channel) {
        arm();
        yield event;
        if (event.kind === "turn_end") break;
      }
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.currentTurn = null;
      // Healthy = the CLI responded (turn_end reached, even an error result) or
      // the channel closed cleanly. A consumer that throws on an error result
      // injects a return() at the turn_end yield without tripping `threw`, so
      // api-error turns stay "healthy" (the CLI is responsive). Unhealthy only
      // when the channel THREW — a watchdog timeout or a mid-turn crash (#135).
      this.recordTurnOutcome(!threw);
      release();
    }
  }

  /** Kill the current child (watchdog timeout). Nulls it first so a concurrent
   *  next-turn never writes to the dying process; onExit then no-ops on it. */
  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed.
    }
    child.kill();
  }

  /** Track consecutive turn failures; fire a one-shot `degraded` event once the
   *  streak reaches maxTurnFailures so the host can drive #7 fallback (#135). */
  private recordTurnOutcome(healthy: boolean): void {
    if (!this.hasStarted) return; // stopped / never started — nothing to account
    if (healthy) {
      this.consecutiveFailures = 0;
      this.degradedNotified = false;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxTurnFailures && !this.degradedNotified) {
      this.degradedNotified = true;
      this.emitHealthEvent({ kind: "degraded" });
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

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
    // Ignore a previous child's late exit after a respawn/watchdog-kill already
    // moved on (this.child now points elsewhere or is null) — otherwise it would
    // null the new child or clobber its status (#135).
    if (this.child !== child) return;
    this.child = null;
    const detail = `cli exited (code=${code ?? "null"}, signal=${signal ?? "null"}); ${stderrDigest(this.stderrBytes, this.stderrTail)}`;
    if (this.statusValue.status !== "stopped") {
      this.statusValue = { status: "error", detail };
    }
    this.currentTurn?.end(new Error(detail));
    this.currentTurn = null;
  }

  private recordUsage(event: Extract<ParsedEvent, { kind: "usage" }>): void {
    // total_cost_usd is cumulative-per-session and must never regress: an error
    // turn reports 0 (and the parser also defaults absent cost to 0). If we let
    // that reset the running total, the NEXT turn's delta would re-count the
    // whole session and CreditAccountant would double-charge (#24). Only advance
    // on a strictly higher cumulative; report the monotonic running total.
    const turnCostUsd = Math.max(0, event.cumulativeCostUsd - this.cumulativeCostUsd);
    if (event.cumulativeCostUsd > this.cumulativeCostUsd) {
      this.cumulativeCostUsd = event.cumulativeCostUsd;
    }
    const usage: Usage = {
      cumulativeCostUsd: this.cumulativeCostUsd,
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
