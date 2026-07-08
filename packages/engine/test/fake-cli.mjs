#!/usr/bin/env node
// fake-cli — a test-only stand-in for the `claude` binary. It is NOT a mock of
// the parser: it replays a REAL recorded stream-json fixture back through real
// process stdio, so the adapter's spawn → stdin-write → stdout-parse path is
// exercised end-to-end, headless, with no network or real CLI.
//
// Contract (matches what ClaudeCliEngine does):
//   - fixture path comes from env LIVECAP_FAKE_FIXTURE
//   - each line written to stdin = one user turn
//   - per turn, replay the next recorded block (up to and including its
//     `result` event) to stdout
//
// When turns are exhausted it stays quiet (the engine will have what it needs).
//
// Failure-injection modes exercise the #135 watchdog/respawn path:
//   - LIVECAP_FAKE_HANG_ALWAYS=1     — every process hangs every turn (no event,
//                                      no exit), so each turn trips the watchdog.
//   - LIVECAP_FAKE_HANG_ONCE=<file>  — ONLY the first process hangs; a respawn
//                                      (second process) serves normally.
//   - LIVECAP_FAKE_CRASH_ONCE=<file> — ONLY the first process exits(1) mid-turn;
//                                      a respawn serves normally.
// The "_ONCE" marker file is created atomically by the first process, so a
// respawn sees it present and behaves normally — modeling crash→respawn recovery.

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

// Record the exact argv the adapter spawned us with, so a test can assert what
// did (and did not) reach the command line — e.g. no glossary content (#26).
const argvOut = process.env.LIVECAP_FAKE_ARGV_OUT;
if (argvOut) writeFileSync(argvOut, JSON.stringify(process.argv));

// Optional stderr noise, to exercise the adapter's stderr-drain path. A large
// value (or repeated writes) would otherwise fill the kernel pipe buffer.
const stderrNoise = process.env.LIVECAP_FAKE_STDERR;
if (stderrNoise) process.stderr.write(stderrNoise + "\n");

// Atomically claim "first process" via a marker file: exactly one process across
// a spawn→respawn sequence gets `true` (the create-if-absent write succeeds).
function claimFirst(markerPath) {
  try {
    writeFileSync(markerPath, "1", { flag: "wx" });
    return true;
  } catch {
    return false; // a prior process already created the marker
  }
}
const hangAlways = process.env.LIVECAP_FAKE_HANG_ALWAYS === "1";
const isFirstHang = process.env.LIVECAP_FAKE_HANG_ONCE ? claimFirst(process.env.LIVECAP_FAKE_HANG_ONCE) : false;
const isFirstCrash = process.env.LIVECAP_FAKE_CRASH_ONCE ? claimFirst(process.env.LIVECAP_FAKE_CRASH_ONCE) : false;

// Base "serve one turn" behavior (echo or fixture replay), used when this
// process is NOT injecting a failure for the current turn.
const echoMode = process.env.LIVECAP_FAKE_ECHO === "1";
let serveTurn;
if (echoMode) {
  serveTurn = (line) => {
    let text = "";
    try {
      text = JSON.parse(line).message.content[0].text;
    } catch {
      text = "";
    }
    const assistant = {
      type: "assistant",
      message: { id: "echo", role: "assistant", content: [{ type: "text", text }] },
    };
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      stop_reason: "end_turn",
      result: text,
      // cache_read_input_tokens is fixed 0 unless LIVECAP_FAKE_CACHE_READ is set,
      // which lets a test drive the #136 session-rollover threshold.
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: Number(process.env.LIVECAP_FAKE_CACHE_READ ?? 0),
      },
    };
    process.stdout.write(JSON.stringify(assistant) + "\n");
    process.stdout.write(JSON.stringify(result) + "\n");
  };
} else {
  const fixturePath = process.env.LIVECAP_FAKE_FIXTURE;
  if (!fixturePath) {
    process.stderr.write("fake-cli: LIVECAP_FAKE_FIXTURE not set\n");
    process.exit(1);
  }
  // Split the recording into per-turn blocks: every line up to and including the
  // next `result` event belongs to one turn.
  const lines = readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const blocks = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    let type;
    try {
      type = JSON.parse(line).type;
    } catch {
      type = undefined;
    }
    if (type === "result") {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);

  let turn = 0;
  serveTurn = () => {
    const block = blocks[turn];
    turn += 1;
    if (!block) return;
    for (const line of block) process.stdout.write(line + "\n");
  };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (hangAlways || isFirstHang) return; // no event, no exit → trips the watchdog
  if (isFirstCrash) process.exit(1); // die mid-turn, before any result
  serveTurn(line);
});
