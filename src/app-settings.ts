// Webview mirror of the Rust AppSettings (src-tauri/src/settings.rs) plus
// small pure helpers shared by onboarding and the Settings sheet (#12).

// EnginePref is defined once, in the wire protocol; imported for local use and
// re-exported so the settings-sheet/onboarding consumers keep a single import site.
import type { EnginePref } from "./protocol";
export type { EnginePref };
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
  /** How eagerly translation follows the speaker (#195): "relaxed" (default) |
   *  "balanced". Applies at the next session start. */
  translationMode: string;
  /** Claude model the CLI tier runs (#203): "haiku" | "sonnet" | "opus".
   *  Applies at the next session start; downloads nothing (the model runs on
   *  Anthropic's side), but a heavier tier spends the plan's budget faster. */
  claudeModel: string;
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
  // #202: the quantized turbo build is the fresh-install default — turbo-class
  // accuracy at +82 MB over Small, and a 0.29 s cold load instead of 6.3 s.
  { value: "large-v3-turbo-q5_0", label: "Large v3 Turbo (compact)", size: "~547 MB" },
];

/** The persisted model pick, defaulting to "small" when the field is absent
 *  (settings.json files predating #110) or holds an unknown value.
 *
 *  The fallback stays "small" and deliberately does NOT track the #202
 *  fresh-install default: this function only ever sees settings that were
 *  loaded from disk, i.e. an existing install, and mirrors the Rust
 *  `migrated_stt_model` rather than `DEFAULT_MODEL`. A fresh install gets the
 *  new default from the backend, not from here. */
export function sanitizedSttModel(value: string | null | undefined): string {
  return STT_MODELS.some((m) => m.value === value) ? (value as string) : "small";
}

/** Translation cadence steps the picker exposes (#195).
 *
 *  Deliberately NOT every mode the pipeline implements: `live` is a real,
 *  working mode that the PO held permanently, because on punctuated speech it
 *  costs 1.67× Balanced's turns and buys nothing (p95 4.5 s vs 4.4 s), and a
 *  manual setting is the wrong shape for a benefit the user cannot predict in
 *  advance. #211 owns doing it automatically instead.
 *
 *  "Held" means unreachable, not merely unlisted — so the type below admits
 *  only the shipped steps, and every boundary that turns a string into a mode
 *  clamps to this list. */
export type TranslationModeValue = "relaxed" | "balanced";

/** Cadence steps with the MEASURED cost of each, stated per speech condition
 *  because the multiplier genuinely depends on how the speaker talks. The
 *  numbers come from `stable_prefix_measure.rs`, not from an estimate. */
export const TRANSLATION_MODES: {
  value: TranslationModeValue;
  label: string;
  note: string;
}[] = [
  {
    value: "relaxed",
    label: "Relaxed",
    note: "translates when the speaker pauses · today's behaviour",
  },
  {
    value: "balanced",
    label: "Balanced",
    note: "follows clause by clause · no extra requests in ordinary paused speech, ~1.2× in a mixed meeting, up to 5× during sustained unbroken speech — where it replaces a ~24 s wait",
  },
];

/** The cadence a fresh install runs (#195). Relaxed is today's behaviour, so
 *  nobody's token spend changes until they opt in. */
export const DEFAULT_TRANSLATION_MODE: TranslationModeValue = "relaxed";

/** The persisted cadence, clamping anything unknown — including the held
 *  `live` — to Relaxed, the step that costs nothing extra. */
export function sanitizedTranslationMode(value: string | null | undefined): TranslationModeValue {
  const mode = (value ?? "").trim();
  return TRANSLATION_MODES.some((m) => m.value === mode)
    ? (mode as TranslationModeValue)
    : DEFAULT_TRANSLATION_MODE;
}

/** The Claude model a fresh install runs (#203) — unchanged from the value the
 *  engine hard-pinned before the picker existed. Mirrors `DEFAULT_MODEL` in
 *  packages/engine/src/args.ts; test/claude-model.test.ts fails if they drift.
 *
 *  The webview cannot import @livecap/engine (that package reaches for node
 *  builtins and never enters the browser bundle), so this is a deliberate
 *  mirror rather than a re-export — the same arrangement STT_MODELS has with
 *  the Rust sanitizer. */
export const DEFAULT_CLAUDE_MODEL = "haiku";

/** Curated Claude picks for the CLI tier (#203); values mirror the Rust
 *  sanitizer's CLAUDE_MODELS and the engine's list. Tier ALIASES, not dated
 *  snapshot ids, so a pick keeps resolving to the current build of that tier.
 *
 *  `note` carries the cost/quality trade-off, which is the whole reason this is
 *  a choice: nothing downloads, but a heavier tier spends the plan faster. */
export const CLAUDE_MODELS: { value: string; label: string; note: string }[] = [
  { value: "haiku", label: "Haiku", note: "fastest · lightest on your plan" },
  { value: "sonnet", label: "Sonnet", note: "stronger · uses more of your plan" },
  { value: "opus", label: "Opus", note: "strongest · uses the most" },
];

/** The persisted Claude pick, defaulting to Haiku when the field is absent
 *  (settings.json files predating #203) or holds an unknown value.
 *
 *  Absence gets the default with no migration caveat, unlike
 *  {@link sanitizedSttModel}: before #203 the model was hard-pinned to Haiku in
 *  the engine, so an older file's silence and a fresh install describe the same
 *  running state. Nobody is moved anywhere by this default. */
export function sanitizedClaudeModel(value: string | null | undefined): string {
  // Trimmed before matching, so this agrees with the Rust sanitizer and the
  // engine's clamp on every input (both trim). Case is NOT folded: the CLI's
  // aliases are lowercase and an exact match is what reaches `--model`.
  const model = (value ?? "").trim();
  return CLAUDE_MODELS.some((m) => m.value === model) ? model : DEFAULT_CLAUDE_MODEL;
}

/** The picker label for a persisted pick, e.g. "Haiku" (#203). Both the
 *  Settings sheet's engine button and the onboarding engine card render the
 *  model through this, so the two surfaces cannot disagree. */
export function claudeModelLabel(value: string | null | undefined): string {
  const model = sanitizedClaudeModel(value);
  return CLAUDE_MODELS.find((m) => m.value === model)?.label ?? model;
}

/** Pool presets (PROPOSAL §6) — the single source for the plan dollar amounts
 *  (the engine takes a plain `poolUsd` number, so nothing mirrors these). */
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
