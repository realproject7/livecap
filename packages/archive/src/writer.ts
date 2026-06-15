// Crash-safe incremental session archive writer (PROPOSAL §8.9, EPIC decision:
// incremental writes, a crash loses nothing).
//
// Strategy:
//   - open(): create the folder and a working file immediately (timestamp
//     name), with header + empty Summary/Board + an empty Transcript section.
//   - appendCaption(): append-only to the transcript — cheap and durable; a
//     finalized caption is on disk the instant the append returns.
//   - updateBrief(): the front sections change length, so we rewrite the WHOLE
//     file via a temp-file + atomic rename. The transcript content is carried
//     from memory, so nothing is lost.
//   - finalize(): last brief rewrite, then rename the working file to its final
//     `<prefix> — <title>.md` name (sanitized; collision-suffixed).
// At every step the on-disk file is a complete, valid, readable document.

import type { ArchiveFs } from "./fs";
import { uniquePath } from "./paths";
import { renderDocument, renderEntryAppend, type ArchiveModel } from "./render";
import { sanitizeTitle } from "./sanitize";
import type { BriefUpdate, CaptionEntry, FinalBrief, SessionMeta } from "./types";

export interface SessionArchiveWriterOptions {
  fs: ArchiveFs;
  /** Destination folder (user data). The writer never writes outside it. */
  folder: string;
  meta: SessionMeta;
  /** Title shown until the session is finalized. */
  workingTitle?: string;
}

/** Title shown in the in-progress working file's name (`<prefix> — (recording).md`)
 *  until the session finalizes. Exported so the retention sweep can recognize —
 *  and never reap — an unfinalized recording (#63). */
export const WORKING_TITLE = "(recording)";

export class SessionArchiveWriter {
  private readonly fs: ArchiveFs;
  private readonly folder: string;
  private readonly meta: SessionMeta;
  private readonly entries: CaptionEntry[] = [];

  private model: ArchiveModel;
  private workingPath = "";
  private opened = false;
  private finalized = false;

  constructor(options: SessionArchiveWriterOptions) {
    this.fs = options.fs;
    this.folder = options.folder;
    this.meta = options.meta;
    this.model = {
      title: options.workingTitle ?? WORKING_TITLE,
      headerDate: this.meta.headerDate,
      startClock: this.meta.startClock,
      endClock: this.meta.startClock,
      durationMin: 0,
      sourceLang: this.meta.sourceLang,
      targetLang: this.meta.targetLang,
      engineName: this.meta.engineName,
      channels: this.meta.channels,
      costUsd: 0,
      summary: [],
      board: { decisions: [], actionItems: [], openQuestions: [] },
      metrics: undefined,
      entries: this.entries,
    };
  }

  /** Absolute path of the file currently being written. */
  get path(): string {
    return this.workingPath;
  }

  /** Create the folder and the working file. Idempotent. */
  open(): void {
    if (this.opened) return;
    this.fs.mkdirp(this.folder);
    // resolveUnique (not resolveInside) so a same-minute restart after a crash
    // never overwrites the orphaned `(recording).md` of the crashed session —
    // that file is exactly what "crash loses nothing" must preserve.
    this.workingPath = this.resolveUnique(`${this.meta.fileNamePrefix} — ${WORKING_TITLE}.md`);
    this.atomicWrite(this.workingPath, renderDocument(this.model));
    this.opened = true;
  }

  /**
   * Bump the working file's mtime so a concurrent session start sees this
   * recording as ALIVE and never adopts it as a crashed orphan (#69). The host
   * calls this on a fixed heartbeat; a crashed session stops heartbeating, so
   * its file ages past the staleness threshold and becomes adoptable. No-op
   * before open() or after finalize() (no live working file to keep warm).
   */
  heartbeat(): void {
    if (!this.opened || this.finalized) return;
    this.fs.touch(this.workingPath);
  }

  /** Append a finalized caption to the transcript (durable on return). */
  appendCaption(entry: CaptionEntry): void {
    this.ensureWritable();
    const isFirst = this.entries.length === 0;
    // Append first; only record in memory once it is durably on disk, so a
    // failed append leaves memory and file consistent.
    this.fs.appendFile(this.workingPath, renderEntryAppend(entry, isFirst));
    this.entries.push(entry);
  }

  /** Rewrite the front sections (Summary/Board/header) via atomic swap. */
  updateBrief(brief: BriefUpdate): void {
    this.ensureWritable();
    this.applyBrief(brief);
    this.atomicWrite(this.workingPath, renderDocument(this.model));
  }

  /**
   * Final brief rewrite, then rename the working file to its titled name.
   * Returns the final absolute path.
   */
  finalize(brief: FinalBrief): string {
    this.ensureWritable();
    this.applyBrief(brief);
    this.atomicWrite(this.workingPath, renderDocument(this.model));

    const fileName = `${this.meta.fileNamePrefix} — ${sanitizeTitle(brief.title)}.md`;
    const finalPath = this.resolveUnique(fileName);
    this.fs.rename(this.workingPath, finalPath);
    this.workingPath = finalPath;
    this.finalized = true;
    return finalPath;
  }

  private applyBrief(brief: BriefUpdate): void {
    if (brief.title !== undefined) this.model.title = brief.title;
    if (brief.summary !== undefined) this.model.summary = brief.summary;
    if (brief.board !== undefined) this.model.board = brief.board;
    if (brief.endClock !== undefined) this.model.endClock = brief.endClock;
    if (brief.durationMin !== undefined) this.model.durationMin = brief.durationMin;
    if (brief.costUsd !== undefined) this.model.costUsd = brief.costUsd;
    if (brief.metrics !== undefined) this.model.metrics = brief.metrics;
  }

  /** Write to a temp sibling then atomically rename into place. */
  private atomicWrite(target: string, content: string): void {
    const tmp = `${target}.tmp`;
    this.fs.writeFile(tmp, content);
    this.fs.rename(tmp, target);
  }

  /** A contained, collision-suffixed path for `fileName` in the archive folder. */
  private resolveUnique(fileName: string): string {
    return uniquePath(this.fs, this.folder, fileName);
  }

  private ensureWritable(): void {
    if (!this.opened) throw new Error("archive writer not opened");
    if (this.finalized) throw new Error("archive writer already finalized");
  }
}
