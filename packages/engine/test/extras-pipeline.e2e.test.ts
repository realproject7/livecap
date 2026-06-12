// The extras pipeline driven through BOTH real engines (issue #9 AC): the CLI
// adapter via fake-cli replaying a recorded fixture, and the local engine via
// the fake llama-server. No real Claude/llama CLI is invoked.

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
  new URL("./fixtures/claude-stream/session-without-partials.jsonl", import.meta.url),
);

const BOARD_OUTPUT = [
  "SUMMARY",
  "- point one",
  "DECISIONS",
  "- ship it",
  "ACTION ITEMS",
  "- Mike → docs",
  "OPEN QUESTIONS",
  "- when do we cut?",
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

describe("ExtrasPipeline — driven through ClaudeCliEngine (fake-cli)", () => {
  it("runs summary/board, reply, and quick-translate through the real CLI path", async () => {
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: FIXTURE },
      includePartialMessages: false,
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "English", meetingLanguage: "English" });

    const board = await pipeline.generateSummaryBoard("Some transcript.");
    expect(Array.isArray(board.summary)).toBe(true);
    expect(board.usage).toBeDefined();

    const reply = await pipeline.suggestReply("agree", ["a", "b"]);
    expect(typeof reply.text).toBe("string");

    const quick = await pipeline.quickTranslate("hello");
    expect(typeof quick.text).toBe("string");
  });
});

describe("ExtrasPipeline — driven through LocalLlmEngine (fake llama-server)", () => {
  it("parses a real structured board returned over HTTP", async () => {
    const engine = new LocalLlmEngine({
      bin: FAKE_SERVER,
      modelPath: `${tmpdir()}/unused.gguf`,
      port: await freePort(),
      startupTimeoutMs: 8000,
      env: { ...process.env, LLAMA_FAKE_CONTENT: BOARD_OUTPUT },
    });
    active = engine;
    await engine.start();
    const pipeline = new ExtrasPipeline({ engine, summaryLanguage: "한국어", meetingLanguage: "English" });

    const board = await pipeline.generateSummaryBoard("transcript");
    expect(board.summary).toEqual(["point one"]);
    expect(board.board.decisions).toEqual(["ship it"]);
    expect(board.board.actionItems).toEqual(["Mike → docs"]);
    expect(board.board.openQuestions).toEqual(["when do we cut?"]);
    expect(board.usage.cumulativeCostUsd).toBe(0);

    const reply = await pipeline.suggestReply("push-back", ["x", "y"]);
    expect(typeof reply.text).toBe("string");
    expect(reply.text.length).toBeGreaterThan(0);
  });
});
