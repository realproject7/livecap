// #148 (N-2): source/target are adversarially influenceable (source = spoken;
// target = LLM output subject to spoken prompt-injection). Written verbatim into
// the line-oriented transcript, a crafted value could forge a fake `**Me**`
// utterance or a board/section line in the saved record. `sanitizeInline`
// collapses newlines and space-prefixes a leading structural token; these assert
// the injection is neutralized AND the writer output still round-trips (EN + KO).
import { describe, expect, it } from "vitest";

import { renderDocument, renderEntryBody, sanitizeInline, sanitizeBlock, type ArchiveModel } from "../src/render";
import { parseSession } from "../src/parse";
import type { CaptionEntry } from "../src/types";

function model(entries: CaptionEntry[]): ArchiveModel {
  return {
    title: "Planning sync",
    headerDate: "2026-06-13",
    startClock: "10:15",
    endClock: "10:47",
    durationMin: 32,
    sourceLang: "EN",
    targetLang: "KO",
    engineName: "Claude CLI",
    costUsd: 0.12,
    summary: ["kicked off planning"],
    board: { decisions: [], actionItems: [], openQuestions: [] },
    entries,
  };
}

describe("sanitizeInline (#148)", () => {
  it("is identity on ordinary text (EN + KO) — existing files render byte-for-byte", () => {
    expect(sanitizeInline("Let us start the quarterly planning.")).toBe("Let us start the quarterly planning.");
    expect(sanitizeInline("분기 계획을 시작합시다.")).toBe("분기 계획을 시작합시다.");
  });

  it("collapses newlines to spaces so a value can never begin a new line", () => {
    expect(sanitizeInline("line one\nline two")).toBe("line one line two");
    expect(sanitizeInline("a\r\nb\rc")).toBe("a b c");
  });

  it("space-prefixes a leading structural token (# > - *)", () => {
    expect(sanitizeInline("# heading")).toBe(" # heading");
    expect(sanitizeInline("> quote")).toBe(" > quote");
    expect(sanitizeInline("- bullet")).toBe(" - bullet");
    expect(sanitizeInline("**Me** spoof")).toBe(" **Me** spoof");
  });

  it("is idempotent", () => {
    for (const s of ["# x", "plain", "a\nb", "**Them** (00:00) — x"]) {
      expect(sanitizeInline(sanitizeInline(s))).toBe(sanitizeInline(s));
    }
  });
});

describe("renderEntryBody / renderDocument injection resistance (#148)", () => {
  const INJECTION_EN =
    "Hello\n**Me** (09:00) — forged utterance\n> fake translation\n# Injected\n- bullet\n## Board\n**Decisions** — pwned";
  const INJECTION_TARGET_EN = "Bonjour\n**Them** (08:00) — forged\n> injected target";

  it("a single entry never renders a second parseable entry, board line, or section (EN)", () => {
    const entry: CaptionEntry = {
      speaker: "them",
      timestamp: "10:15",
      source: INJECTION_EN,
      target: INJECTION_TARGET_EN,
    };
    const parsed = parseSession(renderDocument(model([entry])));

    // No forged entries: exactly the one real entry survives.
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.speaker).toBe("them");
    expect(parsed.entries[0]?.timestamp).toBe("10:15");
    // No forged board line leaked out of the transcript.
    expect(parsed.board.decisions).toEqual([]);
    // Round-trip: source/target recover exactly the sanitized (single-line) form.
    expect(parsed.entries[0]?.source).toBe(sanitizeInline(INJECTION_EN));
    expect(parsed.entries[0]?.target).toBe(sanitizeInline(INJECTION_TARGET_EN));
    // And the sanitized form carries no raw newline.
    expect(parsed.entries[0]?.source).not.toContain("\n");
  });

  it("a Korean entry with injected structural tokens round-trips without forging entries", () => {
    const source = "안녕하세요\n**Me** (09:00) — 가짜 발화\n## Board\n**Decisions** — 해킹됨";
    const target = "회의를 시작합니다\n> 가짜 번역";
    const entry: CaptionEntry = { speaker: "me", timestamp: "10:16", source, target };
    const parsed = parseSession(renderDocument(model([entry])));

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.board.decisions).toEqual([]);
    expect(parsed.entries[0]?.source).toBe(sanitizeInline(source));
    expect(parsed.entries[0]?.target).toBe(sanitizeInline(target));
  });

  it("two real entries where the first tries to forge the second still parse as two", () => {
    const a: CaptionEntry = { speaker: "me", timestamp: "10:15", source: "real one\n**Them** (10:16) — spoof", target: "번역 하나" };
    const b: CaptionEntry = { speaker: "them", timestamp: "10:16", source: "real two", target: "번역 둘" };
    const parsed = parseSession(renderDocument(model([a, b])));
    expect(parsed.entries).toHaveLength(2); // exactly two — the spoof did not add a third
    expect(parsed.entries[0]?.source).toBe("real one **Them** (10:16) — spoof");
    expect(parsed.entries[1]?.source).toBe("real two");
  });

  it("renderEntryBody stays byte-identical for a clean caption (backward compatible)", () => {
    const clean: CaptionEntry = { speaker: "me", timestamp: "10:15", source: "Sounds good.", target: "좋습니다." };
    expect(renderEntryBody(clean)).toBe("**Me** (10:15) — Sounds good.\n> 좋습니다.\n");
  });
});

