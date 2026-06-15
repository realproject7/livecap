import { describe, expect, it } from "vitest";

import {
  nextSettingsForSessionLanguage,
  nextSettingsForSessionSourceLanguage,
  type AppSettings,
} from "../src/app-settings";

// #2: the target language is chosen/confirmed per session at Start; the pick is
// persisted so it becomes the DEFAULT for the next session (not a global the
// session ignores). These cover the pure decision the Start flow makes before
// it calls session_start.

const base: AppSettings = {
  onboardingComplete: true,
  engine: "cli",
  targetLanguage: "ko",
  sourceLanguage: "auto",
  poolUsd: 20,
  resetDay: 1,
  autoSwitch: true,
  captionSize: "m",
  archiveAutoSave: true,
  archiveFolder: null,
  archiveRetentionDays: 0,
  captureSystem: true,
  captureMic: true,
};

describe("nextSettingsForSessionLanguage (#2 per-session target)", () => {
  it("persists a NEW pick as the next session's default", () => {
    const next = nextSettingsForSessionLanguage(base, "ja");
    expect(next).not.toBeNull();
    expect(next?.targetLanguage).toBe("ja");
    // Only the language changes — every other setting is carried through.
    expect(next).toEqual({ ...base, targetLanguage: "ja" });
  });

  it("returns null when the pick matches the remembered default (no redundant write)", () => {
    expect(nextSettingsForSessionLanguage(base, "ko")).toBeNull();
  });

  it("normalizes the tag (trim + lowercase) before comparing, like the Rust sanitizer", () => {
    // An equivalent but differently-cased tag is NOT a change.
    expect(nextSettingsForSessionLanguage(base, "  KO ")).toBeNull();
    // A real change is normalized on the way out.
    const next = nextSettingsForSessionLanguage(base, "  PT-BR ");
    expect(next?.targetLanguage).toBe("pt-br");
  });

  it("treats an empty pick as no change (guards a cleared picker)", () => {
    expect(nextSettingsForSessionLanguage(base, "")).toBeNull();
    expect(nextSettingsForSessionLanguage(base, "   ")).toBeNull();
  });

  it("an arbitrary BCP-47 pick rides through unchanged (any tag is a valid target)", () => {
    const next = nextSettingsForSessionLanguage(base, "nb-NO");
    expect(next?.targetLanguage).toBe("nb-no");
  });
});

describe("nextSettingsForSessionSourceLanguage (#94 per-session spoken language)", () => {
  it("persists a NEW spoken-language pick as the next session's default", () => {
    const next = nextSettingsForSessionSourceLanguage(base, "en");
    expect(next).not.toBeNull();
    expect(next?.sourceLanguage).toBe("en");
    // Only the source language changes — every other setting is carried through.
    expect(next).toEqual({ ...base, sourceLanguage: "en" });
  });

  it("returns null when the pick matches the remembered default (no redundant write)", () => {
    expect(nextSettingsForSessionSourceLanguage(base, "auto")).toBeNull();
  });

  it("normalizes the tag (trim + lowercase), like the Rust sanitizer", () => {
    expect(nextSettingsForSessionSourceLanguage(base, "  AUTO ")).toBeNull();
    const next = nextSettingsForSessionSourceLanguage(base, "  EN ");
    expect(next?.sourceLanguage).toBe("en");
  });

  it("clamps an empty pick to 'auto' (so a cleared picker keeps auto-detect)", () => {
    // From an EN default, clearing the picker reverts to auto.
    const fromEn: AppSettings = { ...base, sourceLanguage: "en" };
    const next = nextSettingsForSessionSourceLanguage(fromEn, "");
    expect(next?.sourceLanguage).toBe("auto");
    // Already auto + empty pick → no write.
    expect(nextSettingsForSessionSourceLanguage(base, "")).toBeNull();
  });
});
