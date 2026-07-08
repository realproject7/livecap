import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";

import { LocalLlmEngine } from "../src/local-llm-engine";
import type { LocalLlmEngineConfig } from "../src/local-llm-engine";
import type { Sentence, Usage } from "../src/types";

const FAKE_SERVER = fileURLToPath(new URL("./fake-llama-server.mjs", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

// Every engine handed out by makeEngine is disposed after each test so a child
// left alive by a throwing test (or one that only asserts start() rejects) is
// SIGKILLed instead of reparenting to PID 1 and surviving `pnpm test`.
// dispose() (PR #74) is synchronous and idempotent. A global-teardown backstop
// (vitest.config.ts) sweeps any straggler a rare missed-kill path leaves behind.
const liveEngines = new Set<LocalLlmEngine>();

afterEach(() => {
  for (const engine of liveEngines) engine.dispose();
  liveEngines.clear();
});

async function makeEngine(overrides: Partial<LocalLlmEngineConfig> = {}): Promise<LocalLlmEngine> {
  const port = overrides.port ?? (await freePort());
  const engine = new LocalLlmEngine({
    bin: FAKE_SERVER,
    modelPath: `${tmpdir()}/unused.gguf`,
    port,
    startupTimeoutMs: 8000,
    env: { ...process.env, ...(overrides.env as Record<string, string> | undefined) },
    ...overrides,
  });
  liveEngines.add(engine);
  return engine;
}

const batch: Sentence[] = [{ id: "s1", text: "We are committed to the dual mandate.", seq: 1 }];

describe("LocalLlmEngine — real spawn + HTTP (fake llama-server)", () => {
  it("starts the server, translates, and applies the commentary guard", async () => {
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_CONTENT: "Here is the translation:\n저희는 이중 위임에 전념하고 있습니다." },
    });
    const usages: Usage[] = [];
    engine.onUsage((u) => usages.push(u));
    await engine.start();
    expect(engine.health().status).toBe("ready");
    try {
      const out = [];
      for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
      const final = out.at(-1);
      expect(final?.done).toBe(true);
      // The "Here is the translation:" preamble is stripped by the guard.
      expect(final?.text).toBe("저희는 이중 위임에 전념하고 있습니다.");
      expect(usages.at(-1)?.cumulativeCostUsd).toBe(0); // local is free
      expect(usages.at(-1)?.outputTokens).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
    expect(engine.health().status).toBe("stopped");
  });

  it("disables Qwen3 thinking in the chat request", async () => {
    const engine = await makeEngine();
    await engine.start();
    try {
      const port = (engine as unknown as { config: { port: number } }).config.port;
      const out = [];
      for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
      const res = await fetch(`http://127.0.0.1:${port}/last-request`);
      const sent = (await res.json()) as { chat_template_kwargs?: { enable_thinking?: boolean } };
      expect(sent.chat_template_kwargs?.enable_thinking).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("still sends recent-context pairs — the stateless local tier keeps its window (#136)", async () => {
    // #136 trims the redundant context pairs on the CLI tier only (its session
    // remembers prior turns). The local tier is stateless per request, so it must
    // keep receiving the pairs — LazyLocalEngine passes no contextPairs, so the
    // engine uses the full default window.
    const engine = await makeEngine();
    await engine.start();
    try {
      const port = (engine as unknown as { config: { port: number } }).config.port;
      const ctx = { pairs: [{ source: "dual mandate", target: "이중 위임" }] };
      const out = [];
      for await (const t of engine.translate(batch, ctx)) out.push(t);
      const res = await fetch(`http://127.0.0.1:${port}/last-request`);
      const sent = (await res.json()) as { messages?: { role: string; content: string }[] };
      const userMessage = sent.messages?.find((m) => m.role === "user")?.content ?? "";
      expect(userMessage).toContain("Recent context");
      expect(userMessage).toContain("dual mandate");
    } finally {
      await engine.stop();
    }
  });

  it("waits through a slow /health before reporting ready", async () => {
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_HEALTH_DELAY_MS: "300" },
    });
    await engine.start();
    try {
      expect(engine.health().status).toBe("ready");
    } finally {
      await engine.stop();
    }
  });

  it("drains server stderr so noise never wedges the session", async () => {
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_STDERR: "x".repeat(100_000) },
    });
    await engine.start();
    try {
      const out = [];
      for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
      expect(out.at(-1)?.text.length).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it("errors when the server never becomes healthy", async () => {
    // Point at a bin that exits immediately — health never comes up.
    const engine = await makeEngine({ bin: process.execPath, extraArgs: ["-e", ""], startupTimeoutMs: 1500 });
    await expect(engine.start()).rejects.toThrow();
    expect(engine.health().status).toBe("error");
  });

  it("kills a live-but-unhealthy server on startup timeout and stays restartable", async () => {
    // The fake server runs (and holds the port) but /health stays 503 well past
    // the timeout — exactly the live-but-unhealthy case.
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_HEALTH_DELAY_MS: "5000" },
      startupTimeoutMs: 600,
    });
    await expect(engine.start()).rejects.toThrow(/health timeout/);
    expect(engine.health().status).toBe("error");
    // If the timed-out child had been left attached, this second start() would
    // early-return (resolve) instead of re-attempting — so a reject proves the
    // child was killed and the handle cleared (the engine is restartable).
    await expect(engine.start()).rejects.toThrow();
    await engine.stop();
  });

  it("dispose() synchronously force-kills the running server so it is not orphaned (#66)", async () => {
    const engine = await makeEngine();
    await engine.start();
    expect(engine.health().status).toBe("ready");
    const port = (engine as unknown as { config: { port: number } }).config.port;

    // Synchronous teardown for process termination — no await on a graceful stop.
    engine.dispose();

    // The server must actually be gone: poll until the port stops answering.
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
      } catch {
        alive = false;
      }
      if (alive) await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive).toBe(false);
    // Idempotent: a second dispose() (e.g. signal + stdin-close both firing) is safe.
    engine.dispose();
  });

  it("redacts server stderr content from the health timeout detail (#23)", async () => {
    const SECRET = "CAPTION-SECRET-merger-terms";
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_HEALTH_DELAY_MS: "5000", LLAMA_FAKE_STDERR: SECRET },
      startupTimeoutMs: 600,
    });
    await expect(engine.start()).rejects.toThrow(/health timeout/);
    const detail = engine.health().detail ?? "";
    expect(detail).not.toContain(SECRET);
    expect(detail).toMatch(/stderr \d+ bytes \(tail sha256:[0-9a-f]{8}\)/);
    await engine.stop();
  });

  it("counts UTF-8 bytes (not UTF-16 chars) in the stderr digest (#41)", async () => {
    const KO = "가".repeat(50); // 50 chars but 150 UTF-8 bytes
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_HEALTH_HANG: "1", LLAMA_FAKE_STDERR: KO },
      startupTimeoutMs: 500,
    });
    await expect(engine.start()).rejects.toThrow(/health timeout/);
    const detail = engine.health().detail ?? "";
    const match = /stderr (\d+) bytes/.exec(detail);
    expect(match).not.toBeNull();
    // ≥ 50×3 bytes (plus a newline); pre-fix this counted ~51 UTF-16 chars.
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(150);
    await engine.stop();
  });

  it("aborts a wedged /health poll instead of hanging start() forever (#34)", async () => {
    // The server accepts the /health connection but never responds. Pre-fix the
    // fetch had no AbortSignal, so start() would hang past startupTimeoutMs.
    const engine = await makeEngine({
      env: { ...process.env, LLAMA_FAKE_HEALTH_HANG: "1" },
      startupTimeoutMs: 500,
    });
    await expect(engine.start()).rejects.toThrow(/health timeout/);
    expect(engine.health().status).toBe("error");
    await engine.stop();
  });

  it("summarize() uses the [TASK] override and strips <think> reasoning (#35)", async () => {
    const engine = await makeEngine({
      env: {
        ...process.env,
        LLAMA_FAKE_CONTENT: "<think>let me reason about the meeting</think>\nMeeting covered the budget.",
      },
    });
    await engine.start();
    try {
      const brief = await engine.summarize("transcript text");
      // <think> reasoning is stripped before parseBrief, like translate/complete.
      expect(brief.summary).not.toContain("let me reason");
      expect(brief.summary).toBe("Meeting covered the budget.");
      // The request actually sent to the server was [TASK]-marked.
      const port = (engine as unknown as { config: { port: number } }).config.port;
      const res = await fetch(`http://127.0.0.1:${port}/last-request`);
      const sent = (await res.json()) as { messages: { role: string; content: string }[] };
      expect(sent.messages.at(-1)?.content.startsWith("[TASK]")).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("attributes usage per concurrent request — no shared-latestUsage race (#36)", async () => {
    // Injected fetch: /health ok; chat echoes per-request token counts with a
    // staggered delay to interleave concurrent turns. Pre-fix, complete()/
    // summarize() returned the shared `latestUsage`, so concurrent turns
    // cross-attributed tokens.
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/health")) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] };
      const n = Number(/tok=(\d+)/.exec(body.messages.at(-1)?.content ?? "")?.[1]);
      await new Promise((r) => setTimeout(r, (n % 3) * 5));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `out-${n}` } }],
          usage: { prompt_tokens: n, completion_tokens: n },
        }),
        { status: 200 },
      );
    };
    const engine = await makeEngine({ fetchImpl });
    await engine.start();
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => engine.complete({ user: `tok=${i + 1}` })),
      );
      results.forEach((r, i) => {
        expect(r.usage.outputTokens).toBe(i + 1); // each got ITS OWN tokens
        expect(r.usage.inputTokens).toBe(i + 1);
      });
    } finally {
      await engine.stop();
    }
  });
});