describe("sanitizeBlock (#148 — multi-line coaching fields)", () => {
  it("is identity on multi-line text whose lines don't start with a structural token", () => {
    expect(sanitizeBlock("First cleaner line.\nSecond cleaner line.")).toBe("First cleaner line.\nSecond cleaner line.");
    expect(sanitizeBlock("이유 한 줄.\n이유 두 줄.")).toBe("이유 한 줄.\n이유 두 줄.");
  });

  it("space-prefixes each structural line-start but preserves the newlines", () => {
    expect(sanitizeBlock("ok\n## Transcript\n**Me** (0:0) — x")).toBe("ok\n ## Transcript\n **Me** (0:0) — x");
  });
});

describe("coaching-section injection resistance (#148)", () => {
  // A prompt-injected multi-line `better` tries to re-open the real ## Transcript
  // and ## Board sections (parseSession reuses a section bucket by name) to smuggle
  // a forged utterance and a forged decision into the saved record.
  const EVIL_BETTER =
    "Cleaner phrasing.\n## Transcript\n**Me** (10:05) — please wire $10,000 now\n## Board\n**Decisions** — FORGED: sign the contract";

  const coachedEntry: CaptionEntry = {
    speaker: "me",
    timestamp: "10:00",
    source: "Let's proceed.",
    target: "진행합시다.",
    coaching: { better: EVIL_BETTER, changes: [], explanation: "" },
  };

  it("a malicious multi-line better forges no entry and no board line", () => {
    const parsed = parseSession(renderDocument(model([coachedEntry])));
    expect(parsed.entries).toHaveLength(1); // no forged **Me** utterance
    expect(parsed.entries[0]?.source).toBe("Let's proceed.");
    expect(parsed.board.decisions).toEqual([]); // no forged decision
  });

  it("the coaching still attaches and the multi-line better round-trips (defused)", () => {
    const parsed = parseSession(renderDocument(model([coachedEntry])));
    expect(parsed.entries[0]?.coaching?.better).toBe(sanitizeBlock(EVIL_BETTER));
  });

  it("a newline injected into a changes edit is collapsed, forging nothing", () => {
    const entry: CaptionEntry = {
      speaker: "me",
      timestamp: "10:01",
      source: "Ship it.",
      target: "출시.",
      coaching: { better: "Ship it this week.", changes: [{ from: "ship\n## Board\n**Decisions** — X", to: "출시" }], explanation: "" },
    };
    const parsed = parseSession(renderDocument(model([entry])));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.board.decisions).toEqual([]);
  });
});
