import { describe, it, expect } from "vitest";

import {
  buildIncrementalSummaryBoardPrompt,
  buildQuickTranslatePrompt,
  buildReplyPrompt,
  buildSummaryBoardPrompt,
  parseSummaryBoard,
} from "../src/extras-prompts";

describe("parseSummaryBoard", () => {
  it("parses the four sections into structure", () => {
    const text = [
      "SUMMARY",
      "- Stack-rank vs raw excitement scoring",
      "- Budget concern on contractor expansion",
      "DECISIONS",
      "- Use stack rank, not raw excitement scores",
      "ACTION ITEMS",
      "- Mike → share apps list",
      "- Me → budget memo by Fri",
      "OPEN QUESTIONS",
      "- Which MAU definition wins?",
    ].join("\n");
    const { summary, board } = parseSummaryBoard(text);
    expect(summary).toEqual([
      "Stack-rank vs raw excitement scoring",
      "Budget concern on contractor expansion",
    ]);
    expect(board.decisions).toEqual(["Use stack rank, not raw excitement scores"]);
    expect(board.actionItems).toEqual(["Mike → share apps list", "Me → budget memo by Fri"]);
    expect(board.openQuestions).toEqual(["Which MAU definition wins?"]);
  });

  it("tolerates header case, markdown markers, and varied bullet glyphs", () => {
    const text = [
      "## Summary:",
      "• first point",
      "Decisions",
      "□ ship it",
      "open question",
      "? what about MAU",
    ].join("\n");
    const { summary, board } = parseSummaryBoard(text);
    expect(summary).toEqual(["first point"]);
    expect(board.decisions).toEqual(["ship it"]);
    expect(board.openQuestions).toEqual(["what about MAU"]);
  });

  it("is robust to malformed output (no headers / preamble / junk)", () => {
    expect(parseSummaryBoard("here is your summary, hope it helps!")).toEqual({
      summary: [],
      board: { decisions: [], actionItems: [], openQuestions: [] },
    });
    const partial = parseSummaryBoard("Sure!\nSUMMARY\n- only a summary");
    expect(partial.summary).toEqual(["only a summary"]);
    expect(partial.board.decisions).toEqual([]);
  });

  it("keeps empty sections empty when a header has no bullets", () => {
    const { board } = parseSummaryBoard("SUMMARY\n- x\nDECISIONS\nACTION ITEMS\n- a → b");
    expect(board.decisions).toEqual([]);
    expect(board.actionItems).toEqual(["a → b"]);
  });

  it("preserves leading digits in content, stripping only ordered-list markers", () => {
    const { summary, board } = parseSummaryBoard(
      [
        "SUMMARY",
        "- 2026 budget approved",
        "DECISIONS",
        "1. Use stack rank",
        "2) Ship by Q3",
        "OPEN QUESTIONS",
        "- 3 hires by Q3?",
      ].join("\n"),
    );
    expect(summary).toEqual(["2026 budget approved"]);
    expect(board.decisions).toEqual(["Use stack rank", "Ship by Q3"]);
    expect(board.openQuestions).toEqual(["3 hires by Q3?"]);
  });
});

describe("buildReplyPrompt", () => {
  it("includes only the last N captions and the intent", () => {
    const captions = Array.from({ length: 20 }, (_, i) => `caption ${i}`);
    const { system, user } = buildReplyPrompt("push-back", captions, "English", 10);
    expect(user).toContain("caption 19");
    expect(user).toContain("caption 10");
    expect(user).not.toContain("caption 9");
    expect(user.toLowerCase()).toContain("push back");
    expect(system).toContain("English");
  });

  it("uses the full list when fewer than the window", () => {
    const { user } = buildReplyPrompt("ask", ["only one"], "한국어", 10);
    expect(user).toContain("only one");
  });
});

describe("buildSummaryBoardPrompt / buildQuickTranslatePrompt", () => {
  it("targets the requested summary language and embeds the transcript", () => {
    const { system, user } = buildSummaryBoardPrompt("the transcript", "한국어");
    expect(system).toContain("한국어");
    expect(user).toContain("the transcript");
    expect(user).toContain("ACTION ITEMS");
  });

  it("quick translate targets the meeting language", () => {
    const { system, user } = buildQuickTranslatePrompt("이거 다음 분기로 미루면 어때요?", "English");
    expect(system).toContain("English");
    expect(user).toBe("이거 다음 분기로 미루면 어때요?");
  });

  it("tells the model to keep section headers in English for a non-English board (#40)", () => {
    const { user } = buildSummaryBoardPrompt("transcript", "한국어");
    expect(user).toContain("keep the section headers");
    expect(user).toContain("English");
  });
});

describe("buildIncrementalSummaryBoardPrompt (#55)", () => {
  const previous = {
    summary: ["budget under pressure"],
    board: {
      decisions: ["use stack rank"],
      actionItems: ["Mike → apps list"],
      openQuestions: ["which MAU?"],
    },
  };

  it("feeds back the previous summary/board and ONLY the new delta — not the full transcript", () => {
    const { system, user } = buildIncrementalSummaryBoardPrompt(previous, "Them: new line here", "English");
    // The model is told to merge, not re-derive from scratch.
    expect(system).toMatch(/merge/i);
    // Prior state is present so the model can extend it.
    expect(user).toContain("budget under pressure");
    expect(user).toContain("use stack rank");
    expect(user).toContain("Mike → apps list");
    expect(user).toContain("which MAU?");
    // Only the delta transcript rides along — the caller never re-sends history.
    expect(user).toContain("Them: new line here");
    expect(user).toContain("New transcript since the last update:");
  });

  it("emits the same section headers the full prompt does, so parseSummaryBoard handles both", () => {
    const { user } = buildIncrementalSummaryBoardPrompt(previous, "delta", "한국어");
    for (const header of ["SUMMARY", "DECISIONS", "ACTION ITEMS", "OPEN QUESTIONS"]) {
      expect(user).toContain(header);
    }
    expect(user).toContain("keep the section headers");
  });

  it("renders an empty prior section as a placeholder rather than dropping the header", () => {
    const { user } = buildIncrementalSummaryBoardPrompt(
      { summary: [], board: { decisions: [], actionItems: [], openQuestions: [] } },
      "first delta",
      "English",
    );
    expect(user).toContain("(none)");
  });
});

describe("parseSummaryBoard — Korean-localized headers (#40)", () => {
  it("parses a board whose section headers were localized to Korean", () => {
    const text = [
      "요약",
      "- 예산 논의",
      "결정 사항",
      "- 스택 랭크 사용",
      "실행 항목",
      "- 마이크 → 앱 목록 공유",
      "미해결 질문",
      "- MAU 정의는?",
    ].join("\n");
    const { summary, board } = parseSummaryBoard(text);
    expect(summary).toEqual(["예산 논의"]);
    expect(board.decisions).toEqual(["스택 랭크 사용"]);
    expect(board.actionItems).toEqual(["마이크 → 앱 목록 공유"]);
    expect(board.openQuestions).toEqual(["MAU 정의는?"]);
  });

  it("still parses English headers (EN output) unchanged", () => {
    const { summary, board } = parseSummaryBoard("SUMMARY\n- a\nDECISIONS\n- b");
    expect(summary).toEqual(["a"]);
    expect(board.decisions).toEqual(["b"]);
  });
});
