import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { ClaudeCliEngine } from "../src/claude-cli-engine";
import type { Sentence, Translation, Usage } from "../src/types";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/claude-stream/${name}`, import.meta.url));
}

function makeEngine(fixture: string, includePartialMessages: boolean): ClaudeCliEngine {
  return new ClaudeCliEngine({
    bin: FAKE_CLI,
    cwd: tmpdir(),
    env: { ...process.env, LIVECAP_FAKE_FIXTURE: fixturePath(fixture) },
    includePartialMessages,
  });
}

const batch: Sentence[] = [{ id: "s1", text: "We are committed to the dual mandate.", seq: 1 }];

async function drain(engine: ClaudeCliEngine): Promise<Translation[]> {
  const out: Translation[] = [];
  for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
  return out;
}

describe("ClaudeCliEngine — real spawn/stdio (fake-cli replay)", () => {
  it("translates a batch end-to-end without partials and reports usage", async () => {
    const engine = makeEngine("session-without-partials.jsonl", false);
    const usages: Usage[] = [];
    engine.onUsage((u) => usages.push(u));
    await engine.start();
    expect(engine.health().status).toBe("ready");
    try {
      const snapshots = await drain(engine);
      const final = snapshots.at(-1);
      expect(final?.done).toBe(true);
      expect(final?.sentenceIds).toEqual(["s1"]);
      expect(final?.text.length).toBeGreaterThan(0);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.cumulativeCostUsd).toBeGreaterThan(0);
      expect(usages[0]?.turnCostUsd).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
    expect(engine.health().status).toBe("stopped");
  });

  it("streams progressive snapshots from partial-message deltas", async () => {
    const engine = makeEngine("session-with-partials.jsonl", true);
    await engine.start();
    try {
      const snapshots = await drain(engine);
      // Multiple deltas → multiple in-progress snapshots, then a final one.
      expect(snapshots.length).toBeGreaterThan(1);
      expect(snapshots.filter((s) => !s.done).length).toBeGreaterThan(0);
      expect(snapshots.at(-1)?.done).toBe(true);
      expect(snapshots.at(-1)?.text).toContain("이중 위임");
    } finally {
      await engine.stop();
    }
  });

  it("serializes two turns through one persistent session", async () => {
    const engine = makeEngine("session-without-partials.jsonl", false);
    await engine.start();
    try {
      const first = (await drain(engine)).at(-1);
      const second = (await drain(engine)).at(-1);
      expect(first?.text.length).toBeGreaterThan(0);
      expect(second?.text.length).toBeGreaterThan(0);
      // Second turn replays a distinct recorded block.
      expect(second?.text).not.toBe(first?.text);
    } finally {
      await engine.stop();
    }
  });

  it("throws EngineTurnError with the api error status on an error result", async () => {
    const engine = makeEngine("error-invalid-model.jsonl", false);
    await engine.start();
    try {
      await expect(drain(engine)).rejects.toMatchObject({
        name: "EngineTurnError",
        apiErrorStatus: 404,
      });
      expect(engine.health().status).toBe("ready");
    } finally {
      await engine.stop();
    }
  });

  it("does not put the model's verbatim result text in EngineTurnError.message (#23)", async () => {
    // The error fixture's result.result is "There's an issue with the selected
    // model …" — content that must NOT travel in the thrown error message.
    const engine = makeEngine("error-invalid-model.jsonl", false);
    await engine.start();
    try {
      await drain(engine);
      throw new Error("expected EngineTurnError");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("issue with the selected model");
      expect(message).toBe("translation turn failed (api_error_status=404)");
    } finally {
      await engine.stop();
    }
  });

  it("marks complete() requests with [TASK] so they override the translation prompt", async () => {
    // Echo mode: the fake CLI replies with exactly the message it received, so
    // we can assert what the adapter actually sent over stdin.
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_ECHO: "1" },
      includePartialMessages: false,
    });
    await engine.start();
    try {
      const result = await engine.complete({ system: "Be a board generator.", user: "the transcript" });
      expect(result.text.startsWith("[TASK]")).toBe(true);
      expect(result.text).toContain("Be a board generator.");
      expect(result.text).toContain("the transcript");
    } finally {
      await engine.stop();
    }
  });

  it("summarizes a transcript and attaches usage", async () => {
    const engine = makeEngine("session-without-partials.jsonl", false);
    await engine.start();
    try {
      const brief = await engine.summarize("FOMC press conference transcript …");
      expect(brief.summary.length).toBeGreaterThan(0);
      expect(brief.usage.cumulativeCostUsd).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it("drains child stderr so noise never wedges the session", async () => {
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: {
        ...process.env,
        LIVECAP_FAKE_FIXTURE: fixturePath("session-without-partials.jsonl"),
        LIVECAP_FAKE_STDERR: "x".repeat(100_000), // >> the ~64KB pipe buffer
      },
      includePartialMessages: false,
    });
    await engine.start();
    try {
      const final = (await drain(engine)).at(-1);
      // If stderr were not drained the CLI would block before responding.
      expect(final?.done).toBe(true);
      expect(final?.text.length).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it("redacts stderr content from the exit error detail — byte count + hash only (#23)", async () => {
    // No fixture path → fake-cli writes to stderr and exits(1). Also inject a
    // recognizable "caption" secret into stderr; it must NOT reach health.detail.
    const SECRET = "CAPTION-SECRET-deal-with-AcmeCorp-Q3";
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: undefined, LIVECAP_FAKE_STDERR: SECRET },
      includePartialMessages: false,
    });
    await engine.start();
    // Wait for the child's exit to propagate into health.
    const deadline = Date.now() + 2000;
    while (engine.health().status !== "error" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const health = engine.health();
    expect(health.status).toBe("error");
    expect(health.detail).not.toContain(SECRET); // no caption content
    expect(health.detail).not.toContain("LIVECAP_FAKE_FIXTURE not set"); // no raw stderr line
    expect(health.detail).toMatch(/stderr \d+ bytes \(tail sha256:[0-9a-f]{8}\)/);
    await engine.stop();
  });
});
