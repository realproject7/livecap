//! UI heartbeat cache (#54): the webview pushes a 1 Hz snapshot of what it is
//! rendering (`ui_beat`); `ui_snapshot` returns the last beat plus its age so
//! headless verification can tell a live feed from a blank or wedged webview.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct UiBeat {
    pub ts: u64,
    pub mode: String,
    #[serde(rename = "feedBlocks")]
    pub feed_blocks: u64,
    /// Caption blocks actually in the DOM (#57 window cap verification).
    /// Defaulted so the LIVECAP_UI_PROBE beat (older shape) still parses.
    #[serde(rename = "domBlocks", default)]
    pub dom_blocks: u64,
    #[serde(rename = "latestSource")]
    pub latest_source: String,
    #[serde(rename = "latestTranslation")]
    pub latest_translation: String,
    #[serde(rename = "capsuleText")]
    pub capsule_text: String,
    #[serde(rename = "bootError")]
    pub boot_error: Option<String>,
}

#[derive(Default)]
pub struct UiState(Mutex<Option<UiBeat>>);

#[derive(Serialize)]
pub struct UiSnapshot {
    pub beat: Option<UiBeat>,
    #[serde(rename = "ageMs")]
    pub age_ms: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Disk-mirror view of a beat (#147): the liveness/wedge detector only needs
/// the counts and mode, never caption text. Persisting `latestSource`/
/// `latestTranslation` would write caption content to app-data every 5s
/// regardless of the user's auto-save setting — so they are omitted here. The
/// full beat (with caption text) stays in memory for `ui_snapshot`.
#[derive(Serialize)]
struct PersistedBeat<'a> {
    ts: u64,
    mode: &'a str,
    #[serde(rename = "feedBlocks")]
    feed_blocks: u64,
    #[serde(rename = "domBlocks")]
    dom_blocks: u64,
    #[serde(rename = "capsuleText")]
    capsule_text: &'a str,
    #[serde(rename = "bootError")]
    boot_error: Option<&'a str>,
}

impl<'a> From<&'a UiBeat> for PersistedBeat<'a> {
    fn from(b: &'a UiBeat) -> Self {
        PersistedBeat {
            ts: b.ts,
            mode: &b.mode,
            feed_blocks: b.feed_blocks,
            dom_blocks: b.dom_blocks,
            capsule_text: &b.capsule_text,
            boot_error: b.boot_error.as_deref(),
        }
    }
}

#[tauri::command]
pub fn ui_beat(app: tauri::AppHandle, state: tauri::State<'_, UiState>, beat: UiBeat) {
    // Mirror every 5th beat to <app-data>/ui-heartbeat.json (atomic) so
    // headless verification can read the webview's render state without a
    // webview-side invoke path. Caption text is deliberately excluded from the
    // persisted view (#147) — see PersistedBeat.
    if (beat.ts / 1000).is_multiple_of(5) {
        if let (Ok(dir), Ok(json)) = (
            tauri::Manager::path(&app).app_data_dir(),
            serde_json::to_vec(&PersistedBeat::from(&beat)),
        ) {
            let tmp = dir.join("ui-heartbeat.json.tmp");
            let dst = dir.join("ui-heartbeat.json");
            if std::fs::write(&tmp, &json).is_ok() {
                let _ = std::fs::rename(&tmp, &dst);
            }
        }
    }
    *state.0.lock().expect("ui beat lock") = Some(beat);
}

#[tauri::command]
pub fn ui_snapshot(state: tauri::State<'_, UiState>) -> UiSnapshot {
    let beat = state.0.lock().expect("ui beat lock").clone();
    let age_ms = beat.as_ref().map(|b| now_ms().saturating_sub(b.ts));
    UiSnapshot { beat, age_ms }
}
