// Codex CLI as a third translation tier (#204), driving `codex app-server`
// over JSON-RPC/stdio.
//
// `app-server` — never `codex exec`. `exec` is one process per turn and returns
// the answer as a single completed message, which fails two of LiveCap's core
// assumptions (persistent multi-turn session, token-level streaming).
//
// Everything below was shaped by measurement against the real codex-cli 0.146.0
// rather than the schema alone. Two numbers drive the design:
//
//   * A stock turn costs ~13,700 input tokens of coding-agent scaffolding. With
//     `baseInstructions` replaced and the irrelevant feature set disabled that
//     falls to ~5,200 (-62%). {@link CODEX_DISABLED_FEATURES} is that measured
//     list, not a guess — it is why this tier is affordable at caption cadence.
//   * Per-turn input grows ~31 tokens/turn as the thread accumulates, so a long
//     meeting needs the same rollover discipline the Claude tier has. Codex
//     reports `modelContextWindow`, so the trigger keys on that.
//
// Cost: Codex exposes NO USD anywhere (zero cost fields across the generated v2
// schema). `Usage.turnCostUsd`/`cumulativeCostUsd` are therefore reported as 0
// rather than invented, and the auto-fallback decision rides entirely on the
// #205 headroom seam fed by {@link CodexHeadroomSource}. Shipping a token→USD
// rate card would be a drift surface and would show the user dollars they are
// not being charged.
//
// Security: this adapter never reads, stores, or logs a credential — auth lives
// entirely inside the user's own `codex` login. Caption text goes only into the
// turn input; it is never placed on argv, and the sandbox is pinned read-only
// with approvals off so no caption content can reach a tool or the filesystem.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { parseBrief } from "./internal/brief";
import { MAX_STDERR_TAIL, stderrDigest } from "./internal/redact";
import {
  asTaskMessage,
  buildSummaryMessage,
  buildSystemPrompt,
  buildTranslateMessage,
  formatUserMessageLine,
} from "./prompt";
import type {
  Completion,
  CompletionRequest,
  EngineHealth,
  MeetingBrief,
  RollingContext,
  Sentence,
  Translation,
  Usage,
} from "./types";

/**
 * Feature flags disabled on every spawn (#204, measured).
 *
 * These are `stable`/on-by-default coding-agent capabilities whose tool
 * definitions dominate the system prompt. Disabling them took a translation
 * turn from 13,727 to 5,168 input tokens with no loss of translation quality —
 * LiveCap needs none of them, and a translation session that can spawn shells
 * or browse is a liability rather than a feature.
 */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "mentions_v2",
  "personality",
  "goals",
  "hooks",
  "plugin_sharing",
  "remote_plugin",
  "workspace_dependencies",
  "tool_call_mcp_elicitation",
  "guardian_approval",
  "auth_elicitation",
  "shell_snapshot",
  "in_app_updates",
  "fast_mode",
  "memories",
  "steer",
];

/** Roll the thread over once a turn's input reaches this fraction of the
 *  model's context window (#204 scope 4). The Claude tier keys rollover on
 *  `cacheReadInputTokens`; Codex exposes no comparable cache signal but does
 *  report `modelContextWindow`, so that is the trigger here. Conservative: a
 *  fresh thread costs one cold turn, a wedged one costs the session. */
export const CODEX_ROLLOVER_CONTEXT_FRACTION = 0.6;

/**
 * The app-server protocol generation this adapter targets (#204 scope 6).
 *
 * `app-server` is marked [experimental] with no stability promise, so the
 * target is pinned here rather than assumed. Note what the pin can and cannot
 * be: the wire carries **no protocol-version field** — `initialize` returns
 * `userAgent`/`codexHome` only (verified against codex-cli 0.146.0) — so this
 * cannot be compared against a server-reported value. The startup probe is
 * therefore FUNCTIONAL: `initialize` followed by `thread/start` must both
 * succeed and yield a threadId before the engine reports ready, which is what
 * actually proves the protocol shape this adapter speaks.
 */
