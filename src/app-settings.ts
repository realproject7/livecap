// Webview mirror of the Rust AppSettings (src-tauri/src/settings.rs) plus
// small pure helpers shared by onboarding and the Settings sheet (#12).

export type EnginePref = "cli" | "local";
export type CaptionSize = "s" | "m" | "l";

export interface AppSettings {
  onboardingComplete: boolean;
  engine: EnginePref;
  targetLanguage: string;
  poolUsd: number;
  resetDay: number;
  autoSwitch: boolean;
  captionSize: CaptionSize;
  archiveAutoSave: boolean;
  archiveFolder: string | null;
  archiveRetentionDays: number;
  /** Channels group (#53): per-channel capture toggles, applied at session
   *  start. The Rust side sanitizes so at least one stays on. */
  captureSystem: boolean;
  captureMic: boolean;
}

/** Engine-package default $/meeting-hour until real usage is metered
 *  (PROPOSAL §6 — keep in sync with CreditAccountant.defaultDollarsPerHour). */
export const DEFAULT_DOLLARS_PER_HOUR = 0.4;

/** Pool presets (PROPOSAL §6); mirrors the engine's POOL_PRESETS. */
export const POOL_PRESETS: { id: string; label: string; usd: number }[] = [
  { id: "pro", label: "Pro · $20", usd: 20 },
  { id: "max5x", label: "Max 5x · $100", usd: 100 },
  { id: "max20x", label: "Max 20x · $200", usd: 200 },
];

/** "≈ N hrs/month" for a pool, using the pre-metering default rate. */
export function estimatedHoursPerMonth(poolUsd: number): number {
  return Math.round(poolUsd / DEFAULT_DOLLARS_PER_HOUR);
}

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
