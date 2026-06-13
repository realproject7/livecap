// Adoption of orphaned in-progress recordings (#69): a session that crashed
// before finalize() leaves `<prefix> — (recording).md`; the next start must
// promote it to a titled archive (title from its own Summary) without losing
// data. These drive the REAL writer to produce a realistic orphan, then adopt.

import { describe, expect, it } from "vitest";

import { adoptOrphanRecordings } from "../src/adopt";
import { SessionArchiveWriter } from "../src/writer";
import type { CaptionEntry, SessionMeta } from "../src/types";
import { FakeFs } from "./helpers/fake-fs";

const FOLDER = "/data/LiveCap";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    fileNamePrefix: "2026-06-13 0101",
    headerDate: "2026-06-13",
    startClock: "01:01",
    sourceLang: "EN",
    targetLang: "KO",
    engineName: "Claude CLI",
    ...overrides,
  };
}

const ENTRY: CaptionEntry = {
  speaker: "them",
  timestamp: "01:02",
  source: "Let us start the quarterly planning.",
  target: "분기 계획을 시작합시다.",
  pinned: false,
  lowConfidence: false,
};

/** Open a writer and leave it un-finalized: exactly a crashed session's orphan. */
function crashWith(
  fs: FakeFs,
  build: (w: SessionArchiveWriter) => void,
  metaOverrides: Partial<SessionMeta> = {},
): string {
  const writer = new SessionArchiveWriter({ fs, folder: FOLDER, meta: meta(metaOverrides) });
  writer.open();
  build(writer);
  return writer.path; // still `<prefix> — (recording).md` (never finalized)
}

describe("adoptOrphanRecordings (#69)", () => {
  it("promotes a crashed recording to a titled archive, title from its summary", () => {
    const fs = new FakeFs();
    const orphan = crashWith(fs, (w) => {
      w.appendCaption(ENTRY);
      w.updateBrief({ summary: ["Quarterly planning sync", "Budget set for Q3"] });
    });
    const original = fs.readFile(orphan);

    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    const finalPath = `${FOLDER}/2026-06-13 0101 — Quarterly planning sync.md`;
    expect(result.adopted).toEqual([
      { from: "2026-06-13 0101 — (recording).md", to: "2026-06-13 0101 — Quarterly planning sync.md" },
    ]);
    expect(result.failed).toEqual([]);
    // Renamed, not copied: the orphan is gone, content carried over verbatim.
    expect(fs.exists(orphan)).toBe(false);
    expect(fs.readFile(finalPath)).toBe(original);
    // The transcript data survived the adoption.
    expect(fs.readFile(finalPath)).toContain("Let us start the quarterly planning.");
  });

  it("falls back to 'Untitled session' when the crash left no summary", () => {
    const fs = new FakeFs();
    // Crashed before the first summary tick: only open() ran.
    crashWith(fs, () => {});

    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    expect(result.adopted).toEqual([
      { from: "2026-06-13 0101 — (recording).md", to: "2026-06-13 0101 — Untitled session.md" },
    ]);
    expect(fs.exists(`${FOLDER}/2026-06-13 0101 — Untitled session.md`)).toBe(true);
  });

  it("never touches a finished archive or a .md.tmp crash temp", () => {
    const fs = new FakeFs();
    fs.writeFile(`${FOLDER}/2026-06-10 0900 — Real meeting.md`, "# Real meeting\n");
    fs.writeFile(`${FOLDER}/2026-06-11 1000 — (recording).md.tmp`, "partial temp");

    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    expect(result.adopted).toEqual([]);
    expect(fs.exists(`${FOLDER}/2026-06-10 0900 — Real meeting.md`)).toBe(true);
    expect(fs.exists(`${FOLDER}/2026-06-11 1000 — (recording).md.tmp`)).toBe(true);
  });

  it("is idempotent: a second start adopts nothing", () => {
    const fs = new FakeFs();
    crashWith(fs, (w) => w.updateBrief({ summary: ["Standup"] }));

    expect(adoptOrphanRecordings({ fs, folder: FOLDER }).adopted).toHaveLength(1);
    expect(adoptOrphanRecordings({ fs, folder: FOLDER }).adopted).toHaveLength(0);
  });

  it("suffixes ' (2)' when the derived title collides with an existing archive", () => {
    const fs = new FakeFs();
    fs.writeFile(`${FOLDER}/2026-06-13 0101 — Standup.md`, "# Standup\n");
    crashWith(fs, (w) => w.updateBrief({ summary: ["Standup"] }));

    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    expect(result.adopted[0]?.to).toBe("2026-06-13 0101 — Standup (2).md");
    // The pre-existing archive was not overwritten.
    expect(fs.readFile(`${FOLDER}/2026-06-13 0101 — Standup.md`)).toBe("# Standup\n");
  });

  it("sanitizes a malicious summary title so adoption stays inside the folder", () => {
    const fs = new FakeFs();
    crashWith(fs, (w) => w.updateBrief({ summary: ["../../etc/passwd"] }));

    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    expect(result.adopted).toHaveLength(1);
    for (const key of fs.files.keys()) {
      expect(key.startsWith(`${FOLDER}/`)).toBe(true);
    }
  });

  it("adopts multiple orphans from several crashed sessions", () => {
    const fs = new FakeFs();
    crashWith(fs, (w) => w.updateBrief({ summary: ["Morning sync"] }), { fileNamePrefix: "2026-06-12 0900" });
    crashWith(fs, (w) => w.updateBrief({ summary: ["Afternoon review"] }), { fileNamePrefix: "2026-06-12 1400" });

    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    expect(result.adopted.map((a) => a.to).sort()).toEqual([
      "2026-06-12 0900 — Morning sync.md",
      "2026-06-12 1400 — Afternoon review.md",
    ].sort());
  });

  it("surfaces a non-ENOENT failure and leaves the orphan in place", () => {
    const fs = new FakeFs();
    const orphan = crashWith(fs, (w) => w.updateBrief({ summary: ["Standup"] }));

    fs.failNextRename = true; // e.g. a permission/I-O error during the promote
    const result = adoptOrphanRecordings({ fs, folder: FOLDER });

    expect(result.adopted).toEqual([]);
    expect(result.failed).toEqual(["2026-06-13 0101 — (recording).md"]);
    // The crash-preserved data is untouched — still the orphan, never lost.
    expect(fs.exists(orphan)).toBe(true);
  });

  it("is a no-op when the archive folder does not exist yet", () => {
    const fs = new FakeFs();
    expect(adoptOrphanRecordings({ fs, folder: "/nope" })).toEqual({ adopted: [], failed: [] });
  });
});
