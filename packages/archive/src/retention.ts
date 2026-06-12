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

/**
 * Delete archives last modified more than `maxAgeDays` ago. Returns the names
 * of deleted files. A no-op (returns []) when retention is disabled or the
 * folder does not exist.
 */
export function sweepOldArchives(options: RetentionOptions): string[] {
  const { fs, folder, maxAgeDays, nowMs } = options;
  if (!maxAgeDays || maxAgeDays <= 0) return [];

  let names: string[];
  try {
    names = fs.readdir(folder);
  } catch {
    // Folder doesn't exist yet (first run) — nothing to sweep.
    return [];
  }

  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const path = fs.join(folder, name);
    if (fs.mtimeMs(path) < cutoff) {
      fs.unlink(path);
      removed.push(name);
    }
  }
  return removed;
}
