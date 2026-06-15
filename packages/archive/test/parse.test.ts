// #98 parser tests. The load-bearing one ROUND-TRIPS the real SessionArchiveWriter
// output (not a hand-typed string), so the parser is verified against the exact
// bytes render.ts emits. Plus golden-file parse, in-progress handling, marker
// round-trips, and malformed/empty robustness (never throws, never NaN).

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseSession } from "../src/parse";
import { SessionArchiveWriter } from "../src/writer";
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
  metrics: { talkRatioMic: 0.39, smoothScore: 83 },
};

/** Build a finalized session via the real writer; return its on-disk Markdown. */
function writeSession(meta: SessionMeta, entries: CaptionEntry[], final: FinalBrief): string {
  const fs = new FakeFs();
  const writer = new SessionArchiveWriter({ fs, folder: "/data/LiveCap", meta });
  writer.open();
  for (const entry of entries) writer.appendCaption(entry);
  const finalPath = writer.finalize(final);
  return fs.readFile(finalPath);
}

describe("parseSession — round-trips the real writer output", () => {
  it("recovers meta, summary, board, metrics, and entries from a finalized session", () => {
    const md = writeSession(META, ENTRIES, FINAL);
    const parsed = parseSession(md);

    expect(parsed.meta).toEqual({
      title: "Stack-rank scoring discussion",
      headerDate: "2026-06-11",
      startClock: "10:45",
      endClock: "11:32",
      durationMin: 47,
      sourceLang: "EN",
      targetLang: "KO",
      engineName: "Claude CLI",
      costUsd: 0.31,
    });
    expect(parsed.isRecording).toBe(false);
    expect(parsed.summary).toEqual(FINAL.summary);
    expect(parsed.board).toEqual(FINAL.board);
    // Talk ratio survives only at the writer's whole-percent precision (0.39 → 39%).
    expect(parsed.metrics).toEqual({ talkRatioMic: 0.39, smoothScore: 83 });
    expect(parsed.entries).toEqual(ENTRIES);
  });

  it("round-trips the pinned + low-confidence markers exactly", () => {
    const entries: CaptionEntry[] = [
      { speaker: "me", timestamp: "09:00", source: "maybe we ship", target: "아마 출시", lowConfidence: true },
      { speaker: "them", timestamp: "09:01", source: "pinned point", target: "고정된 점", pinned: true },
      {
        speaker: "me",
        timestamp: "09:02",
        source: "both markers",
        target: "둘 다",
        pinned: true,
        lowConfidence: true,
      },
    ];
    const md = writeSession(META, entries, FINAL);
    const parsed = parseSession(md);
    expect(parsed.entries).toEqual(entries);
  });

  it("preserves a source line that itself contains an em-dash separator", () => {
    const entries: CaptionEntry[] = [
      { speaker: "them", timestamp: "09:00", source: "it works — mostly — for now", target: "대체로 작동" },
    ];
    const md = writeSession(META, entries, FINAL);
    const parsed = parseSession(md);
    expect(parsed.entries[0]?.source).toBe("it works — mostly — for now");
    expect(parsed.entries[0]?.target).toBe("대체로 작동");
  });

  it("captures the channel-config note (#53) when present", () => {
    const md = writeSession({ ...META, channels: "system audio only" }, ENTRIES, FINAL);
    const parsed = parseSession(md);
    expect(parsed.meta.channels).toBe("system audio only");
  });

  it("omits channels when both channels were on", () => {
    const parsed = parseSession(writeSession(META, ENTRIES, FINAL));
    expect(parsed.meta.channels).toBeUndefined();
  });
});

describe("parseSession — golden fixture", () => {
  it("parses the committed golden session file", () => {
    const golden = readFileSync(new URL("./golden/stack-rank-session.md", import.meta.url), "utf8");
    const parsed = parseSession(golden);
    expect(parsed.meta.title).toBe("Stack-rank scoring discussion");
    expect(parsed.meta.durationMin).toBe(47);
    expect(parsed.meta.costUsd).toBe(0.31);
    expect(parsed.metrics).toEqual({ talkRatioMic: 0.39, smoothScore: 83 });
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[2]?.pinned).toBe(true);
  });
});

describe("parseSession — in-progress working file", () => {
  it("flags the unfinalized recording and omits its Metrics", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: "/data/LiveCap", meta: META });
    writer.open();
    writer.appendCaption(ENTRIES[0] as CaptionEntry);
    const md = fs.readFile(writer.path);

    const parsed = parseSession(md);
    expect(parsed.isRecording).toBe(true);
    expect(parsed.meta.title).toBe("(recording)");
    expect(parsed.meta.durationMin).toBe(0);
    expect(parsed.meta.costUsd).toBe(0);
    expect(parsed.metrics).toBeUndefined();
    expect(parsed.summary).toEqual([]);
    expect(parsed.entries).toEqual([ENTRIES[0]]);
  });
});

describe("parseSession — malformed / empty robustness", () => {
  it("returns empty defaults for an empty document without throwing or NaN", () => {
    const parsed = parseSession("");
    expect(parsed.meta).toEqual({
      title: "",
      headerDate: "",
      startClock: "",
      endClock: "",
      durationMin: 0,
      sourceLang: "",
      targetLang: "",
      engineName: "",
      costUsd: 0,
    });
    expect(parsed.summary).toEqual([]);
    expect(parsed.board).toEqual({ decisions: [], actionItems: [], openQuestions: [] });
    expect(parsed.metrics).toBeUndefined();
    expect(parsed.entries).toEqual([]);
    expect(Number.isNaN(parsed.meta.durationMin)).toBe(false);
    expect(Number.isNaN(parsed.meta.costUsd)).toBe(false);
  });

  it("ignores junk lines and a garbled meta line, keeping numbers finite", () => {
    const parsed = parseSession("# Title only\n> not a valid meta line at all\n\nrandom junk\n");
    expect(parsed.meta.title).toBe("Title only");
    expect(parsed.meta.durationMin).toBe(0);
    expect(parsed.meta.costUsd).toBe(0);
    expect(parsed.entries).toEqual([]);
  });

  it("tolerates an entry header whose translation line is missing", () => {
    const md = "# t\n> 2026-01-01 09:00–09:01 (1 min) · EN → KO · engine: X ($0.00)\n\n## Transcript\n**Me** (09:00) — hi\n";
    const parsed = parseSession(md);
    expect(parsed.entries).toEqual([{ speaker: "me", timestamp: "09:00", source: "hi", target: "" }]);
  });
});
