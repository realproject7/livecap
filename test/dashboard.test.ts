// #90 dashboard UI: pure helpers that shape the saved sessions into the model
// the surface renders. Headless — no DOM, no Tauri (the helpers under test do
// not touch `invoke`).

import { describe, expect, it } from "vitest";

import {
  buildDashboardModel,
  formatCost,
  formatDuration,
  sessionMatches,
  type ArchivedSession,
} from "../src/dashboard";
import type { ParsedSession } from "@livecap/archive/src/parse.ts";

/** Build a minimal ParsedSession for the search tests, overriding only the
 *  fields under test. */
function makeSession(fields: {
  title?: string;
  summary?: string[];
  decisions?: string[];
  actionItems?: string[];
  openQuestions?: string[];
  entries?: { source: string; target: string }[];
}): ParsedSession {
  return {
    meta: {
      title: fields.title ?? "",
      headerDate: "",
      startClock: "",
      endClock: "",
      durationMin: 0,
      sourceLang: "",
      targetLang: "",
      engineName: "",
      costUsd: 0,
    },
    summary: fields.summary ?? [],
    board: {
      decisions: fields.decisions ?? [],
      actionItems: fields.actionItems ?? [],
      openQuestions: fields.openQuestions ?? [],
    },
    entries: (fields.entries ?? []).map((e) => ({
      speaker: "me" as const,
      timestamp: "",
      source: e.source,
      target: e.target,
    })),
    isRecording: false,
  };
}

const SESSION_A = `# Quarterly review
> 2026-06-10 09:00–09:30 (30 min) · EN → KO · engine: Claude CLI ($0.10)

## Summary
- Revenue grew 20%

## Board
**Decisions** — ship on Friday

## Metrics
**Talk ratio (me)** — 40%
**Smooth Score** — 70

## Transcript
**Me** (09:00) — Hello there.
> 안녕하세요.

**Them** (09:01) — Welcome.
> 환영합니다.
`;

const SESSION_B = `# Standup
> 2026-06-11 10:00–10:15 (15 min) · EN → KO · engine: Claude CLI ($0.05)

## Summary
- Blockers cleared

## Metrics
**Talk ratio (me)** — 60%
**Smooth Score** — 80

## Transcript
**Me** (10:00) — Quick update. (?)
> 빠른 업데이트.
`;

const RECORDING = `# (recording)
> 2026-06-12 11:00 (0 min) · EN → KO · engine: Claude CLI ($0.00)

## Transcript
`;

describe("formatDuration", () => {
  it("renders minutes, hours, and combinations", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(15)).toBe("15m");
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(90)).toBe("1h 30m");
  });

  it("never goes negative", () => {
    expect(formatDuration(-5)).toBe("0m");
  });
});

