import { describe, it, expect } from "vitest";

import { sanitizeTitle, archiveFileName, MAX_TITLE_LENGTH, FALLBACK_TITLE } from "../src/sanitize";

describe("sanitizeTitle — path traversal defense (SECURITY.md)", () => {
  it("strips forward and back slashes so the result is one segment", () => {
    expect(sanitizeTitle("../../etc/passwd")).not.toMatch(/[/\\]/);
    expect(sanitizeTitle("a/b\\c")).not.toMatch(/[/\\]/);
  });

  it("neutralizes absolute and relative traversal titles", () => {
    for (const evil of ["/etc/passwd", "../secret", "..\\..\\x", "./.ssh/id_rsa"]) {
      const safe = sanitizeTitle(evil);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
      expect(safe.startsWith(".")).toBe(false);
    }
  });

  it("strips unicode separator look-alikes", () => {
    // U+2044 fraction slash, U+2215 division slash, U+FF0F fullwidth slash
    const safe = sanitizeTitle("evil⁄∕／secret");
    expect(safe).not.toMatch(/[⁄∕／]/);
    expect(safe).toBe("evil secret");
  });

  it("removes control characters", () => {
    expect(sanitizeTitle("a\u0007bcd")).toBe("abcd");
  });

  it("never yields a bare dot name", () => {
    expect(sanitizeTitle(".")).toBe(FALLBACK_TITLE);
    expect(sanitizeTitle("..")).toBe(FALLBACK_TITLE);
    expect(sanitizeTitle("...")).toBe(FALLBACK_TITLE);
  });

  it("falls back when the title is empty after sanitizing", () => {
    expect(sanitizeTitle("")).toBe(FALLBACK_TITLE);
    expect(sanitizeTitle("   ")).toBe(FALLBACK_TITLE);
    expect(sanitizeTitle("///")).toBe(FALLBACK_TITLE);
  });

  it("caps length", () => {
    const safe = sanitizeTitle("x".repeat(500));
    expect(safe.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });

  it("strips bidi/format controls (filename spoofing)", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+200F RLM, U+2066 LRI
    expect(sanitizeTitle("a\u202eb\u200fc\u2066d")).toBe("abcd");
  });

  it("preserves ordinary unicode titles (e.g. Korean)", () => {
    expect(sanitizeTitle("주간 회의 요약")).toBe("주간 회의 요약");
  });
});

describe("archiveFileName", () => {
  it("composes a safe `<prefix> — <title>.md`", () => {
    expect(archiveFileName("2026-06-11 1045", "Weekly sync")).toBe(
      "2026-06-11 1045 — Weekly sync.md",
    );
    expect(archiveFileName("2026-06-11 1045", "../../etc/passwd")).not.toMatch(/[/\\]/);
  });
});
