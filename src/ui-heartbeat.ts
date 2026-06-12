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
  latestSource: string;
  latestTranslation: string;
  capsuleText: string;
  bootError: string | null;
}

export function startUiHeartbeat(collect: () => Omit<UiBeat, "ts" | "bootError">): void {
  const send = () => {
    const beat: UiBeat = {
      ts: Date.now(),
      bootError: (window as { __lcBootError?: string | null }).__lcBootError ?? null,
      ...collect(),
    };
    void invoke("ui_beat", { beat }).catch(() => {
      /* command not ready during teardown — the next beat retries */
    });
  };
  send();
  setInterval(send, 1000);
}
