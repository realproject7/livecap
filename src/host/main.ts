// Session host entry point. Spawned by the Rust shell (one process per
// meeting) with the JSONL protocol on stdio: messages in on stdin, events out
// on stdout. Caption content flows ONLY through the protocol stream — nothing
// is ever written to stderr or any log (#23 / SECURITY.md).

import { createInterface } from "node:readline";

import type { HostInbound, HostOutbound } from "../protocol.ts";
import { HostSession } from "./session.ts";

function emit(event: HostOutbound): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const session = new HostSession(emit);
let exiting = false;

function fail(detail: string): void {
  emit({ type: "hostError", detail });
}

process.on("uncaughtException", (error) => {
  fail(`uncaught ${error.name}: ${error.message}`);
});
process.on("unhandledRejection", (reason) => {
  fail(reason instanceof Error ? `unhandled ${reason.name}: ${reason.message}` : "unhandled rejection");
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Serialize message handling: start must complete before captions are
// processed, and stop must run after everything queued ahead of it.
let chain: Promise<void> = Promise.resolve();

lines.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message: HostInbound;
  try {
    message = JSON.parse(trimmed) as HostInbound;
  } catch {
    fail("unparseable host message");
    return;
  }
  chain = chain
    .then(() => session.handle(message))
    .then(() => {
      if (message.type === "stop" && !exiting) {
        exiting = true;
        // Give stdout a tick to flush the trailing "stopped" event.
        setTimeout(() => process.exit(0), 50);
      }
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? `${error.name}: ${error.message}` : "host failure");
    });
});

lines.on("close", () => {
  // Rust hung up (app quit / crash): finalize what we can, then exit.
  if (exiting) return;
  exiting = true;
  chain = chain
    .then(() => session.handle({ type: "stop" }))
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
