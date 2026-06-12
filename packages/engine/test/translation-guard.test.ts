import { describe, it, expect } from "vitest";

import { stripNonTranslation } from "../src/translation-guard";

describe("stripNonTranslation — small-model commentary guard (#6)", () => {
  it("drops a leading 'Here is the translation:' preamble line", () => {
    expect(stripNonTranslation("Here is the translation:\n안녕하세요", 1)).toBe("안녕하세요");
  });

  it("strips an inline 'Translation:' label", () => {
    expect(stripNonTranslation("Translation: 안녕하세요", 1)).toBe("안녕하세요");
  });

  it("removes wrapping quotes", () => {
    expect(stripNonTranslation('"안녕하세요"', 1)).toBe("안녕하세요");
    expect(stripNonTranslation("“안녕하세요”", 1)).toBe("안녕하세요");
  });

  it("unwraps a code fence", () => {
    expect(stripNonTranslation("```\n안녕하세요\n```", 1)).toBe("안녕하세요");
  });

  it("drops a trailing parenthetical note", () => {
    expect(stripNonTranslation("안녕하세요\n(Note: casual register)", 1)).toBe("안녕하세요");
  });

  it("keeps exactly one line per input sentence and drops trailing commentary", () => {
    const raw = "첫 번째 문장.\n두 번째 문장.\nNote: I kept the tone formal.";
    expect(stripNonTranslation(raw, 2)).toBe("첫 번째 문장.\n두 번째 문장.");
  });

  it("returns empty string when nothing translatable remains", () => {
    expect(stripNonTranslation("", 1)).toBe("");
    expect(stripNonTranslation("Sure! Here you go:", 1)).toBe("");
  });

  it("passes through clean output unchanged", () => {
    expect(stripNonTranslation("안녕하세요, 잘 지내세요?", 1)).toBe("안녕하세요, 잘 지내세요?");
  });
});
