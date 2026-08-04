//! UI heartbeat cache (#54): the webview pushes a 1 Hz snapshot of what it is
//! rendering (`ui_beat`); `ui_snapshot` returns the last beat plus its age so
//! headless verification can tell a live feed from a blank or wedged webview.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The heartbeat mirror plus the atomic temp sibling a crash mid-write can
/// leave behind — both have carried caption content in pre-#147 builds.
const HEARTBEAT_FILES: [&str; 2] = ["ui-heartbeat.json", "ui-heartbeat.json.tmp"];

/// #191: delete the persisted heartbeat mirror at startup, before a session can
/// run.
///
/// Builds before #147 wrote `latestSource`/`latestTranslation`/`capsuleText`
/// into `<app-data>/ui-heartbeat.json`, and nothing ever cleaned it up: on an
/// upgraded install that plaintext caption line stayed readable until a NEW
/// session happened to overwrite it (observed on device — a 2026-07-05 payload
/// still on disk a month later).
///
/// Deleting unconditionally is the simplest correct fix, and is preferred over
/// the alternatives: detecting the legacy schema can mis-detect, and rewriting a
/// content-free beat would both re-open the file for writing and leave a
/// fresh-looking `ts` that headless verification could read as a live webview.
/// Deletion needs no parse, so legacy caption text is never read back into
/// memory, reserialized, or logged — the file is a regenerated observability
/// mirror that a fresh install does not have either, and `ui_beat` recreates it
/// on the next beat.
///
/// Only these two names are swept: `git log -S` over the whole history confirms
/// caption content was persisted by `ui_state.rs` alone (#54 introduced it,
/// #147 removed it), so no other app-data file carries this residue class.
///
/// Returns how many files were removed.
pub fn sweep_persisted_heartbeat(app_data_dir: &Path) -> usize {
    HEARTBEAT_FILES
        .iter()
        .filter(|name| std::fs::remove_file(app_data_dir.join(name)).is_ok())
        .count()
}

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

/// Disk-mirror view of a beat (#147): the liveness/wedge detector only needs
/// the counts and mode, never caption text. `latestSource`/`latestTranslation`
/// AND `capsuleText` all carry caption content (the capsule line is the latest
/// source/translation per the capsule-content setting), so NONE are persisted —
/// writing them would mirror caption content to app-data every 5s regardless of
/// the user's auto-save setting. The capsule is represented by a content-free
/// `capsuleActive` liveness bool. The full beat (with caption text) stays in
/// memory for `ui_snapshot`.
#[derive(Serialize)]
struct PersistedBeat<'a> {
    ts: u64,
    mode: &'a str,
    #[serde(rename = "feedBlocks")]
    feed_blocks: u64,
    #[serde(rename = "domBlocks")]
    dom_blocks: u64,
    /// Whether the capsule is showing a line — a liveness signal carrying no
    /// caption text (#147).
    #[serde(rename = "capsuleActive")]
    capsule_active: bool,
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
            capsule_active: !b.capsule_text.is_empty(),
            boot_error: b.boot_error.as_deref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #147 privacy guard: the persisted heartbeat JSON must NEVER contain
    /// caption content — not the source, the translation, or the capsule line.
    #[test]
    fn persisted_beat_never_contains_caption_content() {
        let beat = UiBeat {
            ts: 5000,
            mode: "capsule".into(),
            feed_blocks: 3,
            dom_blocks: 3,
            latest_source: "SECRET_SOURCE_LINE".into(),
            latest_translation: "SECRET_TRANSLATION_LINE".into(),
            capsule_text: "SECRET_CAPSULE_LINE".into(),
            boot_error: None,
        };
        let json = serde_json::to_string(&PersistedBeat::from(&beat)).unwrap();
        assert!(!json.contains("SECRET_SOURCE_LINE"), "leaked source: {json}");
        assert!(
            !json.contains("SECRET_TRANSLATION_LINE"),
            "leaked translation: {json}"
        );
        assert!(!json.contains("SECRET_CAPSULE_LINE"), "leaked capsule: {json}");
        // The content-free liveness bool is present and true (capsule non-empty).
        assert!(json.contains("\"capsuleActive\":true"), "missing liveness: {json}");
    }

    /// A pre-#147 payload, exactly as those builds wrote it: caption text in
    /// `latestSource`/`latestTranslation`/`capsuleText`.
    const LEGACY_BEAT: &str = r#"{"ts":1751673600000,"mode":"capsule","feedBlocks":7,
        "latestSource":"SECRET_SOURCE_LINE","latestTranslation":"SECRET_TRANSLATION_LINE",
        "capsuleText":"SECRET_CAPSULE_LINE","bootError":null}"#;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "livecap-heartbeat-sweep-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// #191 upgrade residue: a legacy heartbeat left by a pre-#147 build must be
    /// gone after startup — WITHOUT a session having run (a session is what used
    /// to overwrite it, which is exactly why the residue survived for a month).
    #[test]
    fn startup_sweep_removes_legacy_caption_residue() {
        let dir = temp_dir("legacy");
        let beat = dir.join("ui-heartbeat.json");
        // Both the file and the crash-left temp sibling carried caption text.
        let tmp = dir.join("ui-heartbeat.json.tmp");
        std::fs::write(&beat, LEGACY_BEAT).unwrap();
        std::fs::write(&tmp, LEGACY_BEAT).unwrap();

        assert_eq!(sweep_persisted_heartbeat(&dir), 2);

        assert!(!beat.exists(), "legacy heartbeat still on disk");
        assert!(!tmp.exists(), "legacy heartbeat temp file still on disk");
        // Nothing anywhere in app data still holds the caption text.
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let body = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(
                !body.contains("SECRET_SOURCE_LINE")
                    && !body.contains("SECRET_TRANSLATION_LINE")
                    && !body.contains("SECRET_CAPSULE_LINE"),
                "caption text survived in {}",
                path.display()
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sweep is unconditional, so it must be narrow: neighbouring app-data
    /// files (user settings, shell geometry, models) are not residue and must
    /// survive untouched. It must also be a no-op on a fresh install.
    #[test]
    fn startup_sweep_touches_nothing_else_and_tolerates_a_fresh_install() {
        let dir = temp_dir("neighbours");
        std::fs::write(dir.join("settings.json"), r#"{"targetLanguage":"ko"}"#).unwrap();
        std::fs::write(dir.join("shell-state.json"), r#"{"pinned":true}"#).unwrap();
        std::fs::create_dir_all(dir.join("models")).unwrap();

        // Fresh install: no heartbeat file at all — nothing removed, no error.
        assert_eq!(sweep_persisted_heartbeat(&dir), 0);
        // Idempotent: sweeping again after a real removal is still a no-op.
        std::fs::write(dir.join("ui-heartbeat.json"), LEGACY_BEAT).unwrap();
        assert_eq!(sweep_persisted_heartbeat(&dir), 1);
        assert_eq!(sweep_persisted_heartbeat(&dir), 0);

        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            r#"{"targetLanguage":"ko"}"#
        );
        assert!(dir.join("shell-state.json").exists());
        assert!(dir.join("models").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
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
    let age_ms = beat.as_ref().map(|b| crate::util::epoch_ms().saturating_sub(b.ts));
    UiSnapshot { beat, age_ms }
}
