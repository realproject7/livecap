import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

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

async function makeEngine(overrides: Partial<LocalLlmEngineConfig> = {}): Promise<LocalLlmEngine> {
  const port = await freePort();
  return new LocalLlmEngine({
    bin: FAKE_SERVER,
    modelPath: `${tmpdir()}/unused.gguf`,
    port,
    startupTimeoutMs: 8000,
    env: { ...process.env, ...(overrides.env as Record<string, string> | undefined) },
    ...overrides,
  });
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
});
