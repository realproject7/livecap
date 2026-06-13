// Adoption of orphaned in-progress recordings (#69), complementing the #63
// retention sweep.
//
// A session that crashed or was killed before finalize() leaves its working file
// as `<prefix> — (recording).md`. The retention sweep deliberately NEVER reaps it
// ("a crash loses nothing", #63) — but nothing ever PROMOTES it either, so it
// lingers as "(recording)" indefinitely and the meeting is never titled or
// surfaced as a real archive. On the next session start we ADOPT each orphan:
// derive a title from its own `## Summary` section — the same rule a clean
// finalize uses (session.ts: title = first summary line) — and rename it to
// `<prefix> — <title>.md` (sanitized, collision-safe).
//
// Pure (injected fs), so it is headless-testable. NEVER throws on a per-file
// error so it is safe on the app-start path: a file that vanished mid-sweep
// (ENOENT) is skipped silently; any other per-file error is surfaced in
// `failed`, not masked (#48).

import type { ArchiveFs } from "./fs";
import { containedPath, uniquePath } from "./paths";
import { isMissingFile, recordingPrefix } from "./retention";
import { sanitizeTitle } from "./sanitize";

export interface AdoptionOptions {
  fs: ArchiveFs;
  /** Archive folder to scan for orphaned recordings (the user data dir). */
  folder: string;
}

export interface AdoptionResult {
  /** Orphans promoted this sweep, as `{ from, to }` filenames (not full paths). */
  adopted: { from: string; to: string }[];
  /**
   * Orphan names that hit a NON-ENOENT read/rename error (permission, I/O, …),
   * surfaced — not silently treated as adopted (#48) — so the caller can report
   * that a crashed recording could not be promoted. An ENOENT race appears in
   * neither list.
   */
  failed: string[];
}

/**
 * The first `## Summary` bullet of a rendered archive document, or `""` when the
 * document has no summary yet (a session that crashed before its first summary
 * tick). Mirrors the clean-finalize title rule (session.ts: title = summary[0]).
 * Parses the exact shape renderFrontMatter emits: a `## Summary` line followed by
 * `- ` bullets, terminated by the next `## ` section header.
 */
function firstSummaryLine(content: string): string {
  const lines = content.split("\n");
  const start = lines.indexOf("## Summary");
  if (start === -1) return "";
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break; // reached the next section — no bullet
    if (line.startsWith("- ")) return line.slice(2).trim();
  }
  return "";
}

/** The trailing filename segment of a contained path. */
function baseName(fs: ArchiveFs, path: string): string {
  const idx = path.lastIndexOf(fs.sep);
  return idx === -1 ? path : path.slice(idx + fs.sep.length);
}

/**
 * Promote every orphaned `(recording).md` in `folder` to a titled archive.
 * MUST be called BEFORE the active session opens its own working file, so it
 * only ever sees crashed sessions' orphans — never the live recording.
 */
export function adoptOrphanRecordings(options: AdoptionOptions): AdoptionResult {
  const { fs, folder } = options;
  const adopted: { from: string; to: string }[] = [];
  const failed: string[] = [];

  let names: string[];
  try {
    names = fs.readdir(folder);
  } catch {
    // Folder doesn't exist yet (first run) — nothing to adopt.
    return { adopted, failed };
  }

  for (const name of names) {
    const prefix = recordingPrefix(name);
    if (prefix === null) continue; // not an in-progress recording
    try {
      const from = containedPath(fs, folder, name);
      const title = sanitizeTitle(firstSummaryLine(fs.readFile(from)));
      const to = uniquePath(fs, folder, `${prefix} — ${title}.md`);
      fs.rename(from, to);
      adopted.push({ from: name, to: baseName(fs, to) });
    } catch (error) {
      // A vanished orphan (ENOENT) is already "gone" — tolerate it silently.
      // Any other error (permission, I/O) is surfaced, never masked (#48).
      if (!isMissingFile(error)) failed.push(name);
    }
  }
  return { adopted, failed };
}
