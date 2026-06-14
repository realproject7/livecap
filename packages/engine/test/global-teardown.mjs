// Global teardown backstop for the engine test suites (#54-era leak follow-up).
//
// The e2e suites spawn a real `fake-llama-server.mjs` per engine through the
// real spawn path. Per-suite afterEach disposes every engine it tracks, but a
// rare missed-kill on a double-start/restart path can leave a child whose engine
// handle was already cleared (this.child === null) — unreachable by dispose().
//
// This runs ONCE in vitest's main process after ALL test files finish (not in a
// worker, so there is no worker-IPC risk like a synchronous reap inside
// afterEach would cause). By then no engine suite is still running, so killing
// any surviving fake-llama-server child is safe and scoped to our own test
// binary by name.
import { execFileSync } from "node:child_process";

export function teardown() {
  let pids = "";
  try {
    pids = execFileSync("pgrep", ["-f", "fake-llama-server.mjs"], { encoding: "utf8" }).trim();
  } catch {
    return; // pgrep exits non-zero when there is nothing to match — clean.
  }
  for (const pid of pids.split("\n").filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
