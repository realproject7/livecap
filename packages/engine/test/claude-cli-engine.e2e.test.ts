import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { ClaudeCliEngine } from "../src/claude-cli-engine";
import type { Sentence, Translation, Usage } from "../src/types";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/claude-stream/${name}`, import.meta.url));
}

function scenarioPath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/scenarios/${name}`, import.meta.url));
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

  it("keeps the user glossary out of argv, bootstrapping it over stdin (#26)", async () => {
    const argvFile = join(tmpdir(), `livecap-argv-${process.pid}-${process.hrtime.bigint()}.json`);
    const GLOSSARY = { AcmeCorp: "에이콘", ProjectNarwhal: "프로젝트 나월" };
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: {
        ...process.env,
        LIVECAP_FAKE_FIXTURE: fixturePath("session-without-partials.jsonl"),
        LIVECAP_FAKE_ARGV_OUT: argvFile,
      },
      includePartialMessages: false,
      glossary: GLOSSARY,
    });
    await engine.start(); // spawns fake-cli (writes its argv) + bootstraps glossary over stdin
    try {
      const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
      const joined = argv.join("\0");
      // No glossary term (source or target) is ever on the command line.
      expect(joined).not.toContain("AcmeCorp");
      expect(joined).not.toContain("에이콘");
      expect(joined).not.toContain("ProjectNarwhal");
      expect(joined).not.toContain("프로젝트 나월");
      // The static system prompt is still passed (and carries no user data).
      expect(argv).toContain("--system-prompt");
      const systemPrompt = argv[argv.indexOf("--system-prompt") + 1] ?? "";
      expect(systemPrompt).not.toContain("AcmeCorp");
      expect(systemPrompt).toContain("real-time meeting interpreter");
    } finally {
      await engine.stop();
    }
  });

  it("does not double-count after a zero-cost error turn — cumulative is monotonic (#24)", async () => {
    // Scenario: success ($0.001 cum) → error ($0 cum) → success ($0.002 cum).
    // Pre-fix, the error turn reset the running cumulative to 0, so turn 3's
    // delta was the full 0.002 and the ledger double-charged the first 0.001.
    const engine = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: scenarioPath("cli-cost-regression.jsonl") },
      includePartialMessages: false,
    });
    const usages: Usage[] = [];
    engine.onUsage((u) => usages.push(u));
    await engine.start();
    try {
      await drain(engine); // turn 1: success
      await expect(drain(engine)).rejects.toThrow(); // turn 2: error result
      await drain(engine); // turn 3: success
    } finally {
      await engine.stop();
    }

    expect(usages).toHaveLength(3);
    // Running cumulative never regresses (the error turn holds at 0.001).
    expect(usages.map((u) => u.cumulativeCostUsd)).toEqual([0.001, 0.001, 0.002]);
    // Per-turn delta on turn 3 is the true 0.001, not the inflated 0.002.
    expect(usages[2]?.turnCostUsd).toBeCloseTo(0.001, 6);
    expect(usages[1]?.turnCostUsd).toBe(0);
    // What CreditAccountant accumulates (sum of turn deltas) is the true total.
    const totalCharged = usages.reduce((sum, u) => sum + u.turnCostUsd, 0);
    expect(totalCharged).toBeCloseTo(0.002, 6);
  });

  // #203. Two claims the picker depends on, both measured against a REAL
  // spawned process rather than a mock: the chosen model reaches the command
  // line, and cost accounting does not change when it does.
  it("spawns the chosen model and accounts cost identically to the default (#203)", async () => {
    async function run(model: string | undefined): Promise<{ argv: string[]; usages: Usage[] }> {
      const argvFile = join(tmpdir(), `livecap-argv-203-${model ?? "default"}-${process.pid}.json`);
      const engine = new ClaudeCliEngine({
        bin: FAKE_CLI,
        cwd: tmpdir(),
        env: {
          ...process.env,
          LIVECAP_FAKE_FIXTURE: fixturePath("session-without-partials.jsonl"),
          LIVECAP_FAKE_ARGV_OUT: argvFile,
        },
        includePartialMessages: false,
        ...(model ? { model } : {}),
      });
      const usages: Usage[] = [];
      engine.onUsage((u) => usages.push(u));
      await engine.start();
      try {
        await drain(engine);
      } finally {
        await engine.stop();
      }
      return { argv: JSON.parse(readFileSync(argvFile, "utf8")) as string[], usages };
    }

    const fallback = await run(undefined);
    const chosen = await run("opus");

    // The argv the fake CLI was ACTUALLY spawned with — not the return value of
    // buildClaudeArgs, and not a stub. Omitting the config field still pins Haiku.
    expect(fallback.argv[fallback.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(chosen.argv[chosen.argv.indexOf("--model") + 1]).toBe("opus");
    // Exactly one --model reaches the CLI (a second occurrence would make which
    // one wins a CLI implementation detail).
    expect(chosen.argv.filter((a) => a === "--model")).toHaveLength(1);
    // Changing the model changes ONLY the model: the isolation recipe is intact.
    // The session id is masked too — each engine mints its own UUID by design,
    // so it legitimately differs between the two runs.
    const shape = (argv: string[]): string[] =>
      argv.map((arg, i) =>
        argv[i - 1] === "--model" || argv[i - 1] === "--session-id" ? `<${argv[i - 1]}>` : arg,
      );
    expect(shape(chosen.argv)).toEqual(shape(fallback.argv));

    // Cost accounting is model-independent: the adapter reports whatever the CLI
    // put in `total_cost_usd` and derives the per-turn delta from it, with no
    // per-model rate table anywhere in the path (#203 forbids adding one). Same
    // reported stream ⇒ byte-identical Usage on a non-default model.
    //
    // Boundary, stated rather than implied: this proves OUR accounting does not
    // branch on the model. It cannot prove what Anthropic's real CLI reports for
    // Opus — that needs credentials this suite deliberately does not have.
    expect(chosen.usages).toEqual(fallback.usages);
    expect(chosen.usages[0]?.turnCostUsd).toBeGreaterThan(0);
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
