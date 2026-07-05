import { describe, expect, it } from "vitest";

import { sanitizedSttModel, STT_MODELS } from "../src/app-settings";

// #110: the Settings sheet exposes exactly three curated whisper models; the
// TS mirror must default to "small" for settings.json files that predate the
// field (and for anything the Rust sanitizer would reject).

describe("STT_MODELS (#110 curated picks)", () => {
  it("exposes exactly the three curated models, small first", () => {
    expect(STT_MODELS.map((m) => m.value)).toEqual(["small", "medium", "large-v3-turbo"]);
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