describe("formatCost", () => {
  it("renders a dollar amount, or a dash when nothing was recorded", () => {
    expect(formatCost(0.31)).toBe("$0.31");
    expect(formatCost(0)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });
});

describe("buildDashboardModel", () => {
  it("parses, aggregates, and excludes the in-progress recording", () => {
    const archived: ArchivedSession[] = [
      { name: "a.md", markdown: SESSION_A },
      { name: "b.md", markdown: SESSION_B },
      { name: "rec.md", markdown: RECORDING },
    ];
    const model = buildDashboardModel(archived);

    // The recording is dropped; only the two finished sessions remain.
    expect(model.sessions).toHaveLength(2);
    expect(model.stats.completedSessions).toBe(2);
    expect(model.stats.totalSessions).toBe(2);

    // Newest first in the history list.
    expect(model.sessions[0]?.meta.title).toBe("Standup");
    expect(model.sessions[1]?.meta.title).toBe("Quarterly review");

    // The chronological index is the reverse (oldest first).
    expect(model.stats.index[0]?.title).toBe("Quarterly review");
    expect(model.stats.index[1]?.title).toBe("Standup");

    // Aggregated totals.
    expect(model.stats.totalDurationMin).toBe(45);
    expect(model.stats.totalCostUsd).toBeCloseTo(0.15, 5);
    expect(model.stats.averageTalkRatioMic).toBeCloseTo(0.5, 5); // (0.4 + 0.6) / 2
    expect(model.stats.averageSmoothScore).toBeCloseTo(75, 5); // (70 + 80) / 2
  });

  it("returns an empty model for no saved sessions", () => {
    const model = buildDashboardModel([]);
    expect(model.sessions).toHaveLength(0);
    expect(model.stats.totalSessions).toBe(0);
    expect(model.stats.averageTalkRatioMic).toBeNull();
    expect(model.stats.totalDurationMin).toBe(0);
  });

  it("keeps a session's parsed transcript and board intact", () => {
    const model = buildDashboardModel([{ name: "a.md", markdown: SESSION_A }]);
    const session = model.sessions[0];
    expect(session?.entries).toHaveLength(2);
    expect(session?.entries[0]?.speaker).toBe("me");
    expect(session?.entries[0]?.source).toBe("Hello there.");
    expect(session?.entries[0]?.target).toBe("안녕하세요.");
    expect(session?.board.decisions).toEqual(["ship on Friday"]);
  });
});

describe("sessionMatches (#131)", () => {
  it("matches on the session title", () => {
    const s = makeSession({ title: "Quarterly Review" });
    const r = sessionMatches(s, "quarterly");
    expect(r.matched).toBe(true);
    expect(r.snippet).toBe("Quarterly Review");
  });

  it("matches on a summary line", () => {
    const s = makeSession({ summary: ["Revenue grew 20%", "Hiring paused"] });
    const r = sessionMatches(s, "hiring");
    expect(r.matched).toBe(true);
    expect(r.snippet).toBe("Hiring paused");
  });

  it("matches on any board item (decisions / action items / open questions)", () => {
    expect(sessionMatches(makeSession({ decisions: ["Ship on Friday"] }), "friday").matched).toBe(true);
    expect(sessionMatches(makeSession({ actionItems: ["Mike: send the deck"] }), "deck").matched).toBe(true);
    const q = sessionMatches(makeSession({ openQuestions: ["Which MAU definition?"] }), "mau");
    expect(q.matched).toBe(true);
    expect(q.snippet).toBe("Which MAU definition?");
  });

  it("matches on a transcript entry source", () => {
    const s = makeSession({ entries: [{ source: "Let's discuss the budget", target: "예산을 논의합시다" }] });
    const r = sessionMatches(s, "budget");
    expect(r.matched).toBe(true);
    expect(r.snippet).toBe("Let's discuss the budget");
  });

  it("matches on a transcript entry target (translation)", () => {
    const s = makeSession({ entries: [{ source: "Let's discuss the budget", target: "예산을 논의합시다" }] });
    const r = sessionMatches(s, "예산");
    expect(r.matched).toBe(true);
    expect(r.snippet).toBe("예산을 논의합시다");
  });

  it("returns no match when the query is absent from every field", () => {
    const s = makeSession({ title: "Standup", summary: ["Blockers cleared"] });
    expect(sessionMatches(s, "budget")).toEqual({ matched: false, snippet: "" });
  });

  it("is case-insensitive", () => {
    const s = makeSession({ title: "Quarterly Review" });
    expect(sessionMatches(s, "QUARTERLY").matched).toBe(true);
    expect(sessionMatches(s, "rEvIeW").matched).toBe(true);
  });

  it("treats an empty or whitespace-only query as no match (caller shows the full list)", () => {
    const s = makeSession({ title: "Standup" });
    expect(sessionMatches(s, "")).toEqual({ matched: false, snippet: "" });
    expect(sessionMatches(s, "   ")).toEqual({ matched: false, snippet: "" });
  });

  it("returns the first field that matched, in title→summary→board→transcript order", () => {
    const s = makeSession({
      title: "Weekly sync",
      summary: ["We talked about the sync cadence"],
      entries: [{ source: "sync again next week", target: "" }],
    });
    // "sync" is in all three; the title wins.
    expect(sessionMatches(s, "sync").snippet).toBe("Weekly sync");
  });

  it("truncates a long snippet to ~80 chars around the match with ellipses", () => {
    const long =
      "a".repeat(120) + " BUDGET plan for the whole fiscal year " + "b".repeat(120);
    const s = makeSession({ summary: [long] });
    const r = sessionMatches(s, "budget");
    expect(r.matched).toBe(true);
    // Windowed (not the whole 279-char line), the match is visible, and both
    // ends are elided.
    expect(r.snippet.length).toBeLessThanOrEqual(82); // 80 + up to 2 ellipses
    expect(r.snippet.toLowerCase()).toContain("budget");
    expect(r.snippet.startsWith("…")).toBe(true);
    expect(r.snippet.endsWith("…")).toBe(true);
  });

  it("returns a short field whole (no ellipses when under the cap)", () => {
    const s = makeSession({ summary: ["Short line with budget"] });
    const r = sessionMatches(s, "budget");
    expect(r.snippet).toBe("Short line with budget");
  });
});
