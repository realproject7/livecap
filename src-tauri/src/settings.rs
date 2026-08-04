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
fn default_source_language() -> String {
    "auto".into()
}
fn default_stt_model() -> String {
    // Single source of truth with the engine's download-failure fallback
    // (`session.rs` uses `livecap_core::model::DEFAULT_MODEL`): the Settings
    // default and the fallback must not diverge (#110).
    livecap_core::model::DEFAULT_MODEL.into()
}

/// What an install was running before #202 moved the default.
const LEGACY_STT_MODEL: &str = "small";

/// The model an EXISTING install keeps when its settings file carries no
/// `sttModel` (#202 migration).
///
/// The discriminator is the settings FILE, not the field: `load()` only reaches
/// this deserialization path when a file was read, so anything landing here is
/// an install that has run before. Files predating #110 have no `sttModel` at
/// all, and those users never chose `small` — they were simply defaulted into
/// it — so treating "absent" as consent to a 547 MB download on the next
/// session start would be exactly the silent switch #202 rules out. A fresh
/// install has no file, takes `AppSettings::default()`, and gets the new
/// default.
///
/// Trade-off, stated because it is real: an existing user who never touched the
/// setting stays on `small` until they pick the new model in the Settings sheet,
/// where it appears with its size. Opt-in beats an unrequested download.
fn migrated_stt_model() -> String {
    LEGACY_STT_MODEL.into()
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

/// Curated whisper model picks the Settings sheet exposes (#110) — a subset of
/// `livecap_core::model::MODEL_NAMES`. Anything else sanitizes to the default.
const STT_MODELS: &[&str] = &["small", "medium", "large-v3-turbo", "large-v3-turbo-q5_0"];

/// Curated Claude model picks for the CLI tier (#203). These are the CLI's tier
/// ALIASES, not dated snapshot ids, so LiveCap never pins a build that ages out.
///
/// Mirror of `CLAUDE_MODELS` in `packages/engine/src/args.ts` — the engine owns
/// the `--model` contract, and this list must not drift from it. Kept in the
/// cheapest-first order the picker shows.
const CLAUDE_MODELS: &[&str] = &["haiku", "sonnet", "opus"];

/// The Claude model the CLI tier runs unless the user picks another (#203).
///
/// Unlike `stt_model` (#202) this needs no migration split: before #203 the
/// model was hard-pinned to Haiku in the engine with no way to change it, so
/// "field absent" and "fresh install" describe installs that were BOTH already
/// running Haiku. One default covers both, and nobody's behaviour changes until
/// they touch the picker. Nothing is downloaded either way — the model runs on
/// Anthropic's side, so a heavier pick costs plan budget, not disk.
fn default_claude_model() -> String {
    "haiku".into()
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
    /// Spoken/source language for transcription (#94): a BCP-47 / ISO-639-1 tag
    /// forces whisper to that language; "auto" keeps per-utterance detection.
    #[serde(default = "default_source_language")]
    pub source_language: String,
    /// Whisper STT model for transcription (#110): "small" | "medium" |
    /// "large-v3-turbo" | "large-v3-turbo-q5_0" (curated subset of MODEL_NAMES;
    /// downloaded on first use at session start). Fresh installs default to the
    /// quantized turbo build (#202); an existing file keeps what it had.
    #[serde(default = "migrated_stt_model")]
    pub stt_model: String,
    /// Claude model the CLI tier runs (#203): "haiku" | "sonnet" | "opus"
    /// (curated tier aliases). Applies at the next session start; a heavier
    /// model consumes the plan's budget faster but downloads nothing.
    ///
    /// No `#[serde(default = ...)]` of its own, unlike `stt_model` above: the
    /// container default already yields Haiku, and here that IS the right
    /// answer for an absent field, so a second override would be a no-op. The
    /// STT field needs one only because its absent-field value deliberately
    /// differs from the struct default (#202).
    pub claude_model: String,
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
            source_language: default_source_language(),
            stt_model: default_stt_model(),
            claude_model: default_claude_model(),
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
    /// Defaults for an install whose settings file EXISTS but could not be used
    /// (#202). Identical to `default()` except for the model: the install has
    /// run before, so it keeps the legacy one rather than being moved onto a new
    /// download it never requested.
    fn existing_install_default() -> Self {
        Self {
            stt_model: migrated_stt_model(),
            ..Self::default()
        }
    }

    /// Clamp every field into its valid domain so a hand-edited or stale
    /// file can never wedge the app.
    pub fn sanitized(mut self) -> Self {
        if self.engine_pref != "local" {
            self.engine_pref = "cli".into();
        }
        let lang = self.target_language.trim().to_lowercase();
        self.target_language = if lang.is_empty() { default_language() } else { lang };
        // #94: source language is a lowercased non-empty tag, else "auto".
        let source = self.source_language.trim().to_lowercase();
        self.source_language = if source.is_empty() { default_source_language() } else { source };
        // #110: only the curated model picks are valid; a hand-edited value
        // (or a future rename) clamps back. It clamps to the LEGACY model, not
        // the new default (#202): sanitize only ever runs on a file that was
        // read, i.e. an existing install, and a garbage value is no more
        // consent to a 547 MB download than an absent one.
        let model = self.stt_model.trim();
        self.stt_model = if STT_MODELS.contains(&model) {
            model.to_string()
        } else {
            migrated_stt_model()
        };
        // #203: only the curated tier aliases are valid. An unknown value would
        // not fail here — it would spawn a CLI that 404s on every turn — so it
        // clamps to the default. Unlike the STT clamp above there is no legacy
        // split: Haiku is what every install was already running.
        let claude = self.claude_model.trim();
        self.claude_model = if CLAUDE_MODELS.contains(&claude) {
            claude.to_string()
        } else {
            default_claude_model()
        };
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

/// Load the settings; any read/parse failure yields defaults so a damaged file
/// never blocks launch (it also re-runs onboarding, which is safe).
///
/// #202: "defaults" is not one thing. A file that is ABSENT means a fresh
/// install, which gets the new default model. A file that exists but cannot be
/// read or parsed still belongs to an install that has run before — the user
/// has a model on disk and a working setup — so it falls back to the LEGACY
/// model instead. Otherwise a single corrupt byte would silently switch a
/// working install to a 547 MB download, which is the outcome the whole
/// migration exists to prevent.
pub fn load(path: &Path) -> AppSettings {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<AppSettings>(&text)
            .map(AppSettings::sanitized)
            .unwrap_or_else(|_| AppSettings::existing_install_default()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => AppSettings::default(),
        // The file is there and we could not read it (permissions, I/O): an
        // existing install, and the conservative branch is the same one.
        Err(_) => AppSettings::existing_install_default(),
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
            source_language: "en".into(),
            stt_model: "medium".into(),
            claude_model: "sonnet".into(),
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
        // Absent file = fresh install: full defaults, including the new model.
        assert_eq!(load(Path::new("/nonexistent/livecap-settings.json")), AppSettings::default());
        let path = temp_path("damaged");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        // #202: a file that EXISTS but will not parse belongs to an install that
        // has run before — defaults everywhere else, but the legacy model, so a
        // corrupt byte cannot trigger an unrequested 547 MB download.
        let damaged = load(&path);
        assert_eq!(damaged.stt_model, "small");
        assert_eq!(damaged, AppSettings::existing_install_default());
        assert_ne!(damaged, AppSettings::default());

        // Same arm, second shape: a write truncated mid-flight. Listed
        // separately because it is the realistic corruption, not a hand-edit.
        let cut = temp_path("truncated");
        std::fs::create_dir_all(cut.parent().unwrap()).unwrap();
        std::fs::write(&cut, br#"{"onboardingComplete": true, "sttMod"#).unwrap();
        assert_eq!(load(&cut).stt_model, "small");
        std::fs::remove_dir_all(cut.parent().unwrap()).ok();
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn default_stt_model_is_a_curated_pick() {
        // The Settings default now derives from livecap_core's DEFAULT_MODEL; if
        // the crate ever changes it to a value outside the curated STT_MODELS
        // list, sanitize() would silently clamp the default away — catch that here.
        assert!(
            STT_MODELS.contains(&livecap_core::model::DEFAULT_MODEL),
            "livecap_core::model::DEFAULT_MODEL ({}) must be one of the curated STT_MODELS",
            livecap_core::model::DEFAULT_MODEL
        );
        // The legacy value must stay selectable too, or the #202 migration would
        // clamp every existing install straight back onto the new default.
        assert!(STT_MODELS.contains(&LEGACY_STT_MODEL));
    }

    /// #202 migration. The settings FILE is the discriminator, not the field: a
    /// fresh install has none and gets the new default; anything parsed from
    /// disk is an install that has run before and keeps `small` unless it says
    /// otherwise. Nobody is pushed into a 547 MB download they did not ask for.
    #[test]
    fn fresh_install_gets_the_new_default_existing_installs_keep_theirs() {
        // No file at all → fresh install → the new default.
        assert_eq!(AppSettings::default().stt_model, "large-v3-turbo-q5_0");
        assert_eq!(
            AppSettings::default().stt_model,
            livecap_core::model::DEFAULT_MODEL
        );

        // A settings file with NO sttModel (predates #110) → still an existing
        // install → keeps the legacy model, NOT the new default.
        let legacy: AppSettings =
            serde_json::from_str(r#"{ "onboardingComplete": true }"#).unwrap();
        assert_eq!(legacy.stt_model, "small");
        assert_eq!(legacy.sanitized().stt_model, "small");

        // An explicit choice is respected in both directions.
        for chosen in ["small", "medium", "large-v3-turbo", "large-v3-turbo-q5_0"] {
            let parsed: AppSettings =
                serde_json::from_str(&format!(r#"{{ "sttModel": "{chosen}" }}"#)).unwrap();
            assert_eq!(parsed.sanitized().stt_model, chosen);
        }

        // A hand-edited unknown value clamps to the legacy model for the same
        // reason absence does — it is not consent to a new download.
        let junk: AppSettings =
            serde_json::from_str(r#"{ "sttModel": "large-v9-turbo" }"#).unwrap();
        assert_eq!(junk.sanitized().stt_model, "small");
    }

    /// #203. The Claude pick is the ONE model choice that costs plan budget
    /// rather than disk, so the clamp matters for a different reason than the
    /// STT one: a bad value spawns a CLI that 404s every turn — a dead
    /// translation lane, not a visible error.
    #[test]
    fn claude_model_defaults_to_haiku_and_clamps_unknown_values() {
        // Absent field (every settings.json written before #203) → Haiku, which
        // is what those installs were already running hard-pinned. No migration
        // split is needed here, unlike #202.
        let existing: AppSettings =
            serde_json::from_str(r#"{ "onboardingComplete": true }"#).unwrap();
        assert_eq!(existing.claude_model, "haiku");
        assert_eq!(existing.sanitized().claude_model, "haiku");

        // Every curated pick survives sanitize verbatim.
        for chosen in CLAUDE_MODELS {
            let parsed: AppSettings =
                serde_json::from_str(&format!(r#"{{ "claudeModel": "{chosen}" }}"#)).unwrap();
            assert_eq!(&parsed.sanitized().claude_model, chosen);
        }

        // Anything else clamps: a dated snapshot id, a tier that does not exist,
        // wrong case (exact match only), and blank/whitespace.
        for junk in [
            "claude-opus-4-5-20251101",
            "sonnet-4-5",
            "gpt-5",
            "Haiku",
            "",
            "   ",
        ] {
            let parsed: AppSettings =
                serde_json::from_str(&format!(r#"{{ "claudeModel": "{junk}" }}"#)).unwrap();
            assert_eq!(
                parsed.sanitized().claude_model,
                "haiku",
                "unknown model {junk:?} must clamp to the default"
            );
        }

        // The wire key is camelCase like every other field, so the webview
        // mirror and this struct agree on the name.
        let json = serde_json::to_string(&AppSettings::default()).unwrap();
        assert!(json.contains(r#""claudeModel":"haiku""#));
    }

    /// The default must be a member of the curated list, or `sanitized()` would
    /// clamp the default away on every load (same guard as the STT list).
    #[test]
    fn default_claude_model_is_a_curated_pick() {
        assert!(CLAUDE_MODELS.contains(&default_claude_model().as_str()));
    }

    #[test]
    fn defaults_match_the_product_contract() {
        let d = AppSettings::default();
        assert!(!d.onboarding_complete);
        assert_eq!(d.engine_pref, "cli");
        assert_eq!(d.target_language, "ko"); // KO default (§8.6)
        assert_eq!(d.source_language, "auto"); // #94: per-utterance auto-detect
        assert_eq!(d.stt_model, "large-v3-turbo-q5_0"); // #202: fresh install
        assert_eq!(d.claude_model, "haiku"); // #203: default unchanged
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
            source_language: "  EN ".into(),
            stt_model: "large-v9".into(),
            // #203: a dated snapshot id is exactly the plausible hand-edit —
            // it looks like a real model, and the curated list takes aliases.
            claude_model: "claude-3-5-haiku-20241022".into(),
            pool_usd: f64::NAN,
            reset_day: 31,
            caption_size: "xxl".into(),
            archive_folder: Some("   ".into()),
            ..AppSettings::default()
        };
        let clean = raw.sanitized();
        assert_eq!(clean.engine_pref, "cli");
        assert_eq!(clean.target_language, "pt-br");
        assert_eq!(clean.source_language, "en");
        assert_eq!(clean.stt_model, "small"); // #202: unknown → LEGACY, not the new default
        assert_eq!(clean.claude_model, "haiku"); // #203: unknown → the default
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
        assert_eq!(parsed.source_language, "auto"); // #94: missing → default
        assert_eq!(parsed.stt_model, "small"); // #202: missing on an existing file → legacy
        assert_eq!(parsed.engine_pref, "cli");
        assert_eq!(parsed.pool_usd, 20.0);
    }

    #[test]
    fn stt_model_round_trips_camel_case_and_sanitizes() {
        // #110: the wire key is camelCase like every other field.
        let parsed: AppSettings =
            serde_json::from_str(r#"{ "sttModel": "large-v3-turbo" }"#).unwrap();
        assert_eq!(parsed.stt_model, "large-v3-turbo");
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(json.contains(r#""sttModel":"large-v3-turbo""#));

        // Every curated pick survives sanitize; anything else clamps to small.
        for model in ["small", "medium", "large-v3-turbo"] {
            let clean = AppSettings {
                stt_model: model.into(),
                ..AppSettings::default()
            }
            .sanitized();
            assert_eq!(clean.stt_model, model);
        }
        let clean = AppSettings {
            stt_model: "tiny".into(), // valid MODEL_NAME but not a curated pick
            ..AppSettings::default()
        }
        .sanitized();
        assert_eq!(clean.stt_model, "small");
    }

    #[test]
    fn sanitize_blank_source_language_falls_back_to_auto() {
        let cleaned = AppSettings {
            source_language: "   ".into(),
            ..AppSettings::default()
        }
        .sanitized();
        assert_eq!(cleaned.source_language, "auto"); // #94
    }
}
