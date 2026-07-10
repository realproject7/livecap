//! Debug-only dev flags (#108): `<appData>/dev-flags.json` replaces the old
//! LSEnvironment-inject + re-sign loop for device verification. Schema:
//! `{"captureVisible":bool,"autostart":bool}` — both fields optional; a
//! missing or malformed file means all flags off. The env vars
//! (`LIVECAP_CAPTURE_VISIBLE` / `LIVECAP_AUTOSTART`) still win over the file
//! whenever they are set.
//!
//! Both the file AND the env vars are read ONLY in `#[cfg(debug_assertions)]`
//! builds — release builds compile the file/env-reading code out entirely (the
//! release `capture_visible` / `autostart` below are compile-time `false`
//! constants), so the flags are unreachable in production by construction, not
//! by a runtime check (#146: a shipped binary has no env path to disable
//! capture exclusion).

use tauri::AppHandle;

/// Flags parsed from `dev-flags.json`. Everything defaults to off.
/// Debug-only: release builds resolve the flags to compile-time `false`
/// constants and never read the file, so this type is unreachable there (#146).
#[cfg(debug_assertions)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct DevFlags {
    capture_visible: bool,
    autostart: bool,
}

/// Parse the dev-flags file content. Missing fields default to false;
/// malformed JSON (or wrong field types) yields all flags off.
#[cfg(debug_assertions)]
fn parse(json: &str) -> DevFlags {
    #[derive(Default, serde::Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    struct Raw {
        capture_visible: bool,
        autostart: bool,
    }
    serde_json::from_str::<Raw>(json)
        .map(|raw| DevFlags {
            capture_visible: raw.capture_visible,
            autostart: raw.autostart,
        })
        .unwrap_or_default()
}

/// Debug builds: read `<appData>/dev-flags.json` (same dir resolution as
/// settings.json / shell-state.json). Any I/O failure = all flags off.
#[cfg(debug_assertions)]
fn from_file(app: &AppHandle) -> DevFlags {
    use tauri::Manager;

    const FILE_NAME: &str = "dev-flags.json";
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(FILE_NAME)).ok())
        .map(|json| parse(&json))
        .unwrap_or_default()
}

/// Precedence: a SET env var always wins ("1" = on, anything else = off,
/// matching the historical `== Ok("1")` checks); only an UNSET env var falls
/// through to the file flag.
#[cfg(debug_assertions)]
fn resolve(env: Option<&str>, file_flag: bool) -> bool {
    match env {
        Some(value) => value == "1",
        None => file_flag,
    }
}

/// Overlay stays visible to screen capture (disables BOTH exclusion
/// mechanisms: Tauri content protection + NSWindow sharingType).
///
/// Debug builds: `LIVECAP_CAPTURE_VISIBLE=1` (env wins) or the file flag.
#[cfg(debug_assertions)]
pub fn capture_visible(app: &AppHandle) -> bool {
    resolve(
        std::env::var("LIVECAP_CAPTURE_VISIBLE").ok().as_deref(),
        from_file(app).capture_visible,
    )
}

/// Release builds: no env or file path can disable capture exclusion — the
/// value is a compile-time constant `false` (#146 privacy invariant).
#[cfg(not(debug_assertions))]
pub fn capture_visible(_app: &AppHandle) -> bool {
    false
}

/// Start a captioning session at launch without any UI interaction.
///
/// Debug builds: `LIVECAP_AUTOSTART=1` (env wins) or the file flag.
#[cfg(debug_assertions)]
pub fn autostart(app: &AppHandle) -> bool {
    resolve(
        std::env::var("LIVECAP_AUTOSTART").ok().as_deref(),
        from_file(app).autostart,
    )
}

/// Release builds: no env or file path can trigger silent autostart — the
/// value is a compile-time constant `false` (#146).
#[cfg(not(debug_assertions))]
pub fn autostart(_app: &AppHandle) -> bool {
    false
}

// Debug-only items (`DevFlags`, `parse`, `resolve`) are compiled out of release
// builds, so these tests must be too — otherwise `cargo test --release` fails to
// compile (#161). CI runs debug, so this is currently theoretical but correct.
#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;

    #[test]
    fn parse_full_schema() {
        let flags = parse(r#"{"captureVisible":true,"autostart":true}"#);
        assert_eq!(
            flags,
            DevFlags {
                capture_visible: true,
                autostart: true
            }
        );
    }

    #[test]
    fn parse_partial_fields_default_the_rest_off() {
        let flags = parse(r#"{"captureVisible":true}"#);
        assert!(flags.capture_visible);
        assert!(!flags.autostart);

        let flags = parse(r#"{"autostart":true}"#);
        assert!(!flags.capture_visible);
        assert!(flags.autostart);
    }

    #[test]
    fn parse_malformed_json_is_all_off() {
        assert_eq!(parse("not json"), DevFlags::default());
        assert_eq!(parse(r#"{"captureVisible":"yes"}"#), DevFlags::default());
        assert_eq!(parse(""), DevFlags::default());
    }

    #[test]
    fn parse_empty_object_and_unknown_fields_are_all_off() {
        assert_eq!(parse("{}"), DevFlags::default());
        assert_eq!(parse(r#"{"somethingElse":true}"#), DevFlags::default());
    }

    #[test]
    fn env_set_wins_over_file() {
        // Env "1" turns the flag on even when the file says off.
        assert!(resolve(Some("1"), false));
        // Any other set value turns it OFF even when the file says on.
        assert!(!resolve(Some("0"), true));
        assert!(!resolve(Some(""), true));
    }

    #[test]
    fn env_unset_falls_through_to_file() {
        assert!(resolve(None, true));
        assert!(!resolve(None, false));
    }
}
