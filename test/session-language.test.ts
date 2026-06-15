import { describe, expect, it } from "vitest";

import { nextSettingsForSessionLanguage, type AppSettings } from "../src/app-settings";

// #2: the target language is chosen/confirmed per session at Start; the pick is
// persisted so it becomes the DEFAULT for the next session (not a global the
// session ignores). These cover the pure decision the Start flow makes before
// it calls session_start.

const base: AppSettings = {
  onboardingComplete: true,
  engine: "cli",
  targetLanguage: "ko",
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
