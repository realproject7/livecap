// Pure resolution of the start message (#12): the persisted AppSettings
// arrive over the protocol as primitives (BCP-47 tag, pool, reset day, …) and
// this maps them onto what each subsystem consumes — prompt language names,
// archive header labels, CreditAccountant config, router defaults. Pure and
// headless so the language/gauge plumbing is unit-testable.

import { DEFAULT_EXTRAS_BUDGET_USD } from "@livecap/engine";

import { languageByCode } from "../languages.ts";
import type { EnginePref, HostInbound } from "../protocol.ts";

type StartMessage = Extract<HostInbound, { type: "start" }>;

/** The meeting itself is spoken English (PROPOSAL positioning): reply
 *  suggestions and quick translate output INTO the meeting, and the archive
 *  header's source label reflects it. Captions themselves are auto-detected
 *  per sentence by whisper — there is no source-language setting (§8.6). */
const MEETING_LANGUAGE = "English";
const SOURCE_LANG_CODE = "EN";

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
  return {
    targetLanguage: language.name,
    summaryLanguage: language.name,
    meetingLanguage: MEETING_LANGUAGE,
    sourceLangCode: SOURCE_LANG_CODE,
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
