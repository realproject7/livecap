// In-memory ArchiveFs for tests: deterministic, and able to simulate a crash
// (a thrown error) at any individual write/append/rename step.

import type { ArchiveFs } from "../../src/fs";

export class FakeFs implements ArchiveFs {
  readonly sep = "/";
  readonly files = new Map<string, string>();
  private readonly mtimes = new Map<string, number>();
  /** Logical clock; advances on every mutation, used as mtime. */
  clock = 0;

  /** When set, the next matching op throws (simulating a mid-write crash). */
  failNextWrite = false;
  failNextAppend = false;
  failNextRename = false;

  join(...segments: string[]): string {
    return segments.join("/").replace(/\/+/g, "/");
  }

  resolve(path: string): string {
    const absolute = path.startsWith("/") ? path : `/${path}`;
    const out: string[] = [];
    for (const segment of absolute.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") out.pop();
      else out.push(segment);
    }
    return `/${out.join("/")}`;
  }

  mkdirp(): void {
    // Directories are implicit in this flat map.
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  readFile(path: string): string {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  }

  writeFile(path: string, data: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated crash during writeFile");
    }
    this.files.set(path, data);
    this.mtimes.set(path, ++this.clock);
  }

  appendFile(path: string, data: string): void {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated crash during appendFile");
    }
    this.files.set(path, (this.files.get(path) ?? "") + data);
    this.mtimes.set(path, ++this.clock);
  }

  rename(from: string, to: string): void {
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error("simulated crash during rename");
    }
    if (!this.files.has(from)) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, this.files.get(from) as string);
    this.files.delete(from);
    this.mtimes.set(to, ++this.clock);
    this.mtimes.delete(from);
  }

  unlink(path: string): void {
    this.files.delete(path);
    this.mtimes.delete(path);
  }

  readdir(dir: string): string[] {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes("/")) names.push(rest);
    }
    return names;
  }

  /** Paths whose stat should throw ENOENT (simulate a file vanishing mid-sweep). */
  readonly enoentOnStat = new Set<string>();
  /** Paths whose stat should throw EACCES (simulate a non-ENOENT permission error). */
  readonly eaccesOnStat = new Set<string>();

  mtimeMs(path: string): number {
    if (this.enoentOnStat.has(path)) throw new Error(`ENOENT: ${path}`);
    if (this.eaccesOnStat.has(path)) {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), { code: "EACCES" });
    }
    return this.mtimes.get(path) ?? 0;
  }

  /** Set a file's mtime directly (for retention tests). */
  setMtime(path: string, mtimeMs: number): void {
    this.mtimes.set(path, mtimeMs);
  }
}
