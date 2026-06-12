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

#[tauri::command]
pub fn ui_beat(app: tauri::AppHandle, state: tauri::State<'_, UiState>, beat: UiBeat) {
    // Mirror every 5th beat to <app-data>/ui-heartbeat.json (atomic) so
    // headless verification can read the webview's render state without a
    // webview-side invoke path.
    if (beat.ts / 1000).is_multiple_of(5) {
        if let (Ok(dir), Ok(json)) = (
            tauri::Manager::path(&app).app_data_dir(),
            serde_json::to_vec(&beat),
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
