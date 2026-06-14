// Domain types for the session archive (PROPOSAL §8.9). The format in §8.9 is
// normative — header meta line, Summary, Board, Transcript with Them/Me, 📌
// pins, and (?) low-confidence markers.

/** Who spoke a line. Rendered as "Them" / "Me". */
export type Speaker = "them" | "me";

/** One finalized caption: original line + its translation. */
export interface CaptionEntry {
  speaker: Speaker;
  /** Clock label as shown in the transcript, e.g. "10:45". */
  timestamp: string;
  /** Source-language text. */
  source: string;
  /** Target-language translation (the `>` line). */
  target: string;
  /** Carried-over pin → renders a leading 📌. */
  pinned?: boolean;
  /** Low-confidence line → appends a " (?)" marker to the source. */
  lowConfidence?: boolean;
}

/** The structured meeting board (PROPOSAL §8.4 / §8.9). */
export interface BoardData {
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
}

/**
 * Post-meeting metrics rendered into the archive (#81). A plain structural
 * shape so this package stays engine-free — the host maps the engine's
 * `MeetingMetrics` onto it. `talkRatioMic` is the mic share of spoken time in
 * [0,1]; `smoothScore` is the delivery score in [0,100].
 */
export interface MetricsData {
  talkRatioMic: number;
  smoothScore: number;
}

/**
 * Session-fixed metadata, supplied by the consumer (the package never reads a
 * clock or resolves a locale itself — these arrive pre-formatted).
 */
export interface SessionMeta {
  /** Filename date+time prefix WITHOUT colons, e.g. "2026-06-11 1045". */
  fileNamePrefix: string;
  /** Header date, e.g. "2026-06-11". */
  headerDate: string;
  /** Header start clock, e.g. "10:45". */
  startClock: string;
  /** Source language label, e.g. "EN". */
  sourceLang: string;
  /** Target language label, e.g. "KO". */
  targetLang: string;
  /** Engine label for the header, e.g. "Claude CLI". */
  engineName: string;
  /** Channel-config note for the header when a channel was off at session
   *  start (#53), e.g. "system audio only". Omitted when both were on. */
  channels?: string;
}

/** The mutable front-matter that gets rewritten over the session. */
export interface BriefUpdate {
  /** Title shown as the H1. The final title comes from the summary's 1st line. */
  title?: string;
  summary?: string[];
  board?: BoardData;
  /** Header end clock, e.g. "11:32". */
  endClock?: string;
  /** Whole-meeting duration in minutes. */
  durationMin?: number;
  /** Cumulative engine cost in USD. */
  costUsd?: number;
  /** Post-meeting metrics (#81) — rendered as a "Metrics" section. Present only
   *  at finalize (computed once the session ends); omitted means no section. */
  metrics?: MetricsData;
}

/** A BriefUpdate with the title required — for finalize(). */
export interface FinalBrief extends BriefUpdate {
  title: string;
}
