// Local LLM fallback engine (issue #6, PROPOSAL §4 tier 2): a llama.cpp server
// hosting Qwen3-4B behind the SAME TranslationEngine interface as the CLI tier,
// so #7's auto-fallback can hot-swap mid-meeting. Cost is $0 (local). The
// binary path, model path, host/port, and base env are injected — the package
// resolves no platform paths itself.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { stderrDigest } from "./internal/redact";
import { asTaskMessage, buildSummaryMessage, buildSystemPrompt, buildTranslateMessage } from "./prompt";
import { stripNonTranslation, stripThinking } from "./translation-guard";
import type {
  Completion,
  CompletionRequest,
  EngineHealth,
  MeetingBrief,
  RollingContext,
  Sentence,
  Translation,
  TranslationEngine,
  Usage,
} from "./types";

export interface LocalLlmEngineConfig {
  /** Path to the llama.cpp `llama-server` binary (injected). */
  bin: string;
  /** Path to the GGUF model file (injected; see ensureModel). */
  modelPath: string;
  /** Port the server listens on (injected). */
  port: number;
  /** Host; defaults to 127.0.0.1 (local only). */
  host?: string;
  /** Base environment for the child. */
  env?: Record<string, string | undefined>;
  /** Context window size passed to llama-server. */
  ctxSize?: number;
  /** Extra llama-server args (injected; e.g. -ngl for GPU layers). */
  extraArgs?: string[];
  /** Health-poll timeout in ms before start() gives up. Default 60s. */
  startupTimeoutMs?: number;
  /** Per-request timeout in ms; a hung server aborts so #7 can fall back. Default 30s. */
  requestTimeoutMs?: number;
  targetLanguage?: string;
  glossary?: Record<string, string>;
  contextPairs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const MAX_STDERR_TAIL = 2000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_CTX = 4096;
const DEFAULT_STARTUP_TIMEOUT = 60_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const STOP_GRACE_MS = 2000;
// Per-poll timeout on the /health probe (#34): a server that accepts the TCP
// connection but never responds must still trip startupTimeoutMs.
const HEALTH_POLL_TIMEOUT = 2000;

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LocalLlmEngine implements TranslationEngine {
  private readonly config: LocalLlmEngineConfig;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly systemPrompt: string;
  private readonly usageListeners = new Set<(usage: Usage) => void>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private stderrTail = "";
  private stderrBytes = 0;
  private statusValue: EngineHealth = { status: "stopped" };

  constructor(config: LocalLlmEngineConfig) {
    this.config = config;
    this.host = config.host ?? DEFAULT_HOST;
    this.fetchImpl = config.fetchImpl ?? fetch;
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

  private get baseUrl(): string {
    return `http://${this.host}:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.statusValue = { status: "starting" };

    const args = [
      "--model",
      this.config.modelPath,
      "--host",
      this.host,
      "--port",
      String(this.config.port),
      "--ctx-size",
      String(this.config.ctxSize ?? DEFAULT_CTX),
      // The pinned Qwen3-4B GGUF is the hybrid-THINKING model (no official
      // Instruct GGUF exists). Disable reasoning so it does not emit a
      // multi-second <think> block before each translation. --jinja makes the
      // server honor chat_template_kwargs (the per-request belt-and-suspenders).
      "--jinja",
      "--reasoning-budget",
      "0",
      ...(this.config.extraArgs ?? []),
    ];

    const child = spawn(this.config.bin, args, {
      env: this.config.env ? sanitize(this.config.env) : undefined,
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

    // Drain stderr (an unread pipe fills and wedges the server). Only a byte
    // count + a hash of the capped tail are surfaced (#23) — never the raw text.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Count actual UTF-8 bytes (not UTF-16 code units) so the digest's
      // "N bytes" label is truthful for multi-byte stderr (#41).
      this.stderrBytes += Buffer.byteLength(chunk, "utf8");
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
    child.stdout.resume();
    child.once("exit", (code, signal) => this.onExit(code, signal));

    try {
      await this.waitForHealth();
    } catch (err) {
      // A live-but-unhealthy server must not be left running, or it keeps the
      // port/model open and the next start() early-returns into a non-ready
      // engine. Kill it and clear the handle before rethrowing.
      this.killChild();
      throw err;
    }
    this.statusValue = { status: "ready" };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.statusValue = { status: "stopped" };
    // Await exit so the port/socket is released before we return — a quick
    // stop()→start() on the same port otherwise races the dying server.
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /** Force-terminate the child and clear the handle (failed-startup cleanup). */
  private killChild(): void {
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
  }

  async *translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
    const userMessage = buildTranslateMessage(batch, ctx, this.config.contextPairs);
    const { content } = await this.chat(userMessage);
    const text = stripNonTranslation(content, batch.length);
    yield { sentenceIds: batch.map((s) => s.id), text, done: true };
  }

  async summarize(transcript: string): Promise<MeetingBrief> {
    // [TASK]-marked so the session's translation system prompt yields to the
    // summary instructions (#35), and <think> stripped like translate/complete.
    const { content, usage } = await this.chat(asTaskMessage(buildSummaryMessage(transcript)));
    return { ...parseBrief(stripThinking(content)), usage };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    // Generic generation: use the caller's system (not the translation prompt)
    // and keep the full output — only the hybrid-thinking block is stripped.
    const { content, usage } = await this.chat(request.user, request.system ?? "");
    return { text: stripThinking(content).trim(), usage };
  }

  /**
   * One chat-completions round-trip. Returns the usage parsed from THIS
   * response (not shared state), so concurrent turns never cross-attribute
   * tokens (#36); also emits it to usage listeners.
   */
  private async chat(
    userMessage: string,
    system: string = this.systemPrompt,
  ): Promise<{ content: string; usage: Usage }> {
    if (!this.child) throw new Error("engine not started");
    // Abort a hung (not dead) server so translate()/summarize() reject and #7's
    // auto-fallback gets a failure signal instead of stalling forever.
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT);
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        stream: false,
        // Disable Qwen3 hybrid thinking per-request (requires --jinja server-side).
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`local engine HTTP ${res.status}`);
    const data = (await res.json()) as ChatResponse;
    // Local inference is free — cost stays 0; tokens come from THIS response.
    const usage: Usage = {
      cumulativeCostUsd: 0,
      turnCostUsd: 0,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadInputTokens: 0,
    };
    for (const listener of this.usageListeners) listener(usage);
    return { content: data.choices?.[0]?.message?.content ?? "", usage };
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + (this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT);
    for (;;) {
      if (!this.child) throw new Error("server exited before becoming healthy");
      try {
        // Per-poll abort so a wedged server (TCP accept, no response) can't hang
        // the fetch forever and defeat startupTimeoutMs (#34).
        const res = await this.fetchImpl(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(HEALTH_POLL_TIMEOUT),
        });
        if (res.ok) return;
      } catch {
        // server not up yet, or this poll timed out — fall through to the deadline check
      }
      if (Date.now() > deadline) {
        const detail = `local server health timeout; ${stderrDigest(this.stderrBytes, this.stderrTail)}`;
        this.statusValue = { status: "error", detail };
        throw new Error(detail);
      }
      await delay(100);
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null;
    // Only an exit while running counts as a new error — don't clobber a
    // deliberate stop() or an already-recorded startup error (e.g. the health
    // timeout that just killed this child) with a less useful exit message.
    if (this.statusValue.status === "starting" || this.statusValue.status === "ready") {
      const detail = `llama-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}); ${stderrDigest(this.stderrBytes, this.stderrTail)}`;
      this.statusValue = { status: "error", detail };
    }
  }

}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drop undefined values so spawn gets a clean string env. */
function sanitize(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

/** Split a summary response into the running paragraph and board lines. */
function parseBrief(text: string): { summary: string; board: string[] } {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const summary = lines.find((line) => !line.startsWith("[")) ?? "";
  const board = lines.filter((line) => line.startsWith("["));
  return { summary, board };
}
