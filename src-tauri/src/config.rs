//! Persisted shell state: mode, per-display geometry per mode, click-through.
//!
//! Plain JSON in the app data dir, written atomically (temp file + rename) so
//! a crash mid-write never corrupts the previous state.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::modes::Mode;

pub const FILE_NAME: &str = "shell-state.json";

/// Window geometry in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DisplayState {
    /// Last active mode on this display.
    pub mode: Option<Mode>,
    /// Geometry remembered per mode id ("panel" / "strip" / "capsule").
    #[serde(default)]
    pub geometry: BTreeMap<String, Geometry>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ShellConfig {
    /// Keyed by display name (Tauri monitor name).
    #[serde(default)]
    pub displays: BTreeMap<String, DisplayState>,
    /// Click-through preference for Strip/Capsule.
    #[serde(default)]
    pub click_through: bool,
}

impl ShellConfig {
    pub fn display(&self, key: &str) -> Option<&DisplayState> {
        self.displays.get(key)
    }

    pub fn display_mut(&mut self, key: &str) -> &mut DisplayState {
        self.displays.entry(key.to_string()).or_default()
    }

    pub fn remember_geometry(&mut self, display: &str, mode: Mode, geometry: Geometry) {
        self.display_mut(display)
            .geometry
            .insert(mode.id().to_string(), geometry);
    }

    pub fn geometry_for(&self, display: &str, mode: Mode) -> Option<Geometry> {
        self.display(display)
            .and_then(|d| d.geometry.get(mode.id()))
            .copied()
    }
}

/// Load the config; any read or parse failure yields the defaults so a
/// damaged file never blocks launch.
pub fn load(path: &Path) -> ShellConfig {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => ShellConfig::default(),
    }
}

/// Atomic write: serialize to `<file>.tmp` in the same directory, then rename
/// over the destination (rename is atomic on the same volume).
pub fn save_atomic(path: &Path, config: &ShellConfig) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "livecap-config-test-{}-{}",
            name,
            std::process::id()
        ));
        dir.join(FILE_NAME)
    }

    #[test]
    fn round_trips_through_disk() {
        let path = temp_path("roundtrip");
        let mut cfg = ShellConfig {
            click_through: true,
            ..ShellConfig::default()
        };
        cfg.display_mut("Built-in Display").mode = Some(Mode::Strip);
        cfg.remember_geometry(
            "Built-in Display",
            Mode::Strip,
            Geometry {
                x: 360.0,
                y: 1600.0,
                w: 1440.0,
                h: 176.0,
            },
        );
        save_atomic(&path, &cfg).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded, cfg);
        assert_eq!(
            loaded.geometry_for("Built-in Display", Mode::Strip),
            Some(Geometry {
                x: 360.0,
                y: 1600.0,
                w: 1440.0,
                h: 176.0,
            })
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn save_leaves_no_temp_file() {
        let path = temp_path("notmp");
        save_atomic(&path, &ShellConfig::default()).unwrap();
        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn damaged_file_falls_back_to_defaults() {
        let path = temp_path("damaged");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), ShellConfig::default());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn missing_file_falls_back_to_defaults() {
        assert_eq!(load(Path::new("/nonexistent/livecap.json")), ShellConfig::default());
    }
}
