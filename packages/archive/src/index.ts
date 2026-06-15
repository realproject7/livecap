// @livecap/archive — crash-safe incremental session archive writer (issue #8).
// Writes each meeting to a Markdown file (PROPOSAL §8.9), append-as-you-go with
// atomic front-matter rewrites; finalizes to a sanitized, collision-safe name.

export { SessionArchiveWriter, WORKING_TITLE } from "./writer";
export type { SessionArchiveWriterOptions } from "./writer";
export { sweepOldArchives, isInProgressRecording, recordingPrefix } from "./retention";
export type { RetentionOptions, RetentionResult } from "./retention";
export { adoptOrphanRecordings } from "./adopt";
export type { AdoptionOptions, AdoptionResult } from "./adopt";
export { sanitizeTitle, archiveFileName, MAX_TITLE_BYTES, FALLBACK_TITLE } from "./sanitize";
export { nodeArchiveFs } from "./fs";
export type { ArchiveFs } from "./fs";
export { renderDocument, renderEntryBody, renderEntryAppend, renderFrontMatter } from "./render";
export type { ArchiveModel } from "./render";
export type {
  Speaker,
  CaptionEntry,
  BoardData,
  MetricsData,
  SessionMeta,
  BriefUpdate,
  FinalBrief,
} from "./types";
