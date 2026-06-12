// Optional retention sweep (PROPOSAL §8.9: "delete files older than 90 days"
// for the privacy-cautious). Default OFF — the caller passes a positive
// maxAgeDays to enable it, typically on app start.

import type { ArchiveFs } from "./fs";

export interface RetentionOptions {
  fs: ArchiveFs;
  folder: string;
  /** Delete `.md` archives older than this many days. <= 0 / undefined = off. */
  maxAgeDays?: number;
  /** Current time in epoch milliseconds (injected for testability). */
  nowMs: number;
}

export interface RetentionResult {
  /** Names of files deleted by this sweep. */
  removed: string[];
  /**
   * Names that hit a NON-ENOENT stat/unlink error (permission, I/O, …). They
   * are surfaced here — NOT silently treated as swept (#48) — so the caller can
   * report that retention couldn't delete them. A vanished-mid-sweep file
   * (ENOENT) is tolerated silently and appears in neither list.
   */
  failed: string[];
}

/** Whether an error is a "file is missing" race (tolerated silently). */
function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "ENOENT") return true;
  return error instanceof Error && /ENOENT|no such file/i.test(error.message);
}

/**
 * Delete archives last modified more than `maxAgeDays` ago. NEVER throws on a
 * per-entry error so it is safe on the app-start path: a vanished file (ENOENT)
 * is skipped silently, any other per-entry failure is reported in `failed`.
 * A no-op (empty result) when retention is disabled or the folder is absent.
 */
export function sweepOldArchives(options: RetentionOptions): RetentionResult {
  const { fs, folder, maxAgeDays, nowMs } = options;
  const empty: RetentionResult = { removed: [], failed: [] };
  if (!maxAgeDays || maxAgeDays <= 0) return empty;

  let names: string[];
  try {
    names = fs.readdir(folder);
  } catch {
    // Folder doesn't exist yet (first run) — nothing to sweep.
    return empty;
  }

  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    // Sweep finished archives and also stale `.md.tmp` orphans — a crash
    // between the temp write and rename leaves one behind, and it would
    // otherwise accumulate one per crash in the user's folder.
    if (!name.endsWith(".md") && !name.endsWith(".md.tmp")) continue;
    const path = fs.join(folder, name);
    try {
      if (fs.mtimeMs(path) < cutoff) {
        fs.unlink(path);
        removed.push(name);
      }
    } catch (error) {
      // A file that vanished between readdir and stat/unlink is already "swept"
      // — tolerate it silently. Any OTHER error (permission, I/O) must be
      // surfaced, not masked as success (#48). Either way, never crash the
      // sweep: continue with the remaining files.
      if (!isMissingFile(error)) failed.push(name);
    }
  }
  return { removed, failed };
}
