// Collision-safe, folder-contained filename resolution for the archive. Shared
// by the writer (working/finalized files) and the orphan-recording adoption
// (#69) so both promote a name into the SAME folder with identical guarantees:
// the result is always strictly inside the folder (no traversal via a
// user/LLM-derived segment, SECURITY.md), and never overwrites an existing file.

import type { ArchiveFs } from "./fs";

/**
 * Join `fileName` into `folder` and assert the result cannot escape it. The
 * folder itself is not a valid target, so `resolved === root` is rejected too.
 * Throws if the path would escape (e.g. a `../` prefix that survived).
 */
export function containedPath(fs: ArchiveFs, folder: string, fileName: string): string {
  const root = fs.resolve(folder);
  const resolved = fs.resolve(fs.join(folder, fileName));
  if (!resolved.startsWith(root + fs.sep)) {
    throw new Error("archive path escapes the configured folder");
  }
  return resolved;
}

/** A contained path for `fileName`, suffixed " (2)", " (3)" … on collision. */
export function uniquePath(fs: ArchiveFs, folder: string, fileName: string): string {
  let candidate = containedPath(fs, folder, fileName);
  if (!fs.exists(candidate)) return candidate;
  const stem = fileName.replace(/\.md$/, "");
  for (let i = 2; ; i++) {
    candidate = containedPath(fs, folder, `${stem} (${i}).md`);
    if (!fs.exists(candidate)) return candidate;
  }
}
