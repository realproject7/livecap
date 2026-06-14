// #77 conformance: ExtrasPipeline.analyzeAndRespond driven through BOTH real
// engine tiers — the CLI adapter via fake-cli replaying a recorded stream-json
// fixture, and the local engine via the fake llama-server. No real Claude/llama
// CLI is invoked. The method must run and parse identically on both tiers.

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";

import { ClaudeCliEngine } from "../src/claude-cli-engine";
import { ExtrasPipeline } from "../src/extras-pipeline";
import { LocalLlmEngine } from "../src/local-llm-engine";
import type { TranslationEngine } from "../src/types";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL("./fake-llama-server.mjs", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./fixtures/scenarios/analyze-respond.jsonl", import.meta.url),
);

// The two-section output both fake engines return — the shape a real model emits.
const ANALYZE_OUTPUT = [
  "ANALYSIS",
  "They want a concrete churn number, then your plan. Acknowledge first.",
  "REPLY",
  "Our 90-day churn is 4%, and here is how we bring it down further.",
].join("\n");

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

let active: TranslationEngine | null = null;
afterEach(async () => {
  if (active) await active.stop();
  active = null;
});

describe("analyzeAndRespond — driven through ClaudeCliEngine (fake-cli)", () => {
  it("parses the targeted analysis + reply out of a real CLI turn", async () => {
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: FIXTURE },
      includePartialMessages: false,
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const result = await pipeline.analyzeAndRespond("How will you handle churn?", ["Them: a question"]);
    expect(result.analysis).toBe(
      "They want a concrete churn number, then your plan. Acknowledge first.",
    );
    expect(result.reply).toBe("Our 90-day churn is 4%, and here is how we bring it down further.");
    expect(result.usage).toBeDefined();
  });
});

describe("analyzeAndRespond — driven through LocalLlmEngine (fake llama-server)", () => {
  it("parses the targeted analysis + reply returned over HTTP", async () => {
    const engine = new LocalLlmEngine({
      bin: FAKE_SERVER,
      modelPath: `${tmpdir()}/unused.gguf`,
      port: await freePort(),
      startupTimeoutMs: 8000,
      env: { ...process.env, LLAMA_FAKE_CONTENT: ANALYZE_OUTPUT },
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const result = await pipeline.analyzeAndRespond("How will you handle churn?", []);
    expect(result.analysis).toBe(
      "They want a concrete churn number, then your plan. Acknowledge first.",
    );
    expect(result.reply).toBe("Our 90-day churn is 4%, and here is how we bring it down further.");
    expect(result.usage.cumulativeCostUsd).toBe(0);
  });

  it("does not throw when the model omits a section — degrades gracefully", async () => {
    const engine = new LocalLlmEngine({
      bin: FAKE_SERVER,
      modelPath: `${tmpdir()}/unused.gguf`,
      port: await freePort(),
      startupTimeoutMs: 8000,
      env: { ...process.env, LLAMA_FAKE_CONTENT: "Sure, happy to walk you through that." },
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const result = await pipeline.analyzeAndRespond("How will you handle churn?", []);
    expect(result.analysis).toBe("");
    expect(result.reply).toBe("Sure, happy to walk you through that.");
  });
});
