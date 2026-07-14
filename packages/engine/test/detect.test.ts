import { describe, it, expect } from "vitest";

import { findCliBins, probeCapabilities } from "../src/detect";
import type { CommandResult } from "../src/detect";

describe("findCliBins", () => {
  it("returns matches in (name, PATH-entry) preference order", () => {
    const present = new Set(["/opt/bin/claude", "/usr/local/bin/codex", "/usr/local/bin/claude"]);
    // Pass names explicitly: the default is claude-only (the engine can only
    // drive the Claude CLI), so a second name is supplied here purely to exercise
    // the name-then-PATH ordering.
    const found = findCliBins({
      path: "/opt/bin:/usr/local/bin",
      isExecutable: (c) => present.has(c),
      names: ["claude", "codex"],
    });
    // claude before codex; within claude, /opt/bin before /usr/local/bin.
    expect(found).toEqual(["/opt/bin/claude", "/usr/local/bin/claude", "/usr/local/bin/codex"]);
  });

  it("returns nothing when no candidate is executable", () => {
    expect(findCliBins({ path: "/a:/b", isExecutable: () => false })).toEqual([]);
  });

  it("ignores empty PATH entries", () => {
    const found = findCliBins({
      path: "::/bin",
      isExecutable: (c) => c === "/bin/claude",
    });
    expect(found).toEqual(["/bin/claude"]);
  });
});

describe("probeCapabilities", () => {
  function runner(helpText: string): (bin: string, args: string[]) => Promise<CommandResult> {
    return async (_bin, args) => {
      if (args[0] === "--version") return { stdout: "claude 2.1.169", stderr: "", code: 0 };
      return { stdout: helpText, stderr: "", code: 0 };
    };
  }

  it("gates --include-partial-messages on the help output advertising it", async () => {
    const caps = await probeCapabilities(
      "claude",
      runner("Usage: claude -p\n  --include-partial-messages  stream deltas\n"),
    );
    expect(caps.version).toBe("claude 2.1.169");
    expect(caps.includePartialMessages).toBe(true);
  });

  it("reports the flag unsupported when the older CLI does not list it", async () => {
    const caps = await probeCapabilities("claude", runner("Usage: claude -p\n  --verbose\n"));
    expect(caps.includePartialMessages).toBe(false);
  });
});
