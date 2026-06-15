//! Persisted app settings (#12, PROPOSAL §8.6/§8.7): onboarding state plus
//! everything the Settings sheet edits. Plain JSON in the app data dir,
//! written atomically (temp file + rename) like the shell state in config.rs.
//!
//! The settings live in the app layer; the engine/archive packages stay
//! Tauri-free and receive these values over the host start message.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub const FILE_NAME: &str = "settings.json";

/// Event emitted to the webview whenever settings change.
pub const EVENT_CHANGED: &str = "settings://changed";

fn default_engine() -> String {
    "cli".into()
}
fn default_language() -> String {
    "ko".into()
}
fn default_pool() -> f64 {
    20.0
}
fn default_reset_day() -> u8 {
    1
}
fn default_true() -> bool {
    true
}
fn default_caption_size() -> String {
    "m".into()
}

fn default_capsule_content() -> String {
    "translation".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// First-run onboarding finished (§8.6). False ⇒ the webview shows it.
    pub onboarding_complete: bool,
    /// Engine the router leads with: "cli" | "local" (§8.7).
    #[serde(rename = "engine")]
    pub engine_pref: String,
    /// Translate-into target, BCP-47 tag (§8.6 screen 2). KO default.
    pub target_language: String,
    /// Agent SDK monthly pool in USD (PROPOSAL §6; presets 20/100/200).
    pub pool_usd: f64,
    /// Billing reset day of month, 1–28.
    pub reset_day: u8,
    /// Auto-switch to the local tier when the pool runs low (§8.7).
    pub auto_switch: bool,
    /// Caption size step: "s" | "m" | "l" (§8.7 "Aa Aa Aa").
    pub caption_size: String,
    /// Capsule (one-line pill) content: "caption" | "translation" | "both" (#97).
    pub capsule_content: String,
    /// Archive group (§8.9 / design 07).
    pub archive_auto_save: bool,
    /// None ⇒ ~/Documents/LiveCap (the session default).
    pub archive_folder: Option<String>,
    /// Delete archives older than this many days; 0 = keep forever.
    pub archive_retention_days: u32,
    /// Channels group (#53): capture system audio ("them") at session start.
    pub capture_system: bool,
    /// Channels group (#53): capture the microphone ("me") at session start.
    pub capture_mic: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            onboarding_complete: false,
            engine_pref: default_engine(),
            target_language: default_language(),
            pool_usd: default_pool(),
            reset_day: default_reset_day(),
            auto_switch: default_true(),
            caption_size: default_caption_size(),
            capsule_content: default_capsule_content(),
            archive_auto_save: default_true(),
            archive_folder: None,
            archive_retention_days: 0,
            capture_system: true,
            capture_mic: true,
        }
    }
}

impl AppSettings {
    /// Clamp every field into its valid domain so a hand-edited or stale
    /// file can never wedge the app.
    pub fn sanitized(mut self) -> Self {
        if self.engine_pref != "local" {
            self.engine_pref = "cli".into();
        }
        let lang = self.target_language.trim().to_lowercase();
        self.target_language = if lang.is_empty() { default_language() } else { lang };
        if !self.pool_usd.is_finite() || self.pool_usd <= 0.0 {
            self.pool_usd = default_pool();
        }
        self.reset_day = self.reset_day.clamp(1, 28);
        if !matches!(self.caption_size.as_str(), "s" | "m" | "l") {
            self.caption_size = default_caption_size();
        }
        if !matches!(self.capsule_content.as_str(), "caption" | "translation" | "both") {
            self.capsule_content = default_capsule_content();
        }
        if self
            .archive_folder
            .as_deref()
            .is_some_and(|folder| folder.trim().is_empty())
        {
            self.archive_folder = None;
        }
        // #53: a session needs at least one capture channel; a hand-edited
        // file with both off comes back as the both-on default.
        if !self.capture_system && !self.capture_mic {
            self.capture_system = true;
            self.capture_mic = true;
        }
        self
    }
}

/// Load the settings; any read/parse failure yields the defaults so a damaged
/// file never blocks launch (it also re-runs onboarding, which is safe).
pub fn load(path: &Path) -> AppSettings {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<AppSettings>(&text)
            .map(AppSettings::sanitized)
            .unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

/// Atomic write: temp file in the same directory, then rename over the
/// destination (rename is atomic on the same volume).
pub fn save_atomic(path: &Path, settings: &AppSettings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)
}

