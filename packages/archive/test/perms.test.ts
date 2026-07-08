// #148 (N-6): transcripts hold private meeting content, so on a shared or
// group-synced Mac the archive dir and files must be owner-only (0o700 / 0o600),
// not the default world-readable 0o755 / 0o644. Exercises the REAL nodeArchiveFs
// against a temp directory and checks the on-disk modes.
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeArchiveFs } from "../src/fs";

// mode-bit semantics are POSIX; skip on Windows (CI archive tests run on Linux).
const run = process.platform === "win32" ? describe.skip : describe;

run("nodeArchiveFs permissions (#148)", () => {
  let root: string;
  const fs = nodeArchiveFs();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "livecap-perms-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mode = (p: string) => statSync(p).mode & 0o777;

  it("creates the archive dir 0o700", () => {
    const dir = join(root, "LiveCap");
    fs.mkdirp(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("writes a new file 0o600", () => {
    const file = join(root, "session.md");
    fs.writeFile(file, "# hello\n");
    expect(mode(file)).toBe(0o600);
  });

  it("appends to a new file 0o600", () => {
    const file = join(root, "transcript.md");
    fs.appendFile(file, "line\n");
    expect(mode(file)).toBe(0o600);
  });

  it("re-restricts a pre-existing world-readable file on overwrite (stale .tmp after a crash)", () => {
    const file = join(root, "session.md.tmp");
    writeFileSync(file, "old", "utf8");
    chmodSync(file, 0o644); // as if written before this hardening / by a prior version
    fs.writeFile(file, "new content");
    expect(mode(file)).toBe(0o600);
  });
});
