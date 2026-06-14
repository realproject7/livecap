// #79 conformance: ExtrasPipeline.coachUtterance driven through BOTH real engine
// tiers — the CLI adapter via fake-cli replaying a recorded stream-json fixture,
// and the local engine via the fake llama-server. No real Claude/llama CLI is
// invoked. The method must run and parse identically on both tiers.

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
  new URL("./fixtures/scenarios/coach-utterance.jsonl", import.meta.url),
);

const COACH_OUTPUT = [
  "BETTER",
  "I'd like to shift our personalization to real-time contextual curation.",
  "CHANGES",
  "take out—take our personalization => shift our personalization",
  "EXPLANATION",
  "Removes the false starts and states the idea directly.",
].join("\n");

const DISFLUENT = "So I'm—I would aim to take out—take our personalization, uh, from, uh";

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

describe("coachUtterance — driven through ClaudeCliEngine (fake-cli)", () => {
  it("parses better / changes / explanation out of a real CLI turn", async () => {
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: FIXTURE },
      includePartialMessages: false,
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const result = await pipeline.coachUtterance(DISFLUENT);
    expect(result.better).toBe(
      "I'd like to shift our personalization to real-time contextual curation.",
    );
    expect(result.changes).toEqual([
      { from: "take out—take our personalization", to: "shift our personalization" },
    ]);
    expect(result.explanation).toBe("Removes the false starts and states the idea directly.");
    expect(result.usage).toBeDefined();
  });
});

describe("coachUtterance — driven through LocalLlmEngine (fake llama-server)", () => {
  it("parses better / changes / explanation returned over HTTP", async () => {
    const engine = new LocalLlmEngine({
      bin: FAKE_SERVER,
      modelPath: `${tmpdir()}/unused.gguf`,
      port: await freePort(),
      startupTimeoutMs: 8000,
      env: { ...process.env, LLAMA_FAKE_CONTENT: COACH_OUTPUT },
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const result = await pipeline.coachUtterance(DISFLUENT);
    expect(result.better).toBe(
      "I'd like to shift our personalization to real-time contextual curation.",
    );
    expect(result.changes).toEqual([
      { from: "take out—take our personalization", to: "shift our personalization" },
    ]);
    expect(result.explanation).toBe("Removes the false starts and states the idea directly.");
    expect(result.usage.cumulativeCostUsd).toBe(0);
  });

  it("degenerate input is a no-op on the real engine path too — never reaches the model", async () => {
    const engine = new LocalLlmEngine({
      bin: FAKE_SERVER,
      modelPath: `${tmpdir()}/unused.gguf`,
      port: await freePort(),
      startupTimeoutMs: 8000,
      env: { ...process.env, LLAMA_FAKE_CONTENT: COACH_OUTPUT },
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const result = await pipeline.coachUtterance("Yeah");
    // The model would have returned the rewrite above; a no-op means we never asked.
    expect(result.better).toBe("Yeah");
    expect(result.changes).toEqual([]);
    expect(result.usage.turnCostUsd).toBe(0);
  });
});
