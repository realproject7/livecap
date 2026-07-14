// #171 regression: session-scoped webview state must NOT survive a Stop → Start
// in the same app run. Before this fix a second session inherited the first's
// caption blocks and its own mic utterances (session 2's post-meeting coaching
// reads feed.micUtterances(), so it could rewrite lines spoken in session 1),
// AND the first session's summary / board / archive path (openReview reads them).
//
// main.ts clears that state at the new-session boundary via two testable seams:
// FeedState.reset() (the caption feed) and SessionScope.reset() (the summary/
// board/archive-path/metrics model values). Both are DOM/Tauri-free; this drives
// the exact start → content → stop → start sequence against them. (The block/card
// DOM clearing stays in main.ts's resetSessionState — DOM-coupled, run in the app.)

import { describe, expect, it } from "vitest";

import { FeedState } from "../src/feed-state";
import { SessionScope } from "../src/session-scope";

function finalized(id: number, channel: "them" | "me", text: string) {
  return {
    type: "finalized" as const,
    id,
    channel,
    text,
    lang: "en",
    lowConfidence: false,
    epochMs: 1_000 + id,
    durationMs: 900,
  };
}

describe("FeedState.reset (#171 session-scoped reset)", () => {
  it("clears all state so a second session starts empty", () => {
    const feed = new FeedState();

    // --- Session 1: real content across both channels, a pin, a live partial ---
    feed.applyCaption(finalized(1, "me", "I think we should ship it"));
    feed.applyCaption(finalized(2, "them", "agreed, let us do it"));
    feed.applyCaption(finalized(3, "me", "great, I will start today"));
    feed.applyTranslation([{ id: 2, text: "동의합니다" }], true);
    feed.setPinned(2, true);
    feed.applyCaption({ type: "partial", channel: "them", text: "one more thing" });

    // Sanity: session 1 has content the review/coaching path would read.
    expect(feed.blocks.length).toBeGreaterThan(0);
    expect(feed.micUtterances().map((b) => b.source)).toEqual([
      "I think we should ship it",
      "great, I will start today",
    ]);
    expect(feed.get(2)?.pinned).toBe(true);
    expect(feed.latest()).not.toBeNull();

    // --- Stop → Start: the new-session reset boundary ---
    feed.reset();

    // Session 2 starts with a clean slate: no blocks, no ids, no pins, no live
    // partials, no history counter, and crucially no leftover mic utterances.
    expect(feed.blocks).toHaveLength(0);
    expect(feed.micUtterances()).toEqual([]);
    expect(feed.pinnedBlocks()).toEqual([]);
    expect(feed.latest()).toBeNull();
    expect(feed.get(1)).toBeNull();
    expect(feed.get(2)).toBeNull();
    expect(feed.evictedCount).toBe(0);
  });

  it("resets the render-key counter so session 2 keys do not collide with session 1", () => {
    const feed = new FeedState();
    const first = feed.applyCaption({ type: "partial", channel: "me", text: "hello" });

    feed.reset();

    // A fresh session's first block reuses the initial key — no stale-key reuse
    // that could alias a session-1 DOM node still keyed the same way.
    const afterReset = feed.applyCaption({ type: "partial", channel: "me", text: "new session" });
    expect(afterReset.key).toBe(first.key);
    expect(feed.blocks).toHaveLength(1);
  });

  it("drops live partials so a mid-utterance stop does not linger into the next session", () => {
    const feed = new FeedState();
    // A partial with no finalized event (e.g. a session stopped mid-sentence).
    feed.applyCaption({ type: "partial", channel: "me", text: "I was saying" });
    expect(feed.blocks).toHaveLength(1);

    feed.reset();

    // The next session's first partial is genuinely new, not a reused partial.
    expect(feed.blocks).toHaveLength(0);
    const fresh = feed.applyCaption({ type: "partial", channel: "me", text: "brand new" });
    expect(fresh.source).toBe("brand new");
    expect(feed.blocks).toHaveLength(1);
  });
});

describe("SessionScope.reset (#171 summary/board/archive reset)", () => {
  it("clears the summary, board, archive path, and metrics a new session must not inherit", () => {
    const scope = new SessionScope();

    // --- Session 1: the host filled the summary/board, saved the archive, and
    // reported end-of-meeting metrics (exactly what openReview would read) ---
    scope.summaryLine = "we agreed to ship on Friday";
    scope.latestSummary = ["we agreed to ship on Friday", "two follow-ups remain"];
    scope.latestBoard = {
      decisions: ["ship Friday"],
      actionItems: ["send the release notes"],
      openQuestions: ["who signs off?"],
    };
    scope.latestArchivePath = "/Users/me/LiveCap/2026-07-14 Standup.md";
    scope.pendingMetrics = { talkRatioMic: 0.42, smoothScore: 0.9, micMs: 120_000, systemMs: 60_000 };

    // --- Stop → Start: the new-session reset boundary ---
    scope.reset();

    // Session 2 must NOT read session 1's review data: the archive path in
    // particular could otherwise open the previous meeting's saved file.
    expect(scope.summaryLine).toBe("");
    expect(scope.latestSummary).toEqual([]);
    expect(scope.latestBoard).toEqual({ decisions: [], actionItems: [], openQuestions: [] });
    expect(scope.latestArchivePath).toBeNull();
    expect(scope.pendingMetrics).toBeNull();
  });

  it("gives each reset a fresh board object (no shared-reference bleed)", () => {
    const scope = new SessionScope();
    const board1 = scope.latestBoard;
    scope.reset();
    // A new empty board, not the same instance mutated — so a later push into
    // one session's board can never surface in another's.
    expect(scope.latestBoard).not.toBe(board1);
    expect(scope.latestBoard).toEqual({ decisions: [], actionItems: [], openQuestions: [] });
  });
});

describe("session model reset (#171 start → content → stop → start)", () => {
  it("clears the feed AND the summary/board/archive together, as resetSessionState does", () => {
    // Model the two seams main.ts resets as a unit at a new session.
    const feed = new FeedState();
    const scope = new SessionScope();

    // Session 1 produced a transcript, a summary/board, and a saved archive.
    feed.applyCaption(finalized(1, "me", "let us start"));
    feed.applyTranslation([{ id: 1, text: "시작합시다" }], true);
    scope.summaryLine = "kickoff";
    scope.latestBoard = { decisions: ["go"], actionItems: [], openQuestions: [] };
    scope.latestArchivePath = "/tmp/session-1.md";

    // New session start → reset both seams (the model half of resetSessionState).
    feed.reset();
    scope.reset();

    // A completely clean slate for session 2: no transcript, no review data.
    expect(feed.blocks).toEqual([]);
    expect(feed.micUtterances()).toEqual([]);
    expect(scope.summaryLine).toBe("");
    expect(scope.latestSummary).toEqual([]);
    expect(scope.latestBoard).toEqual({ decisions: [], actionItems: [], openQuestions: [] });
    expect(scope.latestArchivePath).toBeNull();
    expect(scope.pendingMetrics).toBeNull();
  });
});
