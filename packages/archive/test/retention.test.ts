import { describe, it, expect } from "vitest";

import { sweepOldArchives } from "../src/retention";
import { FakeFs } from "./helpers/fake-fs";

const FOLDER = "/data/LiveCap";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY; // arbitrary fixed "now"

function seed(): FakeFs {
  const fs = new FakeFs();
  fs.writeFile(fs.join(FOLDER, "old.md"), "x");
  fs.setMtime(fs.join(FOLDER, "old.md"), NOW - 120 * DAY);
  fs.writeFile(fs.join(FOLDER, "recent.md"), "x");
  fs.setMtime(fs.join(FOLDER, "recent.md"), NOW - 10 * DAY);
  fs.writeFile(fs.join(FOLDER, "notes.txt"), "x"); // non-archive, must be kept
  fs.setMtime(fs.join(FOLDER, "notes.txt"), NOW - 365 * DAY);
  return fs;
}

describe("sweepOldArchives", () => {
  it("deletes .md archives older than maxAgeDays, keeps newer ones", () => {
    const fs = seed();
    const { removed, failed } = sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 90, nowMs: NOW });
    expect(removed).toEqual(["old.md"]);
    expect(failed).toEqual([]);
    expect(fs.exists(fs.join(FOLDER, "old.md"))).toBe(false);
    expect(fs.exists(fs.join(FOLDER, "recent.md"))).toBe(true);
  });

  it("never touches non-.md files", () => {
    const fs = seed();
    sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 1, nowMs: NOW });
    expect(fs.exists(fs.join(FOLDER, "notes.txt"))).toBe(true);
  });

  it("sweeps stale .md.tmp crash orphans too", () => {
    const fs = seed();
    fs.writeFile(fs.join(FOLDER, "2026-06-11 1045 — (recording).md.tmp"), "partial");
    fs.setMtime(fs.join(FOLDER, "2026-06-11 1045 — (recording).md.tmp"), NOW - 30 * DAY);
    const { removed } = sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 7, nowMs: NOW });
    expect(removed).toContain("2026-06-11 1045 — (recording).md.tmp");
    expect(fs.exists(fs.join(FOLDER, "2026-06-11 1045 — (recording).md.tmp"))).toBe(false);
  });

  it("is a no-op when retention is disabled (default off)", () => {
    const fs = seed();
    expect(sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 0, nowMs: NOW })).toEqual({
      removed: [],
      failed: [],
    });
    expect(sweepOldArchives({ fs, folder: FOLDER, nowMs: NOW })).toEqual({ removed: [], failed: [] });
    expect(fs.exists(fs.join(FOLDER, "old.md"))).toBe(true);
  });

  it("is a no-op when the folder does not exist", () => {
    const fs = new FakeFs();
    expect(sweepOldArchives({ fs, folder: "/missing", maxAgeDays: 30, nowMs: NOW })).toEqual({
      removed: [],
      failed: [],
    });
  });

  it("tolerates a file vanishing mid-sweep silently (ENOENT) — not in removed or failed (#33/#48)", () => {
    const fs = seed();
    const vanished = fs.join(FOLDER, "vanished.md");
    fs.writeFile(vanished, "x");
    fs.setMtime(vanished, NOW - 200 * DAY);
    fs.enoentOnStat.add(vanished);

    let result = { removed: [] as string[], failed: [] as string[] };
    expect(() => {
      result = sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 90, nowMs: NOW });
    }).not.toThrow();
    expect(result.removed).toContain("old.md"); // others still swept
    expect(result.removed).not.toContain("vanished.md");
    expect(result.failed).toEqual([]); // ENOENT is tolerated silently
  });

  it("surfaces a non-ENOENT error (permission) in `failed` while still sweeping the rest (#48)", () => {
    const fs = seed();
    const locked = fs.join(FOLDER, "locked.md");
    fs.writeFile(locked, "x");
    fs.setMtime(locked, NOW - 200 * DAY); // old → would be swept, but stat throws EACCES
    fs.eaccesOnStat.add(locked);

    let result = { removed: [] as string[], failed: [] as string[] };
    expect(() => {
      result = sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 90, nowMs: NOW });
    }).not.toThrow(); // never crashes app start
    expect(result.removed).toContain("old.md"); // the rest is still swept
    expect(result.failed).toContain("locked.md"); // surfaced, NOT silently treated as swept
    expect(fs.exists(locked)).toBe(true); // and not deleted
  });

  it("a structured EACCES is surfaced even if the filename contains 'no such file' (#48)", () => {
    // Adversarial: a user-derived filename embeds the missing-file trigger text,
    // so the EACCES error message contains it — but the structured code is the
    // authority, so it must still be surfaced, not misclassified as missing.
    const fs = seed();
    const tricky = fs.join(FOLDER, "no such file.md");
    fs.writeFile(tricky, "x");
    fs.setMtime(tricky, NOW - 200 * DAY);
    fs.eaccesOnStat.add(tricky); // throws an EACCES whose message includes the path

    const { removed, failed } = sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 90, nowMs: NOW });
    expect(failed).toContain("no such file.md"); // surfaced (not dropped as "missing")
    expect(removed).toContain("old.md");
  });
});
