import { describe, it, expect } from "vitest";

import {
  buildAnalyzeRespondPrompt,
  buildCoachPrompt,
  buildIncrementalSummaryBoardPrompt,
  buildQuickTranslatePrompt,
  buildReplyPrompt,
  buildSummaryBoardPrompt,
  parseAnalyzeRespond,
  parseCoachResult,
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

describe("buildAnalyzeRespondPrompt (#77)", () => {
  it("focuses on the target line, includes the bounded caption context, and names both languages", () => {
    const captions = Array.from({ length: 20 }, (_, i) => `caption ${i}`);
    const { user } = buildAnalyzeRespondPrompt(
      "How will you handle churn?",
      captions,
      "English", // meeting (reply) language
      "한국어", // analysis (target) language
      10,
    );
    // The clicked line is the focus.
    expect(user).toContain("How will you handle churn?");
    expect(user).toContain("The specific line to analyze and reply to:");
    // Two explicit, English-keyed sections.
    expect(user).toContain("ANALYSIS");
    expect(user).toContain("REPLY");
    // Languages assigned to the right sections: reply = meeting, analysis = target.
    expect(user).toContain("REPLY body in English");
    expect(user).toContain("ANALYSIS body in 한국어");
    // Headers stay English even with a non-English body.
    expect(user).toContain("keep the two section headers in English");
    // Only the last N captions ride along as context.
    expect(user).toContain("caption 19");
    expect(user).toContain("caption 10");
    expect(user).not.toContain("caption 9");
  });

  it("varying the languages swaps which language each section is written in (#12)", () => {
    const { user } = buildAnalyzeRespondPrompt("질문", [], "한국어", "English");
    expect(user).toContain("REPLY body in 한국어");
    expect(user).toContain("ANALYSIS body in English");
  });

  it("omits the context block entirely when there are no recent captions", () => {
    const { user } = buildAnalyzeRespondPrompt("standalone question", [], "English", "English");
    expect(user).not.toContain("Recent conversation for context");
    expect(user).toContain("standalone question");
  });
});

describe("parseAnalyzeRespond (#77)", () => {
  it("splits the two sections, preserving multi-line bodies", () => {
    const text = [
      "ANALYSIS",
      "They want concrete churn numbers.",
      "Acknowledge, then give your retention plan.",
      "REPLY",
      "Our 90-day churn is 4%, and here is how we drive it down.",
    ].join("\n");
    const { analysis, reply } = parseAnalyzeRespond(text);
    expect(analysis).toBe(
      "They want concrete churn numbers.\nAcknowledge, then give your retention plan.",
    );
    expect(reply).toBe("Our 90-day churn is 4%, and here is how we drive it down.");
  });

  it("tolerates header case / markdown markers and Korean header aliases (전략 / 답변)", () => {
    const text = ["## 전략", "핵심을 먼저 인정하세요.", "**답변:**", "좋은 질문입니다."].join("\n");
    const { analysis, reply } = parseAnalyzeRespond(text);
    expect(analysis).toBe("핵심을 먼저 인정하세요.");
    expect(reply).toBe("좋은 질문입니다.");
  });

  it("graceful fallback: only one section present leaves the other empty", () => {
    const onlyReply = parseAnalyzeRespond("REPLY\nSure, let's do that.");
    expect(onlyReply.analysis).toBe("");
    expect(onlyReply.reply).toBe("Sure, let's do that.");

    const onlyAnalysis = parseAnalyzeRespond("ANALYSIS\nThis is a pricing objection.");
    expect(onlyAnalysis.analysis).toBe("This is a pricing objection.");
    expect(onlyAnalysis.reply).toBe("");
  });

  it("graceful fallback: no recognized header → whole output becomes the reply", () => {
    const { analysis, reply } = parseAnalyzeRespond("Sure, happy to walk you through it.");
    expect(analysis).toBe("");
    expect(reply).toBe("Sure, happy to walk you through it.");
  });

  it("never throws on degenerate shapes", () => {
    expect(() => parseAnalyzeRespond("")).not.toThrow();
    expect(parseAnalyzeRespond("")).toEqual({ analysis: "", reply: "" });
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

describe("buildCoachPrompt (#79)", () => {
  it("routes the rewrite to the meeting language and the explanation to the target language", () => {
    const { system, user } = buildCoachPrompt("So I'm—I would aim to, uh, take out", "English", "한국어");
    expect(user).toContain("So I'm—I would aim to, uh, take out");
    expect(user).toContain("BETTER");
    expect(user).toContain("CHANGES");
    expect(user).toContain("EXPLANATION");
    expect(user).toContain("BETTER rewrite in English");
    expect(user).toContain("EXPLANATION in 한국어");
    expect(user).toContain("keep the three section headers in English");
    // Must not fabricate claims — only improve phrasing.
    expect(system).toMatch(/do not invent/i);
  });

  it("swaps both languages when they are reversed (#12)", () => {
    const { user } = buildCoachPrompt("음 그러니까 그게", "한국어", "English");
    expect(user).toContain("BETTER rewrite in 한국어");
    expect(user).toContain("EXPLANATION in English");
  });
});

describe("parseCoachResult (#79)", () => {
  it("parses better / changes (from => to) / explanation", () => {
    const text = [
      "BETTER",
      "I'd like to shift our personalization to real-time contextual curation.",
      "CHANGES",
      "take out—take our personalization => shift our personalization",
      "uh, from, uh => to",
      "EXPLANATION",
      "It removes the false starts and states the idea directly.",
    ].join("\n");
    const { better, changes, explanation } = parseCoachResult(text);
    expect(better).toBe(
      "I'd like to shift our personalization to real-time contextual curation.",
    );
    expect(changes).toEqual([
      { from: "take out—take our personalization", to: "shift our personalization" },
      { from: "uh, from, uh", to: "to" },
    ]);
    expect(explanation).toBe("It removes the false starts and states the idea directly.");
  });

  it("tolerates header aliases / markdown and Korean 해설, and arrow separators", () => {
    const text = ["## 개선", "더 명확한 문장입니다.", "수정", "- 음 => (삭제)", "**해설:**", "군더더기를 없앴습니다."].join("\n");
    const { better, changes, explanation } = parseCoachResult(text);
    expect(better).toBe("더 명확한 문장입니다.");
    expect(changes).toEqual([{ from: "음", to: "(삭제)" }]);
    expect(explanation).toBe("군더더기를 없앴습니다.");
  });

  it("skips malformed CHANGES lines (no separator / empty side) rather than half-capturing", () => {
    const text = ["BETTER", "Cleaner sentence.", "CHANGES", "this line has no arrow", "=> only a target", "from only =>"].join(
      "\n",
    );
    const { changes } = parseCoachResult(text);
    expect(changes).toEqual([]);
  });

  it("graceful fallback: a missing section is empty, not an error", () => {
    const onlyBetter = parseCoachResult("BETTER\nA tighter version.");
    expect(onlyBetter.better).toBe("A tighter version.");
    expect(onlyBetter.changes).toEqual([]);
    expect(onlyBetter.explanation).toBe("");
  });

  it("graceful fallback: no recognized header → the whole output is the rewrite", () => {
    const { better, changes, explanation } = parseCoachResult("Here is a cleaner version of that.");
    expect(better).toBe("Here is a cleaner version of that.");
    expect(changes).toEqual([]);
    expect(explanation).toBe("");
  });

  it("never throws on degenerate shapes", () => {
    expect(() => parseCoachResult("")).not.toThrow();
    expect(parseCoachResult("")).toEqual({ better: "", changes: [], explanation: "" });
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
