// UI heartbeat (#54): once a second the webview pushes a compact snapshot of
// what it is actually rendering to the Rust side, where `ui_snapshot` serves
// it. This makes "the window is blank" programmatically observable — for the
// operator's headless verification and as a wedge detector (a stale beat
// means the webview stopped executing).
import { invoke } from "@tauri-apps/api/core";

export interface UiBeat {
  ts: number;
  mode: string;
  feedBlocks: number;
  /** Caption blocks actually in the DOM (#57: must obey FEED_WINDOW). */
  domBlocks: number;
  latestSource: string;
  latestTranslation: string;
  capsuleText: string;
  bootError: string | null;
}

// Active cadence keeps verification/wedge detection responsive; when the
// webview is hidden (#147) the beat slows to a keepalive — still frequent
// enough to catch a wedge, but no per-second DOM read + IPC while idle.
const ACTIVE_MS = 1000;
const IDLE_MS = 4000;

export function startUiHeartbeat(collect: () => Omit<UiBeat, "ts" | "bootError">): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    const beat: UiBeat = {
      ts: Date.now(),
      bootError: (window as { __lcBootError?: string | null }).__lcBootError ?? null,
      ...collect(),
    };
    void invoke("ui_beat", { beat }).catch(() => {
      /* command not ready during teardown — the next beat retries */
    });
    timer = setTimeout(send, document.hidden ? IDLE_MS : ACTIVE_MS);
  };
  // A visibility change to "visible" should resume the active cadence promptly
  // rather than waiting out a pending idle interval.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && timer !== undefined) {
      clearTimeout(timer);
      send();
    }
  });
  send();
}
