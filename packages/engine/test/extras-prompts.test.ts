import { describe, it, expect } from "vitest";

import {
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
});
