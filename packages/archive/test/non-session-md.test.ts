// #148 (N-3): pointing the archive at a folder with unrelated markdown should
// not slurp it. The dashboard's session-file FILTER lives in the Rust index and
// is owned by #144 (device track) — this batch does NOT add it. This test LOCKS
// the current TS behavior so #144 can build on a known baseline: the only TS pass
// that scans the folder, orphan adoption (#69), already keys off the writer's
// `<prefix> — (recording).md` grammar via `recordingPrefix`, so a non-session
// `.md` (e.g. a user's own notes) is never touched.
//
// NOTE for #144: dashboard/session-file listing + filtering remains in #144
// (`src-tauri/src/dashboard.rs` `list_archived_sessions`). Keep it aligned with
// the writer grammar asserted here.
import { describe, expect, it } from "vitest";

import { adoptOrphanRecordings } from "../src/adopt";
import { recordingPrefix } from "../src/retention";
import { FakeFs } from "./helpers/fake-fs";

const FOLDER = "/data/LiveCap";
const NOW = 10_000_000;
const STALE_AFTER = 60_000;

describe("non-session .md handling is unchanged (#148 / #144)", () => {
  it("orphan adoption ignores a non-session .md and only promotes real recordings", () => {
    const fs = new FakeFs();
    // A user's unrelated markdown sitting in the same folder.
    fs.writeFile(`${FOLDER}/my personal notes.md`, "# Notes\n\nnot a session\n");
    fs.setMtime(`${FOLDER}/my personal notes.md`, 0); // old enough to be "stale"
    // A genuine crashed recording that SHOULD be adopted.
    fs.writeFile(`${FOLDER}/2026-06-13 0101 — (recording).md`, "# (recording)\n\n## Summary\n- weekly sync\n");
    fs.setMtime(`${FOLDER}/2026-06-13 0101 — (recording).md`, 0);

    const result = adoptOrphanRecordings({ fs, folder: FOLDER, nowMs: NOW, staleAfterMs: STALE_AFTER });

    // The non-session file is neither adopted nor renamed — it stays exactly as written.
    expect(result.adopted.map((a) => a.from)).not.toContain("my personal notes.md");
    expect(result.failed).not.toContain("my personal notes.md");
    expect(fs.exists(`${FOLDER}/my personal notes.md`)).toBe(true);
    // Only the real recording was promoted.
    expect(result.adopted).toHaveLength(1);
    expect(result.adopted[0]?.from).toBe("2026-06-13 0101 — (recording).md");
  });

  it("recordingPrefix rejects a non-session .md name (the grammar the filter would use)", () => {
    expect(recordingPrefix("my personal notes.md")).toBeNull();
    expect(recordingPrefix("README.md")).toBeNull();
    expect(recordingPrefix("2026-06-13 0101 — (recording).md")).not.toBeNull();
  });
});
