import { describe, it, expect } from "vitest";

import { SessionArchiveWriter } from "../src/writer";
import type { FinalBrief, SessionMeta } from "../src/types";
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

function finalBrief(title: string): FinalBrief {
  return { title, summary: ["s"], board: { decisions: [], actionItems: [], openQuestions: [] } };
}

describe("SessionArchiveWriter — traversal & collisions", () => {
  it("keeps every malicious title inside the archive folder", () => {
    const evilTitles = [
      "../../etc/passwd",
      "/etc/passwd",
      "..\\..\\windows\\system32",
      "evil⁄..⁄..⁄secret",
      "..",
    ];
    for (const title of evilTitles) {
      const fs = new FakeFs();
      const writer = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });
      writer.open();
      const finalPath = writer.finalize(finalBrief(title));

      expect(finalPath.startsWith(`${FOLDER}/`)).toBe(true);
      expect(finalPath.endsWith(".md")).toBe(true);
      // No file ever landed outside the folder.
      for (const key of fs.files.keys()) {
        expect(key.startsWith(`${FOLDER}/`)).toBe(true);
      }
    }
  });

  it("rejects a working path that would escape via the filename prefix", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({
      fs,
      folder: FOLDER,
      meta: { ...META, fileNamePrefix: "../evil" },
    });
    expect(() => writer.open()).toThrow(/escapes the configured folder/);
  });

  it("suffixes ' (2)' on a filename collision", () => {
    const fs = new FakeFs();

    const first = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });
    first.open();
    const p1 = first.finalize(finalBrief("Weekly sync"));
    expect(p1).toBe(`${FOLDER}/2026-06-11 1045 — Weekly sync.md`);

    const second = new SessionArchiveWriter({ fs, folder: FOLDER, meta: META });
    second.open();
    const p2 = second.finalize(finalBrief("Weekly sync"));
    expect(p2).toBe(`${FOLDER}/2026-06-11 1045 — Weekly sync (2).md`);

    // Both files exist; neither overwrote the other.
    expect(fs.exists(p1)).toBe(true);
    expect(fs.exists(p2)).toBe(true);
  });
});
