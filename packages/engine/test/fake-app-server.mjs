#!/usr/bin/env node
// fake-app-server — a test-only stand-in for `codex app-server`. It is NOT a
// mock of the adapter: it speaks the REAL JSON-RPC-over-stdio protocol shape
// measured from codex-cli 0.146.0, through real process stdio, so the adapter's
// spawn → handshake → turn → notification path is exercised end-to-end,
// headless, with no network and no codex binary.
//
// Protocol replayed (measured, not invented):
//   initialize                  -> { userAgent, codexHome, platformFamily, platformOs }
//   thread/start                -> { threadId }
//   thread/resume               -> { threadId }
//   turn/start                  -> {} then notifications:
//        item/agentMessage/delta   (one per word of the reply)
//        thread/tokenUsage/updated { tokenUsage: { last, total, modelContextWindow } }
//        turn/completed
//
// Env knobs:
//   LIVECAP_FAKE_CODEX_ARGV_OUT   — write spawn argv here (assert --disable set)
//   LIVECAP_FAKE_CODEX_REPLY      — reply text (default a Korean sentence)
//   LIVECAP_FAKE_CODEX_INPUT      — inputTokens to report per turn
//   LIVECAP_FAKE_CODEX_WINDOW     — modelContextWindow to report
//   LIVECAP_FAKE_CODEX_FAIL_TURN  — emit turn/failed instead of turn/completed
//   LIVECAP_FAKE_CODEX_EXIT_ONCE  — <file>: first process exits(1) on first turn

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

const argvOut = process.env.LIVECAP_FAKE_CODEX_ARGV_OUT;
if (argvOut) writeFileSync(argvOut, JSON.stringify(process.argv));

const REPLY = process.env.LIVECAP_FAKE_CODEX_REPLY ?? "우리는 이중 책무에 전념하고 있습니다.";
const INPUT_TOKENS = Number(process.env.LIVECAP_FAKE_CODEX_INPUT ?? 5168);
const WINDOW = Number(process.env.LIVECAP_FAKE_CODEX_WINDOW ?? 258400);
const FAIL_TURN = process.env.LIVECAP_FAKE_CODEX_FAIL_TURN === "1";

function claimFirst(markerPath) {
  try {
    writeFileSync(markerPath, "1", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
const exitOnce = process.env.LIVECAP_FAKE_CODEX_EXIT_ONCE;
const isFirstExit = exitOnce ? claimFirst(exitOnce) : false;

let threadSeq = 0;
let currentThread = null;

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      reply(id, {
        // Shape measured from the real binary, including the version this
        // adapter's overhead figures were taken on.
        userAgent: "livecap/0.146.0 (Ubuntu 26.4.0; x86_64) xterm-256color (livecap; 0.1.0)",
        codexHome: "/home/fake/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;

    case "thread/start":
      threadSeq += 1;
      currentThread = `thr_fake_${threadSeq}`;
      reply(id, { threadId: currentThread });
      return;

    case "thread/resume":
      currentThread = params?.threadId ?? currentThread;
      reply(id, { threadId: currentThread });
      return;

    case "turn/start": {
      if (isFirstExit) {
        // Model a mid-session crash: die without completing the turn.
        process.exit(1);
      }
      reply(id, {});
      // Stream the reply word by word, the way item/agentMessage/delta arrives.
      const words = REPLY.split(" ");
      for (const [i, word] of words.entries()) {
        notify("item/agentMessage/delta", { delta: i === 0 ? word : ` ${word}` });
      }
      notify("thread/tokenUsage/updated", {
        threadId: currentThread,
        turnId: `turn_${threadSeq}`,
        tokenUsage: {
          last: {
            inputTokens: INPUT_TOKENS,
            cachedInputTokens: Math.floor(INPUT_TOKENS * 0.66),
            outputTokens: 16,
            reasoningOutputTokens: 0,
            totalTokens: INPUT_TOKENS + 16,
          },
          total: { inputTokens: INPUT_TOKENS, outputTokens: 16 },
          modelContextWindow: WINDOW,
        },
      });
      notify(FAIL_TURN ? "turn/failed" : "turn/completed", { threadId: currentThread });
      return;
    }

    case "account/rateLimits/read":
      if (process.env.LIVECAP_FAKE_CODEX_NO_LIMITS === "1") {
        write({ jsonrpc: "2.0", id, error: { code: -32000, message: "unavailable" } });
        return;
      }
      // Shape measured from the real binary, including the identifying fields
      // the adapter must drop at the boundary.
      reply(id, {
        rateLimits: {
          limitId: "codex",
          planType: "prolite",
          primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1786449404 },
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
      });
      return;

    default:
      if (id !== undefined) reply(id, {});
  }
});
