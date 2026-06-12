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
    const removed = sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 90, nowMs: NOW });
    expect(removed).toEqual(["old.md"]);
    expect(fs.exists(fs.join(FOLDER, "old.md"))).toBe(false);
    expect(fs.exists(fs.join(FOLDER, "recent.md"))).toBe(true);
  });

  it("never touches non-.md files", () => {
    const fs = seed();
    sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 1, nowMs: NOW });
    expect(fs.exists(fs.join(FOLDER, "notes.txt"))).toBe(true);
  });

  it("is a no-op when retention is disabled (default off)", () => {
    const fs = seed();
    expect(sweepOldArchives({ fs, folder: FOLDER, maxAgeDays: 0, nowMs: NOW })).toEqual([]);
    expect(sweepOldArchives({ fs, folder: FOLDER, nowMs: NOW })).toEqual([]);
    expect(fs.exists(fs.join(FOLDER, "old.md"))).toBe(true);
  });

  it("is a no-op when the folder does not exist", () => {
    const fs = new FakeFs();
    expect(sweepOldArchives({ fs, folder: "/missing", maxAgeDays: 30, nowMs: NOW })).toEqual([]);
  });
});
