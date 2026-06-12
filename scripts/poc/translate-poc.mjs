#!/usr/bin/env node
// Phase 0 PoC (issue #3): measure real cost & latency of translating a meeting
// through a persistent `claude -p` stream-json session, the way the LiveCap CLI
// engine (issue #5) will. Also records the raw stream-json output as fixtures.
//
// Usage:
//   node scripts/poc/translate-poc.mjs [--sentences N] [--batch 2] [--restart-every 20]
//
// Requires a logged-in `claude` CLI on PATH. No API key is read or passed —
// ANTHROPIC_* credentials are stripped from the child env so subscription auth
// is what gets measured (see EPIC #1).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const SENTENCES = Number(args.sentences ?? Infinity);
const BATCH = Number(args.batch ?? 2);
const RESTART_EVERY = Number(args["restart-every"] ?? 20); // turns per session: caps history growth
const CONTEXT_PAIRS = 4;

const SYSTEM_PROMPT = [
  "You are a real-time meeting interpreter. Translate the English sentences you receive into Korean.",
  "Output ONLY the Korean translation, nothing else — no notes, no romanization, no quotes.",
  "Keep names, numbers, and financial terms accurate. Prefer natural spoken Korean over literal wording.",
  "If a fragment is untranslatable noise, output an empty line for it.",
].join(" ");

const FIXTURE_DIR = join(here, "../../packages/engine/test/fixtures/claude-stream");
mkdirSync(FIXTURE_DIR, { recursive: true });

function spawnSession({ partialMessages, fixtureName }) {
  // Isolation: translation needs no tools, no MCP, no hooks, no thinking.
  // (--bare would be ideal but disables subscription OAuth, so we strip each
  // context source individually — this is the exact recipe #5 must replicate.)
  const cliArgs = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--session-id", randomUUID(),
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", '{"disableAllHooks":true,"alwaysThinkingEnabled":false}',
    "--system-prompt", SYSTEM_PROMPT,
  ];
  if (partialMessages) cliArgs.splice(5, 0, "--include-partial-messages");

  // Strip Anthropic credentials so the CLI's own login (subscription) wins.
  const env = { ...process.env, MAX_THINKING_TOKENS: "0" };
  if (!env.ANTHROPIC_BASE_URL) {
    for (const k of Object.keys(env)) {
      if (/^anthropic_(api_key|auth_token)$/i.test(k)) delete env[k];
    }
  }

  // Empty cwd so no project CLAUDE.md / .mcp.json / hooks leak into context.
  mkdirSync("/tmp/livecap-poc-cwd", { recursive: true });
  const child = spawn("claude", cliArgs, { env, cwd: "/tmp/livecap-poc-cwd", stdio: ["pipe", "pipe", "pipe"] });
  const recorder = fixtureName ? createWriteStream(join(FIXTURE_DIR, fixtureName), { flags: "w" }) : null;
  const rl = createInterface({ input: child.stdout });
  const waiters = [];
  rl.on("line", (line) => {
    recorder?.write(line + "\n");
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    for (const w of waiters) w(obj);
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  return {
    child,
    send(text) {
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    },
    onEvent(fn) { waiters.push(fn); },
    async close() { child.stdin.end(); recorder?.end(); await new Promise((r) => child.on("close", r)); },
  };
}

const sentences = readFileSync(join(here, "fixtures/fomc-20260429.txt"), "utf8")
  .split("\n").filter(Boolean).slice(0, SENTENCES);
const batches = [];
for (let i = 0; i < sentences.length; i += BATCH) batches.push(sentences.slice(i, i + BATCH));

console.log(`PoC: ${sentences.length} sentences → ${batches.length} batches (batch=${BATCH}, restart every ${RESTART_EVERY} turns)`);

const stats = { costUsd: 0, turns: 0, latencies: [], ttfts: [], inTok: 0, outTok: 0, cacheRead: 0 };
const recentPairs = [];
let session = null;
let turnInSession = 0;
let sessionCount = 0;

const t0 = Date.now();
for (const [bi, batch] of batches.entries()) {
  if (!session || turnInSession >= RESTART_EVERY) {
    if (session) {
      await session.close();
      stats.costUsd += stats.sessionCostUsd ?? 0;
      stats.sessionCostUsd = 0;
    }
    // Record the 1st session (with partials) and 2nd (without) as #5 fixtures.
    const fixtureName = sessionCount === 0 ? "session-with-partials.jsonl"
      : sessionCount === 1 ? "session-without-partials.jsonl" : null;
    session = spawnSession({ partialMessages: sessionCount !== 1, fixtureName });
    sessionCount += 1;
    turnInSession = 0;
  }

  const ctx = recentPairs.slice(-CONTEXT_PAIRS).map(([en, ko]) => `EN: ${en}\nKO: ${ko}`).join("\n");
  const msg = (ctx ? `Recent context (do not retranslate):\n${ctx}\n\n` : "") +
    `Translate, one line per sentence:\n${batch.join("\n")}`;

  const sent = Date.now();
  let ttft = null;
  const done = new Promise((resolve) => {
    session.onEvent((obj) => {
      if (ttft === null && obj.type === "stream_event") ttft = Date.now() - sent;
      if (obj.type === "result") resolve(obj);
    });
  });
  session.send(msg);
  const result = await done;
  const latency = Date.now() - sent;

  const text = (result.result ?? "").trim();
  const lines = text.split("\n").filter(Boolean);
  batch.forEach((en, i) => recentPairs.push([en, lines[i] ?? ""]));

  stats.turns += 1;
  // total_cost_usd is CUMULATIVE within a session (verified against recorded
  // streams) — track the latest value per session and roll it up on restart.
  stats.sessionCostUsd = result.total_cost_usd ?? stats.sessionCostUsd ?? 0;
  stats.latencies.push(latency);
  if (ttft !== null) stats.ttfts.push(ttft);
  const u = result.usage ?? {};
  stats.inTok += u.input_tokens ?? 0;
  stats.outTok += u.output_tokens ?? 0;
  stats.cacheRead += u.cache_read_input_tokens ?? 0;
  turnInSession += 1;

  if (bi % 20 === 0) {
    console.log(`[${bi}/${batches.length}] cost=$${stats.costUsd.toFixed(4)} last=${latency}ms "${(lines[0] ?? "").slice(0, 40)}"`);
  }
}
await session.close();
stats.costUsd += stats.sessionCostUsd ?? 0;

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * p)] ?? 0;
const wallMin = (Date.now() - t0) / 60000;
const speechMin = (sentences.reduce((n, s) => n + s.split(" ").length, 0) / 150); // ~150 wpm
const report = {
  sentences: sentences.length,
  turns: stats.turns,
  totalCostUsd: +stats.costUsd.toFixed(4),
  estCostPerMeetingHourUsd: +((stats.costUsd / speechMin) * 60).toFixed(4),
  latencyMsP50: pct(stats.latencies, 0.5),
  latencyMsP95: pct(stats.latencies, 0.95),
  ttftMsP50: pct(stats.ttfts, 0.5),
  inputTokens: stats.inTok,
  outputTokens: stats.outTok,
  cacheReadTokens: stats.cacheRead,
  wallClockMin: +wallMin.toFixed(1),
  speechMinutesRepresented: +speechMin.toFixed(1),
};
console.log("\nRESULT " + JSON.stringify(report, null, 2));
