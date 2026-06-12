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
}

/** A node-backed ArchiveFs for production use (the consumer wires this in). */
export function nodeArchiveFs(): ArchiveFs {
  return {
    sep: path.sep,
    join: (...segments) => path.join(...segments),
    resolve: (p) => path.resolve(p),
    mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true }),
    exists: (p) => fs.existsSync(p),
    writeFile: (p, data) => fs.writeFileSync(p, data, "utf8"),
    appendFile: (p, data) => fs.appendFileSync(p, data, "utf8"),
    rename: (from, to) => fs.renameSync(from, to),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    unlink: (p) => fs.unlinkSync(p),
    readdir: (dir) => fs.readdirSync(dir),
    mtimeMs: (p) => fs.statSync(p).mtimeMs,
  };
}
