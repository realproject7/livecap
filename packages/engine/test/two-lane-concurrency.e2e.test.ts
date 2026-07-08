// #142 dedicated translation lane: the head-of-line block is removed by running
// live translation and summary/extras on TWO independent ClaudeCliEngine
// sessions. Each engine has its OWN per-turn mutex, so a slow/awaited summary
// turn on the extras lane cannot stall a live translation turn on the other.
//
// This exercises the real spawn/stdio path (fake-cli replay) — the property the
// session's two-lane split relies on. With ONE shared engine (today) the summary
// turn would hold the single turnMutex and block the caption behind it.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { ClaudeCliEngine } from "../src/claude-cli-engine";
import type { Sentence, Translation } from "../src/types";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/claude-stream/${name}`, import.meta.url));
}

const batch: Sentence[] = [{ id: "s1", text: "We are committed to the dual mandate.", seq: 1 }];

async function drain(engine: ClaudeCliEngine): Promise<Translation[]> {
  const out: Translation[] = [];
  for await (const t of engine.translate(batch, { pairs: [] })) out.push(t);
  return out;
}

describe("two-lane concurrency (#142)", () => {
  it("a hung summary turn on the extras lane does not block live translation on the other lane", async () => {
    // Extras lane: every turn hangs (models a long/awaited summary turn) — the
    // fake-cli serves nothing and does not exit. The fixture is still required so
    // the process starts normally (no-fixture makes it exit at spawn); HANG_ALWAYS
    // then holds the turn open. A short watchdog bounds the turn if cleanup slips.
    const extras = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: {
        ...process.env,
        LIVECAP_FAKE_FIXTURE: fixturePath("session-without-partials.jsonl"),
        LIVECAP_FAKE_HANG_ALWAYS: "1",
      },
      includePartialMessages: false,
      turnTimeoutMs: 10_000,
    });
    // Translation lane: a normal, independent session.
    const translation = new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: fixturePath("session-without-partials.jsonl") },
      includePartialMessages: false,
    });

    await Promise.all([extras.start(), translation.start()]);
    try {
      // Kick off the summary turn but do NOT await it — it hangs on its own lane.
      let summaryDone = false;
      const summaryTurn = extras
        .complete({ user: "summarize the meeting so far" })
        .then(() => (summaryDone = true))
        .catch(() => (summaryDone = true));

      // The live caption translates to completion while the summary is still hung.
      const snapshots = await drain(translation);
      expect(snapshots.at(-1)?.done).toBe(true);
      expect(snapshots.at(-1)?.text.length).toBeGreaterThan(0);
      // Proof the lanes don't contend: translation finished with the summary turn
      // still blocked (a shared turn mutex would have serialized them).
      expect(summaryDone).toBe(false);

      await extras.stop(); // ends the hung turn so summaryTurn settles
      await summaryTurn;
    } finally {
      await Promise.all([extras.stop(), translation.stop()]);
    }
  });
});
