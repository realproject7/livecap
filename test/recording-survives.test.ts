// Regression for #63 (data-loss): the in-progress `(recording).md` vanished
// mid-session with a MINIMAL settings.json (sanitized defaults) + music-only
// audio. This drives the REAL archive components the host wires together —
// resolveStartConfig (defaults), sweepOldArchives (retention), and
// SessionArchiveWriter — through that exact scenario against a real temp folder,
// and asserts the working file is never deleted mid-session.

import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  adoptOrphanRecordings,
  nodeArchiveFs,
  SessionArchiveWriter,
  sweepOldArchives,
  WORKING_TITLE,
  type CaptionEntry,
} from "@livecap/archive";

import { resolveStartConfig } from "../src/host/start-config";
import type { HostInbound } from "../src/protocol";

type StartMessage = Extract<HostInbound, { type: "start" }>;

// A minimal settings.json carries only {targetLanguage, engine}; Rust fills the
// rest from sanitized defaults before sending the start message. We model that
// resolved default message here (everything but the two fields at its default).
function defaultStartMessage(overrides: Partial<StartMessage> = {}): StartMessage {
  return {
    type: "start",
    appDataDir: "/tmp/livecap-data",
    archiveDir: "/tmp/livecap-archives",
    targetLanguageCode: "ko",
    enginePref: "cli",
    poolUsd: 20,
    resetDay: 1,
    autoSwitch: true,
    archiveAutoSave: true,
    archiveRetentionDays: 0, // default: keep forever (retention OFF)
    captureSystem: true,
    captureMic: true,
    ...overrides,
  };
}

let archiveDir: string;
const fs = nodeArchiveFs();

beforeEach(() => {
  archiveDir = mkdtempSync(join(tmpdir(), "livecap-archive-"));
});
afterEach(() => {
  rmSync(archiveDir, { recursive: true, force: true });
});

/** Replicate the host's start-time archive sequence (session.ts): sweep first
 *  (only when retention is enabled), adopt any orphaned recordings (#69), then
 *  open this session's working file. */
function startSession(
  retentionDays: number,
  autoSave: boolean,
  fileNamePrefix = "2026-06-13 0101",
): SessionArchiveWriter | null {
  if (retentionDays > 0) {
    sweepOldArchives({ fs, folder: archiveDir, maxAgeDays: retentionDays, nowMs: Date.now() });
  }
  adoptOrphanRecordings({ fs, folder: archiveDir });
  if (!autoSave) return null;
  const writer = new SessionArchiveWriter({
    fs,
    folder: archiveDir,
    meta: {
      fileNamePrefix,
      headerDate: "2026-06-13",
      startClock: "01:01",
      sourceLang: "EN",
      targetLang: "KO",
      engineName: "Local (Qwen3 4B)",
    },
  });
  writer.open();
  return writer;
}

function recordingFiles(): string[] {
  return readdirSync(archiveDir).filter((n) => n.includes(WORKING_TITLE));
}

describe("#63 — in-progress recording survives a minimal-settings session", () => {
  it("minimal settings resolve to auto-save ON + retention OFF (sanitized defaults)", () => {
    const resolved = resolveStartConfig(defaultStartMessage());
    expect(resolved.archiveAutoSave).toBe(true);
    expect(resolved.archiveRetentionDays).toBe(0);
  });

  it("a music-only session (no captions) keeps its (recording).md through brief rewrites", () => {
    const resolved = resolveStartConfig(defaultStartMessage());
    const writer = startSession(resolved.archiveRetentionDays, resolved.archiveAutoSave);
    expect(writer).not.toBeNull();
    const path = writer!.path;
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith(`${WORKING_TITLE}.md`)).toBe(true);

    // Music-only: no finalized captions, but the periodic brief rewrite still
    // runs (cost/duration update). The atomic rewrite must never lose the file.
    for (let i = 0; i < 5; i++) {
      writer!.updateBrief({ endClock: "01:0" + i, durationMin: i, costUsd: 0 });
      expect(existsSync(path)).toBe(true);
    }
    expect(recordingFiles()).toHaveLength(1);
  });

  it("a SECOND session start's retention sweep never deletes a live recording (#63)", () => {
    // Session 1 is recording (its working file is on disk).
    const s1 = startSession(0, true);
    const recPath = s1!.path;
    // A sparse transcript (one music-misheard caption), then a brief rewrite.
    const entry: CaptionEntry = {
      speaker: "them",
      timestamp: "01:02",
      source: "[music]",
      target: "[음악]",
      pinned: false,
      lowConfidence: true,
    };
    s1!.appendCaption(entry);
    s1!.updateBrief({ durationMin: 7 });
    expect(existsSync(recPath)).toBe(true);

    // A second/internal start sweeps — even with retention ON (the suspect),
    // the live recording is preserved; only finished archives would be reaped.
    sweepOldArchives({ fs, folder: archiveDir, maxAgeDays: 90, nowMs: Date.now() });
    expect(existsSync(recPath)).toBe(true);

    // And retention OFF (the real minimal-settings case) is a no-op anyway.
    sweepOldArchives({ fs, folder: archiveDir, maxAgeDays: 0, nowMs: Date.now() });
    expect(existsSync(recPath)).toBe(true);
  });

  it("a crashed session's (recording).md is ADOPTED on the next start (#69)", () => {
    // Session 1 records, gets a summary, then CRASHES (never finalized).
    const s1 = startSession(0, true);
    const entry: CaptionEntry = {
      speaker: "them",
      timestamp: "01:02",
      source: "Let us cover the migration plan.",
      target: "마이그레이션 계획을 다룹시다.",
      pinned: false,
      lowConfidence: false,
    };
    s1!.appendCaption(entry);
    s1!.updateBrief({ summary: ["Migration planning", "Cutover next week"] });
    const orphanPath = s1!.path; // <prefix> — (recording).md, left on disk
    expect(existsSync(orphanPath)).toBe(true);

    // Session 2 starts (retention OFF, like minimal settings): the orphan is
    // promoted to a titled archive — title from its own first summary line —
    // and this session opens its OWN, separate working file.
    const s2 = startSession(0, true, "2026-06-13 0202");
    const adopted = join(archiveDir, "2026-06-13 0101 — Migration planning.md");
    expect(existsSync(orphanPath)).toBe(false); // renamed, not deleted...
    expect(existsSync(adopted)).toBe(true); // ...to its titled name
    expect(readdirSync(archiveDir)).toContain("2026-06-13 0101 — Migration planning.md");
    // The recovered transcript survived intact.
    expect(fs.readFile(adopted)).toContain("Let us cover the migration plan.");
    // Session 2's live recording is a distinct file, untouched by adoption.
    expect(s2!.path.endsWith(`${WORKING_TITLE}.md`)).toBe(true);
    expect(s2!.path).not.toBe(orphanPath);
    expect(recordingFiles()).toEqual([s2!.path.split("/").pop()]);
  });

  it("finalize on an empty/music-only transcript preserves the data under a titled name", () => {
    const writer = startSession(0, true);
    const recPath = writer!.path;
    // Empty transcript → empty title → the sanitizer's fallback, never a delete.
    const finalPath = writer!.finalize({
      title: "",
      summary: [],
      board: { decisions: [], actionItems: [], openQuestions: [] },
      endClock: "01:08",
      durationMin: 7,
      costUsd: 0,
    });
    expect(existsSync(recPath)).toBe(false); // renamed (not deleted)...
    expect(existsSync(finalPath)).toBe(true); // ...to a titled file
    expect(finalPath.endsWith("Untitled session.md")).toBe(true);
  });
});
