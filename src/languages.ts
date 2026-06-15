// Target-language registry (#12, PROPOSAL §8.6 screen 2). Shared by the
// webview (picker UI) and the session host (prompt + archive plumbing) — keep
// it dependency-free so both tsconfigs can include it.
//
// The source language is never picked: speech is detected automatically. The
// target is stored as a BCP-47 tag; anything outside this curated list still
// resolves (the tag itself becomes the prompt name and the archive label), so
// the plumbing handles arbitrary BCP-47 without a code change here.

export interface LanguageOption {
  /** BCP-47 tag, lowercase (the persisted settings value). */
  code: string;
  /** English name used in the engine prompt contract, e.g. "Korean". */
  name: string;
  /** Native label for pickers, e.g. "한국어". */
  native: string;
  /** Short label for the archive header (§8.9), e.g. "KO". */
  archiveLabel: string;
}

/** Curated picker entries. KO is the product default; EN and KO are the
 *  supported minimum — the rest ride the same plumbing. */
export const LANGUAGES: readonly LanguageOption[] = [
  { code: "ko", name: "Korean", native: "한국어", archiveLabel: "KO" },
  { code: "en", name: "English", native: "English", archiveLabel: "EN" },
  { code: "ja", name: "Japanese", native: "日本語", archiveLabel: "JA" },
  { code: "zh-hans", name: "Simplified Chinese", native: "简体中文", archiveLabel: "ZH" },
  { code: "es", name: "Spanish", native: "Español", archiveLabel: "ES" },
  { code: "fr", name: "French", native: "Français", archiveLabel: "FR" },
  { code: "de", name: "German", native: "Deutsch", archiveLabel: "DE" },
  { code: "pt-br", name: "Brazilian Portuguese", native: "Português (BR)", archiveLabel: "PT" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", archiveLabel: "VI" },
  { code: "hi", name: "Hindi", native: "हिन्दी", archiveLabel: "HI" },
] as const;

export const DEFAULT_LANGUAGE_CODE = "ko";

/** Sentinel code for "let whisper auto-detect the spoken language" (#94). */
export const SOURCE_AUTO_CODE = "auto";

/**
 * Spoken/source-language picker entries (#94): an "Auto" entry (auto-detect,
 * the default and current behavior) followed by the same curated languages as
 * the target picker. The persisted value is the code; "auto" maps to
 * per-utterance detection in the whisper pipeline.
 */
export const SOURCE_LANGUAGES: readonly LanguageOption[] = [
  { code: SOURCE_AUTO_CODE, name: "Auto", native: "Auto-detect", archiveLabel: "AUTO" },
  ...LANGUAGES,
] as const;

/**
 * Resolve a BCP-47 tag to a language option. Tags outside the curated list
 * resolve to a synthesized entry (tag as name, primary subtag uppercased as
 * the archive label) so any tag flows end-to-end.
 */
export function languageByCode(code: string): LanguageOption {
  const normalized = code.trim().toLowerCase();
  const known = LANGUAGES.find((l) => l.code === normalized);
  if (known) return known;
  if (normalized === "") return languageByCode(DEFAULT_LANGUAGE_CODE);
  return {
    code: normalized,
    name: normalized,
    native: normalized,
    archiveLabel: normalized.split("-")[0].toUpperCase(),
  };
}
