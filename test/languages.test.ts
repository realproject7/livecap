// #12: target-language registry — the single source for prompt names,
// picker labels, and archive header labels.

import { describe, expect, it } from "vitest";

import { DEFAULT_LANGUAGE_CODE, LANGUAGES, languageByCode } from "../src/languages";

describe("languageByCode", () => {
  it("resolves the supported minimum (EN, KO) with KO as the default", () => {
    expect(DEFAULT_LANGUAGE_CODE).toBe("ko");
    expect(languageByCode("ko")).toMatchObject({ name: "Korean", native: "한국어", archiveLabel: "KO" });
    expect(languageByCode("en")).toMatchObject({ name: "English", archiveLabel: "EN" });
  });

  it("normalizes case and whitespace", () => {
    expect(languageByCode("  KO ")).toMatchObject({ code: "ko", name: "Korean" });
    expect(languageByCode("ZH-Hans")).toMatchObject({ name: "Simplified Chinese", archiveLabel: "ZH" });
  });

  it("passes arbitrary BCP-47 tags through (no dead end for unknown tags)", () => {
    const resolved = languageByCode("nl-BE");
    expect(resolved.code).toBe("nl-be");
    expect(resolved.name).toBe("nl-be"); // tag itself reaches the prompt
    expect(resolved.archiveLabel).toBe("NL"); // primary subtag labels the archive
  });

  it("falls back to the default for an empty tag", () => {
    expect(languageByCode("")).toMatchObject({ code: "ko", name: "Korean" });
  });

  it("keeps picker entries unique by code", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
