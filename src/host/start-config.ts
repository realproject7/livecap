// Pure resolution of the start message (#12): the persisted AppSettings
// arrive over the protocol as primitives (BCP-47 tag, pool, reset day, …) and
// this maps them onto what each subsystem consumes — prompt language names,
// archive header labels, CreditAccountant config, router defaults. Pure and
// headless so the language/gauge plumbing is unit-testable.

import { DEFAULT_EXTRAS_BUDGET_USD } from "@livecap/engine";

import { languageByCode, SOURCE_AUTO_CODE } from "../languages.ts";
import type { EnginePref, HostInbound } from "../protocol.ts";

type StartMessage = Extract<HostInbound, { type: "start" }>;

/** Reply suggestions and quick-translate output go INTO the meeting's spoken
 *  language (§8.5), and the archive header's source label reflects it. #94 lets
 *  the user pick that spoken language; when they leave it on "auto" (per-utterance
 *  whisper detection, the default) there is no single spoken language, so reply/
 *  quick-translate falls back to English — the pre-#94 behavior. */
const AUTO_MEETING_LANGUAGE = "English";
/** Archive header source label (§8.9) for auto-detect (#94/#175): a neutral
 *  "AUTO" — detection is per-utterance, so no one language is the source. A
 *  PICKED source language uses its own archiveLabel (e.g. "KO"). */
const AUTO_SOURCE_LABEL = "AUTO";

export interface ResolvedStartConfig {
  /** Translation target for the engine system prompt, e.g. "Korean". */
  targetLanguage: string;
  /** Live summary/board output language (§8.4) — the user's language. */
  summaryLanguage: string;
  /** Reply suggestions / quick translate output language (§8.5). */
  meetingLanguage: string;
  /** Archive header labels (§8.9), e.g. "EN" → "KO". */
  sourceLangCode: string;
  targetLangCode: string;
  enginePref: EnginePref;
  /** CreditAccountant config (engine package receives these as-is). */
  poolUsd: number;
  resetDay: number;
  autoSwitch: boolean;
  archiveAutoSave: boolean;
  archiveRetentionDays: number;
  /** Per-session extras budget cap (#55), USD. Caps summary/extras spend so a
   *  long session can't run away with the monthly pool. */
  extrasBudgetUsd: number;
  /** Archive header note when a channel is off at session start (#53),
   *  e.g. "system audio only"; null when both channels are on. */
  channelsNote: string | null;
}

export function resolveStartConfig(message: StartMessage): ResolvedStartConfig {
  const language = languageByCode(message.targetLanguageCode);
  const source = resolveSourceLanguage(message.sourceLanguageCode);
  return {
    targetLanguage: language.name,
    summaryLanguage: language.name,
    meetingLanguage: source.meetingLanguage,
    sourceLangCode: source.archiveLabel,
    targetLangCode: language.archiveLabel,
    enginePref: message.enginePref === "local" ? "local" : "cli",
    poolUsd: Number.isFinite(message.poolUsd) && message.poolUsd > 0 ? message.poolUsd : 20,
    resetDay: clampResetDay(message.resetDay),
    autoSwitch: message.autoSwitch !== false,
    archiveAutoSave: message.archiveAutoSave !== false,
    archiveRetentionDays:
      Number.isFinite(message.archiveRetentionDays) && message.archiveRetentionDays > 0
        ? Math.floor(message.archiveRetentionDays)
        : 0,
    extrasBudgetUsd: DEFAULT_EXTRAS_BUDGET_USD,
    channelsNote: resolveChannelsNote(message.captureSystem, message.captureMic),
  };
}

/** Resolve the start message's spoken/source language (#94/#175) into the two
 *  things the host needs from it: the reply/quick-translate output language and
 *  the archive header source label. The "auto" sentinel — and an absent/blank
 *  value from an older shell — keeps per-utterance whisper detection (no fixed
 *  spoken language), so it maps to the English reply fallback + the neutral
 *  "AUTO" label; any picked tag resolves to its own language name + archive
 *  label (e.g. Korean → "Korean" / "KO"). */
function resolveSourceLanguage(code: string): { meetingLanguage: string; archiveLabel: string } {
  const normalized = code.trim().toLowerCase();
  if (normalized === SOURCE_AUTO_CODE || normalized === "") {
    return { meetingLanguage: AUTO_MEETING_LANGUAGE, archiveLabel: AUTO_SOURCE_LABEL };
  }
  const source = languageByCode(code);
  return { meetingLanguage: source.name, archiveLabel: source.archiveLabel };
}

/** Only an explicit false disables a channel (older shells omit the field);
 *  both-off cannot reach the host (the shell sanitizes it away). */
function resolveChannelsNote(captureSystem: boolean, captureMic: boolean): string | null {
  if (captureMic === false && captureSystem !== false) return "system audio only";
  if (captureSystem === false && captureMic !== false) return "microphone only";
  return null;
}

function clampResetDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.floor(day)));
}
