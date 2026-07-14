// #171: the session-scoped MODEL values that live OUTSIDE the caption `feed` —
// the summary line, the latest summary/board, the saved archive path, and the
// pending review metrics. They feed the summary strip and the post-meeting
// review screen (#81), and all belong to ONE meeting.
//
// Before this they were scattered module-level singletons in main.ts that
// survived Stop → Start in the same app run, so a second session's review read
// the first session's summary/board/archive path. Grouping them here gives a
// single `reset()` seam that a new session clears alongside `FeedState.reset()`
// — and, unlike main.ts, it is DOM/Tauri-free and unit-testable.

import type { BoardWire } from "./protocol";

/** Post-meeting metrics, retained until the `stopped` event opens the review. */
export interface SessionMetrics {
  talkRatioMic: number;
  smoothScore: number;
  micMs: number;
  systemMs: number;
}

function emptyBoard(): BoardWire {
  return { decisions: [], actionItems: [], openQuestions: [] };
}

export class SessionScope {
  summaryLine = "";
  latestSummary: string[] = [];
  latestBoard: BoardWire = emptyBoard();
  latestArchivePath: string | null = null;
  pendingMetrics: SessionMetrics | null = null;

  /** Clear every session-scoped value so a new session starts blank (#171). */
  reset(): void {
    this.summaryLine = "";
    this.latestSummary = [];
    this.latestBoard = emptyBoard();
    this.latestArchivePath = null;
    this.pendingMetrics = null;
  }
}
