// Wire contracts shared by the webview UI, the Rust bridge, and the Node
// session host (#11). Types only — no runtime imports — so both tsconfigs
// (webview/DOM and host/node) can include it. The Rust side mirrors these
// shapes in src-tauri/src/bridge.rs.

/** them = system audio (what you hear), me = microphone (what you say). */
export type Channel = "them" | "me";

/** Caption events emitted by Rust to the webview on `caption://event`.
 *  Finalized events are also forwarded to the session host verbatim
 *  (wrapped as a HostInbound "caption" message). */
export type CaptionBridgeEvent =
  | { type: "partial"; channel: Channel; text: string }
  | {
      type: "finalized";
      /** Monotonic per-session id; doubles as the queue sequence number. */
      id: number;
      channel: Channel;
      text: string;
      /** ISO-639-1 detected language ("unknown" when detection failed). */
      lang: string;
      lowConfidence: boolean;
      epochMs: number;
    };

export type SessionPhase = "idle" | "starting" | "live" | "paused" | "stopping";

/** Overlay window display mode (#10). */
export type Mode = "panel" | "strip" | "capsule";

/** Shell window state, served by the `get_shell_state` command. */
export interface ShellState {
  mode: Mode;
  clickThrough: boolean;
  live: boolean;
}

/** Webview capabilities (window role), served by the `capabilities` command. */
export interface Capabilities {
  captioning: boolean;
  settings: boolean;
}

/** Session lifecycle, emitted by Rust on `session://status`. */
export interface SessionStatus {
  phase: SessionPhase;
  detail?: string;
}

/** Desired capture channels (#53), emitted by Rust on `session://channels`
 *  and served by the `session_channels` command (both-on while idle). */
export interface SessionChannels {
  system: boolean;
  mic: boolean;
}

export type ReplyIntentWire = "agree" | "push-back" | "ask" | "suggest";

/** Engine preference (#12 Settings): which tier the router defaults to. */
export type EnginePref = "cli" | "local";

/** Messages written by Rust to the host's stdin (one JSON per line). The
 *  start message carries the persisted AppSettings (settings.json, #12) the
 *  session must honor; language names/labels derive from the code in the
 *  host (src/languages.ts). */
export type HostInbound =
  | {
      type: "start";
      appDataDir: string;
      archiveDir: string;
      /** Translate-into target as a BCP-47 tag, e.g. "ko" (§8.6 screen 2). */
      targetLanguageCode: string;
      /** Engine tier to lead with (router default; §8.7 segmented control). */
      enginePref: EnginePref;
      /** Agent SDK monthly pool in USD (PROPOSAL §6). */
      poolUsd: number;
      /** Billing reset day of month, 1–28 (§8.7 "resets Jul 1"). */
      resetDay: number;
      /** Auto-switch to the local tier when the pool runs low (§8.7). */
      autoSwitch: boolean;
      /** Archive group (§8.9 / design 07): auto-save + retention sweep. */
      archiveAutoSave: boolean;
      /** Delete archives older than this many days; 0 = keep forever. */
      archiveRetentionDays: number;
      /** Channel config at session start (#53) — when one channel is off the
       *  archive header notes it (e.g. "system audio only"). */
      captureSystem: boolean;
      captureMic: boolean;
    }
  | { type: "caption"; id: number; channel: Channel; text: string; lowConfidence: boolean; epochMs: number }
  | { type: "quickTranslate"; id: number; text: string }
  | { type: "reply"; id: number; intent: ReplyIntentWire }
  | { type: "retranslate"; id: number }
  | { type: "pin"; id: number; pinned: boolean }
  | { type: "silenceSnooze" }
  | { type: "stop" };

export interface TranslationItem {
  id: number;
  text: string;
}

export interface BoardWire {
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
}

/** Mirror of the engine package's GaugeState (kept structural so the webview
 *  tsconfig never pulls Node-typed engine sources). */
export interface GaugeWire {
  periodKey: string;
  poolUsd: number;
  spentUsd: number;
  remainingUsd: number;
  dollarsPerHour: number;
  estimatedHoursRemaining: number;
  fractionUsed: number;
  /** Per-session extras (summary/board/reply/quick-translate) spend so far this
   *  session (#55). Optional — present on live session gauges, absent on the
   *  pre-session probe snapshot. */
  extrasSpentUsd?: number;
  /** The per-session extras budget cap the spend above is metered against (#55). */
  extrasCapUsd?: number;
}

/** Messages emitted by the host on stdout; Rust forwards each to the webview
 *  as a `host://event` payload (and caches the latest gauge for #12). */
export type HostOutbound =
  | { type: "ready"; engine: string }
  | { type: "status"; detail: string }
  | { type: "translation"; items: TranslationItem[]; done: boolean }
  | { type: "translationFailed"; ids: number[]; detail: string }
  | { type: "summary"; summary: string[]; board: BoardWire }
  | { type: "gauge"; gauge: GaugeWire }
  | { type: "engineSwitch"; engine: string }
  | { type: "quickTranslateResult"; id: number; text: string }
  | { type: "replyResult"; id: number; intent: ReplyIntentWire; text: string }
  | { type: "extrasFailed"; id: number; detail: string }
  | { type: "silence"; sinceMs: number }
  | { type: "archived"; path: string }
  | { type: "stopped" }
  | { type: "hostError"; detail: string }
  /** Terminal: the engine never became ready (#65). The Rust shell consumes
   *  this — it tears the session down to `idle` and republishes the (content-
   *  free) `detail` as a durable `session://status` error — and does NOT forward
   *  it to the webview as a transient `host://event`. */
  | { type: "startFailed"; detail: string };

/* ---- #12 probe mode (no session) ----------------------------------------
 * `node dist-host/main.mjs --probe '<ProbeRequest JSON>'` runs real CLI
 * detection plus a read-only credit-gauge snapshot and prints ONE
 * ProbeResult JSON line. Used by onboarding screen 3 and the Settings sheet
 * before any session has populated the live gauge cache. */

export interface ProbeRequest {
  appDataDir: string;
  poolUsd: number;
  resetDay: number;
}

export interface ProbeCli {
  bin: string;
  version: string;
}

export interface ProbeResult {
  type: "probe";
  cli: ProbeCli | null;
  gauge: GaugeWire;
}