export const CODEX_PROTOCOL_VERSION = "v2";

/** The codex-cli version this adapter's overhead figures were measured on.
 *  Recorded so a future reader knows what the 13,727 → 5,168 numbers describe. */
export const CODEX_MEASURED_VERSION = "0.146.0";

/**
 * Extract the codex-cli version from the `userAgent` string `initialize`
 * returns, e.g. `"livecap/0.146.0 (Ubuntu 26.4.0; x86_64) …"` → `"0.146.0"`.
 *
 * Only the version is taken. The rest of that string — and `codexHome`, which
 * is a path containing the user's home directory — is deliberately dropped and
 * never stored or logged.
 */
export function parseCodexVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== "string") return null;
  const match = /\/(\d+\.\d+\.\d+)/.exec(userAgent);
  return match?.[1] ?? null;
}

export interface CodexAppServerEngineConfig {
  /** Absolute path to the `codex` binary (injected; never resolved here). */
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Target language name for the system prompt, e.g. "Korean". */
  targetLanguage: string;
  /** Recent context pairs to include per turn. */
  contextPairs?: number;
  /** Session-fixed glossary folded into the system prompt. */
  glossary?: Record<string, string>;
  /** Model pin (per thread). Omitted ⇒ the user's codex default. */
  model?: string;
  /** Fraction of `modelContextWindow` that triggers a rollover. */
  rolloverAtContextFraction?: number;
  /** Startup timeout for the initialize/thread-start handshake, ms. */
  startTimeoutMs?: number;
  /** Per-turn timeout, ms. */
  turnTimeoutMs?: number;
}

/** Thrown when a turn fails. Carries no model output or caption content. */
export class CodexTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexTurnError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 60_000;

export class CodexAppServerEngine {
  private readonly config: CodexAppServerEngineConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private stderrBytes = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly usageListeners = new Set<(usage: Usage) => void>();
  private statusValue: EngineHealth = { status: "stopped" };

  /** Server-minted thread id (#204 scope 3): Codex mints it, unlike the Claude
   *  path where the app generates a session id. Persisted so a crashed process
   *  can be recovered with `thread/resume`. */
  private threadId: string | null = null;
  /** Resolver for the in-flight turn, settled by `turn/completed`. */
  private turnSettle: ((error?: Error) => void) | null = null;
  /** Delta sink for the in-flight turn. */
  private turnDelta: ((text: string) => void) | null = null;
  private lastInputTokens = 0;
  private modelContextWindow = 0;
  private binaryVersion: string | null = null;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  /** Set when a turn's input crossed the rollover threshold (#204 scope 4). */
  private rolloverPending = false;

  constructor(config: CodexAppServerEngineConfig) {
    this.config = config;
  }

  health(): EngineHealth {
    return this.statusValue;
  }

