// Filesystem abstraction. Injected so the writer is pure, headless-testable,
// and crash points can be simulated deterministically. Only this module binds
// to node:fs/node:path; the writer, renderer, sanitizer, and retention sweep
// take an ArchiveFs and never import node.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ArchiveFs {
  /** Path separator (e.g. "/"). */
  readonly sep: string;
  /** Join path segments. */
  join(...segments: string[]): string;
  /** Normalize to an absolute path, collapsing "." and "..". */
  resolve(path: string): string;
  /** Create a directory and any missing parents. */
  mkdirp(dir: string): void;
  /** Whether a path exists. */
  exists(path: string): boolean;
  /** Overwrite a file. */
  writeFile(path: string, data: string): void;
  /** Append to a file (creating it if missing). */
  appendFile(path: string, data: string): void;
  /** Atomically rename (same volume). */
  rename(from: string, to: string): void;
  /** Read a file as UTF-8. */
  readFile(path: string): string;
  /** Delete a file. */
  unlink(path: string): void;
  /** List immediate entry names in a directory. */
  readdir(dir: string): string[];
  /** Last-modified time in epoch milliseconds. */
  mtimeMs(path: string): number;
  /** Bump a file's last-modified time to now (liveness heartbeat, #69). */
  touch(path: string): void;
}

// Owner-only permissions for the archive (#148, N-6): transcripts hold private
// meeting content, so on a shared/group-synced Mac they must not be world- or
// group-readable. Applied at creation — new files/dirs are restricted; umask can
// only remove further bits, never widen these.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** A node-backed ArchiveFs for production use (the consumer wires this in). */
export function nodeArchiveFs(): ArchiveFs {
  return {
    sep: path.sep,
    join: (...segments) => path.join(...segments),
    resolve: (p) => path.resolve(p),
    mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE }),
    exists: (p) => fs.existsSync(p),
    writeFile: (p, data) => {
      fs.writeFileSync(p, data, { encoding: "utf8", mode: FILE_MODE });
      // `mode` above only takes effect when the file is created; the writer's
      // atomic write can overwrite a stale `.tmp` left by a crash, so enforce
      // owner-only unconditionally before it is renamed into place.
      fs.chmodSync(p, FILE_MODE);
    },
    appendFile: (p, data) => fs.appendFileSync(p, data, { encoding: "utf8", mode: FILE_MODE }),
    rename: (from, to) => fs.renameSync(from, to),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    unlink: (p) => fs.unlinkSync(p),
    readdir: (dir) => fs.readdirSync(dir),
    mtimeMs: (p) => fs.statSync(p).mtimeMs,
    touch: (p) => {
      const now = new Date();
      fs.utimesSync(p, now, now);
    },
  };
}
