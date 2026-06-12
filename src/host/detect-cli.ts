// Claude CLI detection for THIS machine (PROPOSAL §5.1). The engine package
// owns the scanning/probing logic; this glue supplies the real PATH (plus the
// usual install dirs a Finder-launched app's environment misses), filesystem
// access, and a process runner.

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { findCliBins, probeCapabilities } from "@livecap/engine";
import type { CommandResult } from "@livecap/engine";

export interface DetectedCli {
  bin: string;
  version: string;
  includePartialMessages: boolean;
}

/** PATH plus common install locations (GUI apps inherit a minimal PATH). */
export function augmentedPath(envPath: string | undefined): string {
  const home = homedir();
  const extras = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  const parts = (envPath ?? "").split(delimiter).filter((dir) => dir !== "");
  for (const extra of extras) if (!parts.includes(extra)) parts.push(extra);
  return parts.join(delimiter);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

/** Find a usable `claude` binary, or null when the local tier should lead. */
export async function detectClaudeCli(envPath: string | undefined): Promise<DetectedCli | null> {
  const bins = findCliBins({
    path: augmentedPath(envPath),
    isExecutable: isExecutableFile,
    names: ["claude"],
  });
  for (const bin of bins) {
    try {
      const caps = await probeCapabilities(bin, runCommand);
      if (caps.version !== "") {
        return { bin, version: caps.version, includePartialMessages: caps.includePartialMessages };
      }
    } catch {
      // Probe failure: try the next PATH match.
    }
  }
  return null;
}
