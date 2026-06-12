import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { SessionArchiveWriter } from "../src/writer";
import { renderDocument } from "../src/render";
import type { CaptionEntry, FinalBrief, SessionMeta } from "../src/types";
import { FakeFs } from "./helpers/fake-fs";

const META: SessionMeta = {
  fileNamePrefix: "2026-06-11 1045",
  headerDate: "2026-06-11",
  startClock: "10:45",
  sourceLang: "EN",
  targetLang: "KO",
  engineName: "Claude CLI",
};

const ENTRIES: CaptionEntry[] = [
  { speaker: "them", timestamp: "10:45", source: "Pat, thanks a lot.", target: "Pat, 정말 고마워요." },
  {
    speaker: "me",
    timestamp: "10:45",
    source: "I agree, but I'm a bit worried about the budget.",
    target: "동의하지만 예산이 조금 걱정돼요.",
  },
  {
    speaker: "them",
    timestamp: "10:46",
    pinned: true,
    source: "…treat it as a stack rank rather than a raw excitement level.",
    target: "단순 흥미도가 아니라 스택 랭킹으로 취급하자는 것.",
  },
];

const FINAL: FinalBrief = {
  title: "Stack-rank scoring discussion",
  summary: [
    "Stack-rank vs raw excitement scoring for feature voting",
    "Budget concern raised on contractor expansion",
  ],
  board: {
    decisions: ["Use stack rank, not raw excitement scores"],
    actionItems: ["Mike: share apps list", "Me: budget memo by Fri"],
    openQuestions: ["Which MAU definition wins?"],
  },
  endClock: "11:32",
  durationMin: 47,
  costUsd: 0.31,
};

describe("SessionArchiveWriter — golden file (PROPOSAL §8.9)", () => {
  it("produces exactly the §8.9 format", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: "/data/LiveCap", meta: META });
    writer.open();
    for (const entry of ENTRIES) writer.appendCaption(entry);
    const finalPath = writer.finalize(FINAL);

    expect(finalPath).toBe("/data/LiveCap/2026-06-11 1045 — Stack-rank scoring discussion.md");

    const golden = readFileSync(new URL("./golden/stack-rank-session.md", import.meta.url), "utf8");
    expect(fs.readFile(finalPath)).toBe(golden);
  });

  it("reaches the same bytes whether built by appends or one full render", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: "/data/LiveCap", meta: META });
    writer.open();
    for (const entry of ENTRIES) writer.appendCaption(entry);
    const appendBuilt = fs.readFile(writer.path);

    const expected = renderDocument({
      title: "(recording)",
      headerDate: META.headerDate,
      startClock: META.startClock,
      endClock: META.startClock,
      durationMin: 0,
      sourceLang: META.sourceLang,
      targetLang: META.targetLang,
      engineName: META.engineName,
      costUsd: 0,
      summary: [],
      board: { decisions: [], actionItems: [], openQuestions: [] },
      entries: ENTRIES,
    });
    expect(appendBuilt).toBe(expected);
  });
});
