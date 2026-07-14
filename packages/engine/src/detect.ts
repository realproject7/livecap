// CLI detection and capability probing (PROPOSAL §5.1). Filesystem and process
// access are injected so this stays pure and Linux-headless testable — the
// package never resolves a binary path on its own (consumer injects it).

/** Default binary names to look for. Only the Claude CLI is supported —
 *  probeCapabilities/buildClaudeArgs emit Claude-CLI-specific argv, so handing a
 *  different vendor's binary to ClaudeCliEngine would fail unpredictably. */
export const DEFAULT_CLI_NAMES: readonly string[] = ["claude"];

export interface FindCliOptions {
  /** The PATH string to scan (e.g. process.env.PATH). */
  path: string;
  /** Predicate: is this absolute path an executable file? */
  isExecutable: (candidate: string) => boolean;
  /** Binary names to look for; defaults to just "claude". */
  names?: readonly string[];
  /** Path entry separator; defaults to ":" (POSIX). */
  pathSeparator?: string;
  /** Path segment joiner; defaults to "/". */
  segmentSeparator?: string;
}

/**
 * Scan a PATH string for the given CLI names. Returns every match as an
 * absolute path, in (name, PATH-entry) preference order, de-duplicated.
 */
export function findCliBins(options: FindCliOptions): string[] {
  const names = options.names ?? DEFAULT_CLI_NAMES;
  const pathSep = options.pathSeparator ?? ":";
  const segSep = options.segmentSeparator ?? "/";
  const dirs = options.path.split(pathSep).filter((d) => d !== "");

  const found: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = dir.endsWith(segSep) ? dir + name : dir + segSep + name;
      if (seen.has(candidate)) continue;
      if (options.isExecutable(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
  }
  return found;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a command to completion and returns its captured output. */
export type CommandRunner = (bin: string, args: string[]) => Promise<CommandResult>;

export interface Capabilities {
  /** Raw `--version` output, trimmed. */
  version: string;
  /** Whether `-p --help` advertised `--include-partial-messages`. */
  includePartialMessages: boolean;
}

/**
 * Probe a CLI for version and the flags we gate on (PROPOSAL §5.1). The runner
 * is injected so this is testable against canned `--help` output without
 * spawning anything.
 */
export async function probeCapabilities(bin: string, run: CommandRunner): Promise<Capabilities> {
  const [version, help] = await Promise.all([run(bin, ["--version"]), run(bin, ["-p", "--help"])]);
  const helpText = `${help.stdout}\n${help.stderr}`;
  return {
    version: version.stdout.trim(),
    includePartialMessages: helpText.includes("--include-partial-messages"),
  };
}