/// Managed settings state: the current value plus its on-disk location.
pub struct SettingsState {
    path: PathBuf,
    current: Mutex<AppSettings>,
}

impl SettingsState {
    pub fn new(path: PathBuf) -> Self {
        let current = Mutex::new(load(&path));
        Self { path, current }
    }

    pub fn snapshot(&self) -> AppSettings {
        self.current.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn replace(&self, settings: AppSettings) -> io::Result<AppSettings> {
        let settings = settings.sanitized();
        save_atomic(&self.path, &settings)?;
        if let Ok(mut guard) = self.current.lock() {
            *guard = settings.clone();
        }
        Ok(settings)
    }
}

/* ---- commands ---- */

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> AppSettings {
    state.snapshot()
}

/// Persist new settings (full object), apply them, and broadcast the change.
/// Returns the sanitized value actually stored.
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let saved = state.replace(settings).map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_CHANGED, &saved);
    Ok(saved)
}

/// Resolve the settings file path inside the app data dir.
pub fn settings_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join(FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("livecap-settings-test-{}-{}", name, std::process::id()))
            .join(FILE_NAME)
    }

    #[test]
    fn round_trips_through_disk() {
        let path = temp_path("roundtrip");
        let settings = AppSettings {
            onboarding_complete: true,
            engine_pref: "local".into(),
            target_language: "ja".into(),
            pool_usd: 100.0,
            reset_day: 15,
            auto_switch: false,
            caption_size: "l".into(),
            capsule_content: "both".into(),
            archive_auto_save: false,
            archive_folder: Some("/tmp/livecap-archives".into()),
            archive_retention_days: 90,
            capture_system: true,
            capture_mic: false,
        };
        save_atomic(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn missing_or_damaged_file_falls_back_to_defaults() {
        assert_eq!(load(Path::new("/nonexistent/livecap-settings.json")), AppSettings::default());
        let path = temp_path("damaged");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), AppSettings::default());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn defaults_match_the_product_contract() {
        let d = AppSettings::default();
        assert!(!d.onboarding_complete);
        assert_eq!(d.engine_pref, "cli");
        assert_eq!(d.target_language, "ko"); // KO default (§8.6)
        assert_eq!(d.pool_usd, 20.0); // Pro preset
        assert_eq!(d.reset_day, 1);
        assert!(d.auto_switch);
        assert_eq!(d.caption_size, "m");
        assert_eq!(d.capsule_content, "translation"); // #97 default
        assert!(d.archive_auto_save);
        assert_eq!(d.archive_retention_days, 0); // keep forever
        assert!(d.capture_system); // #53: both channels on by default
        assert!(d.capture_mic);
    }

    #[test]
    fn sanitize_clamps_invalid_fields() {
        let raw = AppSettings {
            engine_pref: "cloud".into(),
            target_language: "  PT-BR ".into(),
            pool_usd: f64::NAN,
            reset_day: 31,
            caption_size: "xxl".into(),
            archive_folder: Some("   ".into()),
            ..AppSettings::default()
        };
        let clean = raw.sanitized();
        assert_eq!(clean.engine_pref, "cli");
        assert_eq!(clean.target_language, "pt-br");
        assert_eq!(clean.pool_usd, 20.0);
        assert_eq!(clean.reset_day, 28);
        assert_eq!(clean.caption_size, "m");
        assert_eq!(clean.archive_folder, None);
    }

    #[test]
    fn sanitize_keeps_at_least_one_capture_channel() {
        let both_off = AppSettings {
            capture_system: false,
            capture_mic: false,
            ..AppSettings::default()
        }
        .sanitized();
        assert!(both_off.capture_system && both_off.capture_mic);

        let mic_only = AppSettings {
            capture_system: false,
            capture_mic: true,
            ..AppSettings::default()
        }
        .sanitized();
        assert!(!mic_only.capture_system && mic_only.capture_mic);
    }

    #[test]
    fn partial_json_fills_missing_fields_with_defaults() {
        let parsed: AppSettings =
            serde_json::from_str(r#"{ "onboardingComplete": true, "targetLanguage": "en" }"#).unwrap();
        assert!(parsed.onboarding_complete);
        assert_eq!(parsed.target_language, "en");
        assert_eq!(parsed.engine_pref, "cli");
        assert_eq!(parsed.pool_usd, 20.0);
    }
}
