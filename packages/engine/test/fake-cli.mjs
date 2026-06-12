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

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

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
