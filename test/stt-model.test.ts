import { describe, expect, it } from "vitest";

import { sanitizedSttModel, STT_MODELS } from "../src/app-settings";

// #110: the Settings sheet exposes a curated set of whisper models; the TS
// mirror must default to "small" for settings.json files that predate the field
// (and for anything the Rust sanitizer would reject).
// #202 added the quantized turbo build and made it the fresh-install default —
// but NOT the fallback here, which still means "an existing install".

describe("STT_MODELS (#110 curated picks)", () => {
  it("exposes exactly the curated models, small first", () => {
    expect(STT_MODELS.map((m) => m.value)).toEqual([
      "small",
      "medium",
      "large-v3-turbo",
      "large-v3-turbo-q5_0",
    ]);
  });

  // #202: the picker copy is the only place a user sees what the download costs
  // before committing to it, so the size string is load-bearing, not decoration.
  it("shows the quantized turbo build at its real size", () => {
    const q5 = STT_MODELS.find((m) => m.value === "large-v3-turbo-q5_0");
    expect(q5?.size).toBe("~547 MB");
    expect(q5?.label).toBe("Large v3 Turbo (compact)");
  });

  it("carries a size hint for every option (shown in the picker copy)", () => {
    for (const m of STT_MODELS) {
      expect(m.size).toMatch(/^~[\d.]+ (MB|GB)$/);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });
});

describe("sanitizedSttModel (#110 default handling)", () => {
  it("keeps every curated pick as-is", () => {
    for (const m of STT_MODELS) {
      expect(sanitizedSttModel(m.value)).toBe(m.value);
    }
  });

  // #202 migration: this fallback deliberately does NOT follow the new
  // fresh-install default. Anything reaching here came off disk, so it is an
  // install that has run before and must not be moved to a 547 MB download it
  // never asked for.
  it("defaults to small when the field is absent (old settings.json)", () => {
    expect(sanitizedSttModel(undefined)).toBe("small");
    expect(sanitizedSttModel(null)).toBe("small");
    expect(sanitizedSttModel("")).toBe("small");
  });

  it("clamps unknown / non-curated values to small (mirrors the Rust sanitizer)", () => {
    expect(sanitizedSttModel("tiny")).toBe("small"); // valid MODEL_NAME, not curated
    expect(sanitizedSttModel("large-v9")).toBe("small");
    expect(sanitizedSttModel("SMALL")).toBe("small"); // exact match only
  });
});
