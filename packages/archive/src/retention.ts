// Optional retention sweep (PROPOSAL §8.9: "delete files older than 90 days"
// for the privacy-cautious). Default OFF — the caller passes a positive
// maxAgeDays to enable it, typically on app start.

import type { ArchiveFs } from "./fs";
import { WORKING_TITLE } from "./writer";

/** ` — (recording)` — the in-progress marker in a working file's name. */
const RECORDING_MARKER = ` — ${WORKING_TITLE}`;

/**
 * Whether `name` is an in-progress / unfinalized recording — `<prefix> —
 * (recording).md` (or a ` (N)` collision variant). Its transcript is live
 * session data the crash-safety guarantee must preserve ("a crash loses
 * nothing", writer.ts), so the retention sweep must NEVER reap it by age (#63).
 *
 * NOTE: a `(recording).md.tmp` orphan is deliberately NOT matched — that is a
 * crash-mid-rewrite temp whose `.md` sibling holds the real data, so it stays
 * reapable like any other `.md.tmp` orphan.
 */
export function isInProgressRecording(name: string): boolean {
  if (!name.endsWith(".md")) return false;
  const stem = name.slice(0, -".md".length).replace(/ \(\d+\)$/, "");
  return stem.endsWith(RECORDING_MARKER);
}

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
  // A structured errno is authoritative — trust ONLY `code === "ENOENT"`, never
  // the message. Otherwise an EACCES/EPERM on a file whose user-derived name
  // contains "ENOENT"/"no such file" would be misclassified as missing and
  // dropped from `failed`, reintroducing the invisible-failure case (#48).
  if (typeof code === "string") return code === "ENOENT";
  // No structured code (e.g. a bare Error) — fall back to the message.
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
    // NEVER reap an unfinalized recording (#63): `<prefix> — (recording).md`
    // is the live (or a crashed session's) transcript — exactly the data the
    // crash-safety guarantee preserves. The active session's file isn't present
    // during this start-time sweep, but a prior crashed session's is, and any
    // future call order must not be able to delete in-progress data.
    if (isInProgressRecording(name)) continue;
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