  onUsage(listener: (usage: Usage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  /** The server-minted thread id, once started. Exposed for crash recovery. */
  currentThreadId(): string | null {
    return this.threadId;
  }

  /** codex-cli version reported at handshake, or null when unparseable. Version
   *  only — never the `codexHome` path or the rest of the userAgent string. */
  codexVersion(): string | null {
    return this.binaryVersion;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.statusValue = { status: "starting" };
    try {
      await this.spawnAndHandshake();
      this.statusValue = { status: "ready" };
    } catch (error) {
      this.statusValue = { status: "error", detail: contentFree(error) };
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.dispose();
    this.statusValue = { status: "stopped" };
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.turnSettle?.(new Error("engine stopped"));
    this.turnSettle = null;
    this.turnDelta = null;
    for (const [, p] of this.pending) p.reject(new Error("engine stopped"));
    this.pending.clear();
    child?.kill();
  }

  async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
    const ids = batch.map((s) => s.id);
    const line = formatUserMessageLine(buildTranslateMessage(batch, ctx, this.config.contextPairs));
    let text = "";
    for await (const delta of this.runTurn(line)) {
      text += delta;
      yield { sentenceIds: ids, text: text.trim(), done: false };
    }
    // Final snapshot, emitted even when the model produced nothing (allowed).
    yield { sentenceIds: ids, text: text.trim(), done: true };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    // The thread's system prompt is fixed at thread/start, so a per-request
    // system is folded into the message — same shape as the Claude tier.
    const message = request.system ? `${request.system}\n\n${request.user}` : request.user;
    let text = "";
    for await (const delta of this.runTurn(formatUserMessageLine(asTaskMessage(message)))) {
      text += delta;
    }
    return { text: text.trim(), usage: this.snapshotUsage() };
  }

  async summarize(transcript: string): Promise<MeetingBrief> {
    const { text, usage } = await this.complete({ user: buildSummaryMessage(transcript) });
    return { ...parseBrief(text), usage };
  }

  /* ---------------- internals ---------------- */

  private async spawnAndHandshake(): Promise<void> {
    const args = [
      "app-server",
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ];
    const child = spawn(this.config.bin, args, {
      cwd: this.config.cwd,
      env: this.config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBytes += chunk.length;
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
    child.on("exit", (code, signal) => this.onExit(code, signal));

    const timeout = this.config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const handshake = (await withDeadline(
      this.request("initialize", {
        clientInfo: { name: "livecap", title: "LiveCap", version: "0.1.0" },
      }),
      timeout,
      "codex initialize timed out",
    )) as { userAgent?: unknown } | null;
    // Record only the version digits; `codexHome` and the rest of the userAgent
    // string are dropped rather than stored.
    this.binaryVersion = parseCodexVersion(handshake?.userAgent);
    await withDeadline(this.startThread(), timeout, "codex thread/start timed out");
  }

  private async startThread(): Promise<void> {
    const result = (await this.request("thread/start", {
      // The whole point of the adapter: replace the coding-agent prompt with a
      // translation one. This is the single biggest overhead lever (-4,346
      // input tokens on its own, measured).
      baseInstructions: buildSystemPrompt({
        targetLanguage: this.config.targetLanguage,
        glossary: this.config.glossary,
      }),
      // Caption text must never reach a tool or the filesystem (#204 security).
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(this.config.model ? { model: this.config.model } : {}),
    })) as { threadId?: string; thread?: { id?: string } } | null;
    const threadId = result?.threadId ?? result?.thread?.id ?? null;
    if (!threadId) throw new Error("codex thread/start returned no threadId");
    this.threadId = threadId;
  }

  /** Recover a crashed server by resuming the SERVER-minted thread (#204). */
  private async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
    this.threadId = threadId;
  }

  /** Start a fresh thread, banking nothing — used for context rollover. */
  private async rollover(): Promise<void> {
    this.rolloverPending = false;
    this.lastInputTokens = 0;
    await this.startThread();
  }

  private async *runTurn(text: string): AsyncGenerator<string> {
    if (!this.child) throw new CodexTurnError("codex app-server is not running");
    if (this.rolloverPending) await this.rollover();
    if (!this.threadId) throw new CodexTurnError("codex thread is not started");

    const queue: string[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;

    this.turnDelta = (delta) => {
      queue.push(delta);
      notify?.();
    };
    this.turnSettle = (error) => {
      failure = error ?? null;
      finished = true;
      notify?.();
    };

    const timeout = this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timer = setTimeout(() => this.turnSettle?.(new CodexTurnError("codex turn timed out")), timeout);

    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text }],
      });
      for (;;) {
        while (queue.length > 0) yield queue.shift() as string;
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }
      while (queue.length > 0) yield queue.shift() as string;
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      this.turnDelta = null;
      this.turnSettle = null;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line === "") continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a non-JSON line is not fatal; the protocol is line-delimited
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id as number | undefined;
    if (typeof id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (!pending) return;
      if (message.error !== undefined) pending.reject(new CodexTurnError("codex request failed"));
      else pending.resolve(message.result);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "item/agentMessage/delta": {
        const delta = params.delta;
        if (typeof delta === "string") this.turnDelta?.(delta);
        break;
      }
      case "thread/tokenUsage/updated":
        this.recordTokenUsage(params.tokenUsage as Record<string, unknown> | undefined);
        break;
      case "turn/completed":
        this.turnSettle?.();
        break;
      case "turn/failed":
        this.turnSettle?.(new CodexTurnError("codex turn failed"));
        break;
      default:
        break;
    }
  }

  private recordTokenUsage(tokenUsage: Record<string, unknown> | undefined): void {
    if (!tokenUsage) return;
    const last = (tokenUsage.last ?? {}) as Record<string, number>;
    const contextWindow = tokenUsage.modelContextWindow;
    if (typeof contextWindow === "number" && contextWindow > 0) {
      this.modelContextWindow = contextWindow;
    }
    const inputTokens = numberOr(last.inputTokens, 0);
    const outputTokens = numberOr(last.outputTokens, 0);
    this.lastInputTokens = inputTokens;
    this.cumulativeInputTokens += inputTokens;
    this.cumulativeOutputTokens += outputTokens;

    // Rollover trigger (#204 scope 4): the thread grows ~31 tokens/turn, so a
    // long meeting walks toward the context wall. Flagged here, applied before
    // the NEXT turn so the in-flight one is never interrupted.
    const fraction = this.config.rolloverAtContextFraction ?? CODEX_ROLLOVER_CONTEXT_FRACTION;
    if (this.modelContextWindow > 0 && inputTokens >= this.modelContextWindow * fraction) {
      this.rolloverPending = true;
    }

    const usage: Usage = {
      // Codex reports no USD anywhere. Zero is the honest value; the fallback
      // decision comes from the #205 headroom seam, not from this field.
      cumulativeCostUsd: 0,
      turnCostUsd: 0,
      inputTokens,
      outputTokens,
      cacheReadInputTokens: numberOr(last.cachedInputTokens, 0),
    };
    for (const listener of this.usageListeners) {
      try {
        listener(usage);
      } catch {
        // A faulty subscriber is its own problem; accounting continues.
      }
    }
  }

  private snapshotUsage(): Usage {
    return {
      cumulativeCostUsd: 0,
      turnCostUsd: 0,
      inputTokens: this.cumulativeInputTokens,
      outputTokens: this.cumulativeOutputTokens,
      cacheReadInputTokens: 0,
    };
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null;
    const detail = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}); ${stderrDigest(this.stderrBytes, this.stderrTail)}`;
    if (this.statusValue.status !== "stopped") this.statusValue = { status: "error", detail };
    this.turnSettle?.(new CodexTurnError(detail));
    for (const [, pending] of this.pending) pending.reject(new CodexTurnError(detail));
    this.pending.clear();
  }

  /**
   * Respawn after a crash and resume the server-minted thread (#204 AC:
   * "killing the codex process mid-session recovers via thread/resume with
   * continuity intact").
   */
  async recover(): Promise<void> {
    const threadId = this.threadId;
    this.dispose();
    this.statusValue = { status: "starting" };
    const args = [
      "app-server",
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ];
    const child = spawn(this.config.bin, args, {
      cwd: this.config.cwd,
      env: this.config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBytes += chunk.length;
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
    child.on("exit", (code, signal) => this.onExit(code, signal));

    await this.request("initialize", {
      clientInfo: { name: "livecap", title: "LiveCap", version: "0.1.0" },
    });
    if (threadId) await this.resumeThread(threadId);
    else await this.startThread();
    this.statusValue = { status: "ready" };
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function contentFree(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
