import { describe, it, expect } from "vitest";

import { SessionArchiveWriter } from "../src/writer";
import type { CaptionEntry, SessionMeta } from "../src/types";
import { FakeFs } from "./helpers/fake-fs";

const META: SessionMeta = {
  fileNamePrefix: "2026-06-11 1045",
  headerDate: "2026-06-11",
  startClock: "10:45",
  sourceLang: "EN",
  targetLang: "KO",
  engineName: "Claude CLI",
};

const FOLDER = "/data/LiveCap";

function entry(n: number): CaptionEntry {
  return { speaker: n % 2 ? "me" : "them", timestamp: "10:45", source: `line ${n}`, target: `번역 ${n}` };
}

/** A readable doc has the header and all three sections. */
function assertValidDoc(content: string): void {
  expect(content.startsWith("# ")).toBe(true);
  expect(content).toContain("## Summary");
  expect(content).toContain("## Board");
  expect(content).toContain("## Transcript");
  expect(content.endsWith("\n")).toBe(true);
}

describe("SessionArchiveWriter — crash safety", () => {
  it("leaves a valid file with all finalized content after every write step", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });

    writer.open();
    assertValidDoc(fs.readFile(writer.path));

    const sources: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const e = entry(i);
      writer.appendCaption(e);
      sources.push(e.source);
      // "Crash" right here: the persisted file must already hold everything.
      const onDisk = fs.readFile(writer.path);
      assertValidDoc(onDisk);
      for (const s of sources) expect(onDisk).toContain(s);

      if (i === 3) {
        writer.updateBrief({ summary: ["interim summary"], costUsd: 0.05 });
        const afterBrief = fs.readFile(writer.path);
        assertValidDoc(afterBrief);
        for (const s of sources) expect(afterBrief).toContain(s);
        expect(afterBrief).toContain("interim summary");
      }
    }
  });

  it("a crash during the atomic rename keeps the prior file intact (no loss)", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });
    writer.open();
    writer.appendCaption(entry(1));
    writer.appendCaption(entry(2));
    const before = fs.readFile(writer.path);

    fs.failNextRename = true;
    expect(() => writer.updateBrief({ summary: ["new"] })).toThrow();

    // The working file is untouched — the temp swap never completed.
    expect(fs.readFile(writer.path)).toBe(before);
    expect(fs.readFile(writer.path)).toContain("line 1");
    expect(fs.readFile(writer.path)).toContain("line 2");
  });

  it("a crash during the temp write keeps the prior file intact", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });
    writer.open();
    writer.appendCaption(entry(1));
    const before = fs.readFile(writer.path);

    fs.failNextWrite = true;
    expect(() => writer.updateBrief({ summary: ["new"] })).toThrow();
    expect(fs.readFile(writer.path)).toBe(before);
  });

  it("a crash mid-append does not corrupt earlier finalized content", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });
    writer.open();
    writer.appendCaption(entry(1));
    const before = fs.readFile(writer.path);

    fs.failNextAppend = true;
    expect(() => writer.appendCaption(entry(2))).toThrow();
    // Entry 1 is still fully present and the file is valid.
    expect(fs.readFile(writer.path)).toBe(before);
    assertValidDoc(fs.readFile(writer.path));
  });
});
