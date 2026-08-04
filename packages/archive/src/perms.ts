// Upgrade remediation (#192): re-permission archive entries that pre-#148
// builds wrote at the default 0644.
//
// #148 hardened the WRITE path (fs.ts: FILE_MODE/DIR_MODE), but only new files
// get those modes — every transcript written before that release stayed
// world-readable on the device forever, so on a shared or managed Mac any other
// local account could read old meetings. Nothing ever went back to fix them.
//
// Permissions only: contents, names and mtimes are never touched (chmod does not
// change mtime), and nothing is ever deleted — the archive is user-owned data.

import type { ArchiveFs } from "./fs";
import { DIR_MODE, FILE_MODE } from "./fs";
import { isMissingFile } from "./retention";

export interface TightenPermissionsOptions {
  fs: ArchiveFs;
  folder: string;
}

/**
 * Counts only — deliberately no names. Archive file names are built from meeting
 * titles, so a name IS user content (#192 security invariant) and must never
 * reach a log line. The caller can report "n files tightened" and nothing else.
 */
export interface TightenPermissionsResult {
  /** How many entries were tightened to the owner-only mode. */
  tightened: number;
  /** How many could not be read or chmod'ed (permission/I/O, not a race). */
  failed: number;
}

/** Group or other bits set — i.e. readable by someone who is not the owner. */
function isTooPermissive(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * Tighten anything in `folder` that a pre-#148 build left group/other-readable.
 *
 * Idempotent and silent when there is nothing to fix: a mode is read first and
 * chmod is issued ONLY when group/other bits are actually set, so a folder that
 * is already correct performs no writes at all. Never throws — it runs on the
 * session-start path, where a permission quirk on one file must not take the
 * session down; per-entry failures are counted instead.
 *
 * Only the archive's own entries are considered (`.md` transcripts and the
 * `.md.tmp` orphans a crash mid-rewrite leaves, which hold the same content).
 * Unfinalized `(recording).md` files are INCLUDED — unlike the retention sweep,
 * which spares them because deleting is destructive; tightening is not, and a
 * crashed session's transcript is exactly the kind of file that must not stay
 * world-readable.
 */
export function tightenArchivePermissions(
  options: TightenPermissionsOptions,
): TightenPermissionsResult {
  const { fs, folder } = options;
  let tightened = 0;
  let failed = 0;

  let names: string[];
  try {
    names = fs.readdir(folder);
  } catch {
    // No archive folder yet (fresh install, or a folder the user moved away) —
    // nothing to remediate.
    return { tightened, failed };
  }

  // The directory itself, too: a pre-#148 folder is 0755, which lets any local
  // account LIST the file names — and a name is a meeting title, i.e. user
  // content by this ticket's own invariant.
  try {
    if (isTooPermissive(fs.mode(folder))) {
      fs.chmod(folder, DIR_MODE);
      tightened += 1;
    }
  } catch (error) {
    if (!isMissingFile(error)) failed += 1;
  }

  for (const name of names) {
    if (!name.endsWith(".md") && !name.endsWith(".md.tmp")) continue;
    const path = fs.join(folder, name);
    try {
      if (isTooPermissive(fs.mode(path))) {
        fs.chmod(path, FILE_MODE);
        tightened += 1;
      }
    } catch (error) {
      // Vanished between readdir and chmod — already gone, nothing to protect.
      // Any other error is a file we failed to secure: counted, never masked.
      if (!isMissingFile(error)) failed += 1;
    }
  }

  return { tightened, failed };
}
