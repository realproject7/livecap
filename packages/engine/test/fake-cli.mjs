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

// Echo mode: instead of replaying a fixture, parse each stdin user message and
// emit a stream-json turn that echoes its text back. Lets a test assert what the
// adapter actually sent (e.g. the [TASK] marker on complete()/summarize()).
const echoMode = process.env.LIVECAP_FAKE_ECHO === "1";
if (echoMode) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
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
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    };
    process.stdout.write(JSON.stringify(assistant) + "\n");
    process.stdout.write(JSON.stringify(result) + "\n");
  });
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
const rl = createInterface({ input: process.stdin });
rl.on("line", () => {
  const block = blocks[turn];
  turn += 1;
  if (!block) return;
  for (const line of block) process.stdout.write(line + "\n");
});

}
