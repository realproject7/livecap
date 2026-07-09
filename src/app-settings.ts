// Webview mirror of the Rust AppSettings (src-tauri/src/settings.rs) plus
// small pure helpers shared by onboarding and the Settings sheet (#12).

export type EnginePref = "cli" | "local";
export type CaptionSize = "s" | "m" | "l";
/** What the one-line Capsule shows (#97). */
export type CapsuleContent = "caption" | "translation" | "both";

export interface AppSettings {
  onboardingComplete: boolean;
  engine: EnginePref;
  targetLanguage: string;
  /** Spoken/source language for transcription (#94): a BCP-47 / ISO-639-1 tag
   *  forces whisper to that language; "auto" keeps per-utterance detection. */
  sourceLanguage: string;
  /** Whisper STT model (#110): "small" | "medium" | "large-v3-turbo".
   *  Downloaded on first use at session start; applies to the next session. */
  sttModel: string;
  poolUsd: number;
  resetDay: number;
  autoSwitch: boolean;
  captionSize: CaptionSize;
  /** Capsule (one-line pill) content choice (#97). */
  capsuleContent: CapsuleContent;
  archiveAutoSave: boolean;
  archiveFolder: string | null;
  archiveRetentionDays: number;
  /** Channels group (#53): per-channel capture toggles, applied at session
   *  start. The Rust side sanitizes so at least one stays on. */
  captureSystem: boolean;
  captureMic: boolean;
}

/** Curated whisper model picks (#110); values mirror the Rust sanitizer's
 *  STT_MODELS. Size hints show in the Settings sheet copy. */
export const STT_MODELS: { value: string; label: string; size: string; note?: string }[] = [
  { value: "small", label: "Small", size: "~466 MB" },
  // #141: de-emphasize Medium — Large v3 Turbo is the same encoder class with a
  // lighter decoder, so it is faster AND more accurate at a similar size. The
  // note (kept out of `size`, which stays a pure size string) is shown in the
  // picker copy.
  { value: "medium", label: "Medium", size: "~1.5 GB", note: "Turbo is faster & better" },
  { value: "large-v3-turbo", label: "Large v3 Turbo", size: "~1.6 GB" },
];

/** The persisted model pick, defaulting to "small" when the field is absent
 *  (settings.json files predating #110) or holds an unknown value. */
export function sanitizedSttModel(value: string | null | undefined): string {
  return STT_MODELS.some((m) => m.value === value) ? (value as string) : "small";
}

/** Pool presets (PROPOSAL §6); mirrors the engine's POOL_PRESETS. */
export const POOL_PRESETS: { id: string; label: string; usd: number }[] = [
  { id: "pro", label: "Pro · $20", usd: 20 },
  { id: "max5x", label: "Max 5x · $100", usd: 100 },
  { id: "max20x", label: "Max 20x · $200", usd: 200 },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Next billing reset, e.g. "Jul 1" (§8.7). Boundaries follow the ledger's
 *  UTC evaluation, so this names the day without promising a local time. */
export function nextResetLabel(resetDay: number, now: Date): string {
  const day = Math.min(28, Math.max(1, Math.floor(resetDay)));
  let month = now.getUTCMonth();
  let year = now.getUTCFullYear();
  if (now.getUTCDate() >= day) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  void year; // the label shows month+day only
  return `${MONTHS[month]} ${day}`;
}

/** Apply the caption size step to the live feed (3 steps, §8.7). */
export function applyCaptionSize(size: CaptionSize): void {
  document.body.dataset.capsize = size;
}

/** Monospaced-digit gauge amount, e.g. "$7.40 / $20.00". */
export function gaugeAmountLabel(spentUsd: number, poolUsd: number): string {
  return `$${spentUsd.toFixed(2)} / $${poolUsd.toFixed(2)}`;
}

/**
 * Per-session target language (#2): the user confirms/changes the target at
 * Start each time. The pick is remembered as the DEFAULT for the next session
 * by persisting it into settings. Returns the settings object to persist when
 * the pick differs from the stored default, or `null` when it is unchanged (so
 * the caller skips a redundant write). Normalizes the tag the same way the Rust
 * sanitizer does (trim + lowercase) so an unchanged pick is detected reliably.
 */
export function nextSettingsForSessionLanguage(
  current: AppSettings,
  pickedCode: string,
): AppSettings | null {
  const normalized = pickedCode.trim().toLowerCase();
  if (normalized === "" || normalized === current.targetLanguage) return null;
  return { ...current, targetLanguage: normalized };
}

/**
 * Per-session source (spoken) language (#94): mirror of
 * {@link nextSettingsForSessionLanguage} for the "Spoken language" picker. The
 * pick is remembered as the default for the next session. Returns the settings
 * to persist when it differs from the stored default, or `null` when unchanged
 * (so the caller skips a redundant write). Normalizes the tag the same way the
 * Rust sanitizer does (trim + lowercase); an empty pick clamps to "auto".
 */
export function nextSettingsForSessionSourceLanguage(
  current: AppSettings,
  pickedCode: string,
): AppSettings | null {
  const normalized = pickedCode.trim().toLowerCase() || "auto";
  if (normalized === current.sourceLanguage) return null;
  return { ...current, sourceLanguage: normalized };
}
