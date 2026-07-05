// #113: persisting coaching rewrites into the session file. Drives the REAL
// SessionArchiveWriter (through the in-memory FakeFs), so render → parse
// round-trips are verified against the exact bytes the writer emits, and the
// amend-after-finalize path is exercised end-to-end. Covers EN + KO content,
// byte-identical amend, backward compatibility, occurrence disambiguation, and
// CJK safety.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { parseSession } from "../src/parse";
import { renderCoaching } from "../src/render";
import { SessionArchiveWriter } from "../src/writer";
import type { CaptionEntry, CoachingData, FinalBrief, SessionMeta } from "../src/types";
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
  { speaker: "me", timestamp: "10:45", source: "So I'm, uh, I goed to the store", target: "그래서 저는 가게에 갔어요" },
  {
    speaker: "them",
    timestamp: "10:46",
    pinned: true,
    source: "…treat it as a stack rank.",
    target: "스택 랭킹으로 취급.",
  },
  { speaker: "me", timestamp: "10:47", source: "we should um ship the feature", target: "우리는 기능을 출시해야 합니다" },
];

const FINAL: FinalBrief = {
  title: "Stack-rank scoring discussion",
  summary: ["Stack-rank vs raw excitement scoring", "Budget concern on contractor expansion"],
  board: {
    decisions: ["Use stack rank, not raw excitement scores"],
    actionItems: ["Mike: share apps list", "Me: budget memo by Fri"],
    openQuestions: ["Which MAU definition wins?"],
  },
  endClock: "11:32",
  durationMin: 47,
  costUsd: 0.31,
  metrics: { talkRatioMic: 0.39, smoothScore: 82 },
};

/** Open → append entries → finalize; return the writer + its final file path. */
function finalizedWriter(entries: CaptionEntry[] = ENTRIES): {
  fs: FakeFs;
  writer: SessionArchiveWriter;
  path: string;
} {
  const fs = new FakeFs();
  const writer = new SessionArchiveWriter({ fs, folder: "/archive", meta: META });
  writer.open();
  for (const e of entries) writer.appendCaption(e);
  const path = writer.finalize(FINAL);
  return { fs, writer, path };
}

describe("coaching persistence (#113) — render → parse round-trip", () => {
  it("round-trips EN + KO coaching data to deep-equal via the real writer", async () => {
    const { fs, writer, path } = finalizedWriter();
    const enCoaching: CoachingData = {
      better: "I went to the store.",
      changes: [{ from: "goed", to: "went" }],
      explanation: '"goed" is not a word — the past tense of "go" is "went".',
    };
    const koCoaching: CoachingData = {
      better: "우리는 이번 주에 기능을 출시해야 합니다.",
      changes: [{ from: "um ship", to: "출시" }],
      explanation: "군더더기 표현을 없애고 문장을 다듬었습니다.",
    };
    await writer.amendCoaching([
      { timestamp: "10:45", occurrence: 1, coaching: enCoaching },
      { timestamp: "10:47", occurrence: 1, coaching: koCoaching },
    ]);

    const parsed = parseSession(fs.files.get(path) as string);
    // Coaching lands on the matching me-entries, nowhere else.
    expect(parsed.entries[1]?.coaching).toEqual(enCoaching);
    expect(parsed.entries[3]?.coaching).toEqual(koCoaching);
    expect(parsed.entries[0]?.coaching).toBeUndefined(); // a "them" entry
    expect(parsed.entries[2]?.coaching).toBeUndefined();
  });

  it("omits empty changes / explanation and round-trips them to defaults", async () => {
    const { fs, writer, path } = finalizedWriter();
    const coaching: CoachingData = { better: "A cleaner sentence.", changes: [], explanation: "" };
    await writer.amendCoaching([{ timestamp: "10:45", occurrence: 1, coaching }]);
    const file = fs.files.get(path) as string;
    // Only a Better line is rendered for this entry (no Changes/Explanation).
    expect(file).toContain("**Better:** A cleaner sentence.");
    expect(file).not.toContain("**Changes:**\n");
    expect(parseSession(file).entries[1]?.coaching).toEqual(coaching);
  });

  it("round-trips multi-line better and explanation", async () => {
    const { fs, writer, path } = finalizedWriter();
    const coaching: CoachingData = {
      better: "First cleaner line.\nSecond cleaner line.",
      changes: [{ from: "a", to: "b" }],
      explanation: "Reason line one.\nReason line two.",
    };
    await writer.amendCoaching([{ timestamp: "10:45", occurrence: 1, coaching }]);
    expect(parseSession(fs.files.get(path) as string).entries[1]?.coaching).toEqual(coaching);
  });
});

