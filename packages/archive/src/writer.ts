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

const WORKING_TITLE = "(recording)";

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
  }

  /** Write to a temp sibling then atomically rename into place. */
  private atomicWrite(target: string, content: string): void {
    const tmp = `${target}.tmp`;
    this.fs.writeFile(tmp, content);
    this.fs.rename(tmp, target);
  }

  /** Join a filename into the folder and assert it cannot escape it. */
  private resolveInside(fileName: string): string {
    const candidate = this.fs.join(this.folder, fileName);
    const root = this.fs.resolve(this.folder);
    const resolved = this.fs.resolve(candidate);
    // Must be strictly inside the folder — the folder itself is not a valid
    // write target, so `resolved === root` is rejected too.
    if (!resolved.startsWith(root + this.fs.sep)) {
      throw new Error("archive path escapes the configured folder");
    }
    return resolved;
  }

  /** A contained path for `fileName`, suffixed " (2)", " (3)" … on collision. */
  private resolveUnique(fileName: string): string {
    let candidate = this.resolveInside(fileName);
    if (!this.fs.exists(candidate)) return candidate;
    const stem = fileName.replace(/\.md$/, "");
    for (let i = 2; ; i++) {
      candidate = this.resolveInside(`${stem} (${i}).md`);
      if (!this.fs.exists(candidate)) return candidate;
    }
  }

  private ensureWritable(): void {
    if (!this.opened) throw new Error("archive writer not opened");
    if (this.finalized) throw new Error("archive writer already finalized");
  }
}
