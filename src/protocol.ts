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

/** Session lifecycle, emitted by Rust on `session://status`. */
export interface SessionStatus {
  phase: SessionPhase;
  detail?: string;
}

export type ReplyIntentWire = "agree" | "push-back" | "ask" | "suggest";

/** Messages written by Rust to the host's stdin (one JSON per line). */
export type HostInbound =
  | {
      type: "start";
      appDataDir: string;
      archiveDir: string;
      /** Translation target language name, e.g. "Korean". */
      targetLanguage: string;
      /** Header labels for the archive, e.g. "EN" / "KO". */
      sourceLangCode: string;
      targetLangCode: string;
      /** Language for reply suggestions / quick translate output (§8.5). */
      meetingLanguage: string;
      /** Language for the live summary + board (§8.4). */
      summaryLanguage: string;
      /** Agent SDK monthly pool in USD (PROPOSAL §6). */
      poolUsd: number;
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
  | { type: "hostError"; detail: string };