describe("coaching persistence (#113) — amend after finalize", () => {
  it("keeps every non-coaching section byte-identical (append-only)", async () => {
    const { fs, writer, path } = finalizedWriter();
    const before = fs.files.get(path) as string;

    await writer.amendCoaching([
      {
        timestamp: "10:45",
        occurrence: 1,
        coaching: { better: "I went to the store.", changes: [{ from: "goed", to: "went" }], explanation: "past tense" },
      },
    ]);
    const after = fs.files.get(path) as string;

    // The original document is an exact prefix; only a trailing Coaching section is added.
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      "\n## Coaching\n\n### (10:45 · 1) — So I'm, uh, I goed to the store\n" +
        "**Better:** I went to the store.\n**Changes:** goed => went\n**Explanation:** past tense\n",
    );

    // Everything except coaching parses identically before vs after.
    const p0 = parseSession(before);
    const p1 = parseSession(after);
    const stripCoaching = (e: CaptionEntry) => {
      const { coaching, ...rest } = e;
      void coaching;
      return rest;
    };
    expect({ ...p1, entries: p1.entries.map(stripCoaching) }).toEqual({
      ...p0,
      entries: p0.entries.map(stripCoaching),
    });
  });

  it("writes atomically via a temp file + rename (no .tmp left behind)", async () => {
    const { fs, writer, path } = finalizedWriter();
    await writer.amendCoaching([
      { timestamp: "10:47", occurrence: 1, coaching: { better: "Ship it this week.", changes: [], explanation: "" } },
    ]);
    expect(fs.files.has(`${path}.tmp`)).toBe(false);
    expect(fs.files.has(path)).toBe(true);
  });

  it("throws if amendCoaching is called before finalize", () => {
    const fs = new FakeFs();
    const writer = new SessionArchiveWriter({ fs, folder: "/archive", meta: META });
    writer.open();
    writer.appendCaption(ENTRIES[1] as CaptionEntry);
    expect(() =>
      writer.amendCoaching([{ timestamp: "10:45", occurrence: 1, coaching: { better: "x", changes: [], explanation: "" } }]),
    ).toThrow(/not finalized/);
  });

  it("ignores updates that match no entry (never throws)", async () => {
    const { fs, writer, path } = finalizedWriter();
    const before = fs.files.get(path) as string;
    await writer.amendCoaching([
      { timestamp: "23:59", occurrence: 9, coaching: { better: "orphan", changes: [], explanation: "" } },
    ]);
    // No matching me-entry → no Coaching section, file unchanged.
    expect(fs.files.get(path)).toBe(before);
  });
});

describe("coaching persistence (#113) — occurrence disambiguation", () => {
  it("keys duplicate-timestamp me-entries by 1-based occurrence", async () => {
    const dupes: CaptionEntry[] = [
      { speaker: "me", timestamp: "10:45", source: "first at 10:45", target: "첫 번째" },
      { speaker: "them", timestamp: "10:45", source: "them speaking", target: "상대방" },
      { speaker: "me", timestamp: "10:45", source: "second at 10:45", target: "두 번째" },
    ];
    const { fs, writer, path } = finalizedWriter(dupes);
    await writer.amendCoaching([
      { timestamp: "10:45", occurrence: 1, coaching: { better: "First rewrite.", changes: [], explanation: "" } },
      { timestamp: "10:45", occurrence: 2, coaching: { better: "Second rewrite.", changes: [], explanation: "" } },
    ]);
    const file = fs.files.get(path) as string;
    expect(file).toContain("### (10:45 · 1) — first at 10:45");
    expect(file).toContain("### (10:45 · 2) — second at 10:45");
    const parsed = parseSession(file);
    expect(parsed.entries[0]?.coaching?.better).toBe("First rewrite."); // me #1
    expect(parsed.entries[1]?.coaching).toBeUndefined(); // the "them" line between
    expect(parsed.entries[2]?.coaching?.better).toBe("Second rewrite."); // me #2
  });
});

describe("coaching persistence (#113) — backward compatibility", () => {
  it("a file without a ## Coaching section parses exactly as before", () => {
    const { fs, path } = finalizedWriter();
    const file = fs.files.get(path) as string;
    expect(file).not.toContain("## Coaching");
    const parsed = parseSession(file);
    // No coaching anywhere; the rest is intact.
    expect(parsed.entries.every((e) => e.coaching === undefined)).toBe(true);
    expect(parsed.entries[1]).toEqual({
      speaker: "me",
      timestamp: "10:45",
      source: "So I'm, uh, I goed to the store",
      target: "그래서 저는 가게에 갔어요",
    });
    expect(parsed.summary).toEqual(FINAL.summary);
  });

  it("renderCoaching returns '' for a coaching-free model (byte-identical documents)", () => {
    expect(renderCoaching(ENTRIES)).toBe("");
  });
});

describe("coaching persistence (#113) — source hygiene", () => {
  it("keeps the coaching source files plain text (no NUL / control bytes in keys)", () => {
    // Regression guard (RE1): the (timestamp, occurrence) key must be text-safe —
    // an embedded NUL once turned parse.ts into a binary, un-reviewable file.
    for (const rel of ["../src/parse.ts", "../src/writer.ts", "../src/render.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      // No control chars except tab / newline / carriage return (\t \n \r).
      // eslint-disable-next-line no-control-regex
      expect(src).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    }
  });
});

describe("coaching persistence (#113) — CJK safety", () => {
  it("round-trips multibyte KO content in every coaching field without corruption", async () => {
    const { fs, writer, path } = finalizedWriter();
    const coaching: CoachingData = {
      better: "저는 어제 가게에 갔습니다. 정말 즐거운 하루였어요! 😀",
      changes: [
        { from: "갔어요", to: "갔습니다" },
        { from: "음", to: "(삭제)" },
      ],
      explanation: "격식체로 바꾸고 군더더기(“음”)를 제거했습니다 — 더 명확합니다.",
    };
    await writer.amendCoaching([{ timestamp: "10:47", occurrence: 1, coaching }]);
    // Deep-equal proves no byte-cap truncation / surrogate splitting (#32 lesson).
    expect(parseSession(fs.files.get(path) as string).entries[3]?.coaching).toEqual(coaching);
  });
});
