// #148 (N-6): transcripts hold private meeting content, so on a shared or
// group-synced Mac the archive dir and files must be owner-only (0o700 / 0o600),
// not the default world-readable 0o755 / 0o644. Exercises the REAL nodeArchiveFs
// against a temp directory and checks the on-disk modes.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeArchiveFs } from "../src/fs";
import { tightenArchivePermissions } from "../src/perms";
import { FakeFs } from "./helpers/fake-fs";

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

// #192: the write path above only ever protected NEW files. Sessions archived by
// pre-#148 builds kept the default 0644 — world-readable transcripts that no
// upgrade ever repaired. This sweep repairs them in place.
run("tightenArchivePermissions (#192 upgrade remediation)", () => {
  let folder: string;
  const fs = nodeArchiveFs();

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "livecap-tighten-"));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const mode = (p: string) => statSync(p).mode & 0o777;
  const plant = (name: string, body: string, fileMode: number): string => {
    const file = join(folder, name);
    writeFileSync(file, body, "utf8");
    chmodSync(file, fileMode);
    return file;
  };

  it("tightens a legacy 0644 transcript, preserving content, name and mtime", () => {
    const body = "# Standup\n> 2026-07-05 · EN → KO\n\nSECRET_MEETING_CONTENT\n";
    const file = plant("2026-07-05 0900 — Standup.md", body, 0o644);
    const before = statSync(file);

    const result = tightenArchivePermissions({ fs, folder });

    expect(mode(file)).toBe(0o600);
    // Permissions ONLY: the transcript itself must come through untouched.
    expect(readFileSync(file, "utf8")).toBe(body);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(result.failed).toBe(0);
    expect(result.tightened).toBeGreaterThanOrEqual(1);
  });

  // The archive folder can be any directory the user picked (`session.rs:463`
  // returns it verbatim), so this migration must not re-permission it — only
  // the session files inside it.
  it("never changes the archive folder's own mode", () => {
    chmodSync(folder, 0o755);
    plant("2026-07-05 0900 — Standup.md", "# S\n", 0o644);

    const result = tightenArchivePermissions({ fs, folder });

    expect(mode(folder)).toBe(0o755);
    expect(result.tightened).toBe(1); // the file only
  });

  it("leaves an already-0600 file alone and reports nothing to do", () => {
    const file = plant("2026-08-01 1000 — Retro.md", "# Retro\n", 0o600);
    const before = statSync(file);

    const result = tightenArchivePermissions({ fs, folder });

    expect(result).toEqual({ tightened: 0, failed: 0 });
    expect(mode(file)).toBe(0o600);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    // No needless write: chmod would have moved ctime even at the same mode.
    expect(statSync(file).ctimeMs).toBe(before.ctimeMs);
  });

  it("covers crash-left .md.tmp orphans and live (recording) files too", () => {
    const orphan = plant("2026-07-05 0900 — Standup.md.tmp", "partial\n", 0o644);
    const recording = plant("2026-07-06 0900 — (recording).md", "live\n", 0o644);
    const unrelated = plant("notes.txt", "not ours\n", 0o644);

    tightenArchivePermissions({ fs, folder });

    expect(mode(orphan)).toBe(0o600);
    expect(mode(recording)).toBe(0o600);
    // Not an archive entry — the sweep stays inside its own file types.
    expect(mode(unrelated)).toBe(0o644);
  });

  it("is idempotent — a second run finds nothing left to do", () => {
    plant("2026-07-05 0900 — Standup.md", "# S\n", 0o644);
    plant("2026-07-06 0900 — Retro.md", "# R\n", 0o640);

    const first = tightenArchivePermissions({ fs, folder });
    const second = tightenArchivePermissions({ fs, folder });

    expect(first.tightened).toBe(2); // both legacy files
    expect(second).toEqual({ tightened: 0, failed: 0 });
  });

  it("is a silent no-op when the archive folder does not exist", () => {
    const missing = join(folder, "not-created-yet");
    expect(() => tightenArchivePermissions({ fs, folder: missing })).not.toThrow();
    expect(tightenArchivePermissions({ fs, folder: missing })).toEqual({
      tightened: 0,
      failed: 0,
    });
  });
});

// Portable (no mode bits): the sweep's OUTPUT contract. Archive names are built
// from meeting titles, so a name is user content — it must not travel out of the
// sweep, or it ends up in whatever the caller logs.
describe("tightenArchivePermissions result contract (#192)", () => {
  const FOLDER = "/Archive";
  const SECRET_NAME = "2026-07-05 0900 — SECRET_MEETING_TITLE.md";

  it("reports counts only — a failing file's name never reaches the caller", () => {
    const fs = new FakeFs();
    const path = `${FOLDER}/${SECRET_NAME}`;
    fs.writeFile(path, "# transcript\n");
    fs.modes.set(path, 0o644);
    fs.eaccesOnChmod.add(path);

    const result = tightenArchivePermissions({ fs, folder: FOLDER });

    expect(result).toEqual({ tightened: 0, failed: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET_MEETING_TITLE");
  });

  it("a file that vanishes mid-sweep is tolerated, not counted as a failure", () => {
    const fs = new FakeFs();
    const path = `${FOLDER}/${SECRET_NAME}`;
    fs.writeFile(path, "# transcript\n");
    fs.modes.set(path, 0o644);
    fs.enoentOnStat.add(path); // deleted between readdir and chmod

    expect(tightenArchivePermissions({ fs, folder: FOLDER })).toEqual({
      tightened: 0,
      failed: 0,
    });
  });

  // An unreadable FOLDER is not an empty one: reporting {0,0} would tell the
  // caller everything is fine while every legacy 0644 transcript inside stays
  // exposed and unmentioned.
  it("an unreadable archive folder is a failure, not a clean sweep", () => {
    const fs = new FakeFs();
    fs.writeFile(`${FOLDER}/${SECRET_NAME}`, "# transcript\n");
    fs.eaccesOnReaddir.add(FOLDER);

    const result = tightenArchivePermissions({ fs, folder: FOLDER });

    expect(result).toEqual({ tightened: 0, failed: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET_MEETING_TITLE");
  });

  it("a folder that does not exist is the one tolerated case", () => {
    const fs = new FakeFs();
    fs.enoentOnReaddir.add(FOLDER);

    expect(tightenArchivePermissions({ fs, folder: FOLDER })).toEqual({
      tightened: 0,
      failed: 0,
    });
  });

  it("one unreadable file does not stop the sweep reaching the others", () => {
    const fs = new FakeFs();
    const blocked = `${FOLDER}/${SECRET_NAME}`;
    const reachable = `${FOLDER}/2026-07-06 0900 — Retro.md`;
    fs.writeFile(blocked, "a");
    fs.writeFile(reachable, "b");
    fs.modes.set(blocked, 0o644);
    fs.modes.set(reachable, 0o644);
    fs.eaccesOnChmod.add(blocked);

    expect(tightenArchivePermissions({ fs, folder: FOLDER })).toEqual({
      tightened: 1,
      failed: 1,
    });
    expect(fs.mode(reachable)).toBe(0o600);
  });
});
