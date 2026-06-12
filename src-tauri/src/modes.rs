//! The three overlay window modes (PROPOSAL §7.3 / §8.1).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Panel,
    Strip,
    Capsule,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::Panel, Mode::Strip, Mode::Capsule];

    /// Cycle order: Panel → Strip → Capsule → Panel.
    pub fn next(self) -> Mode {
        match self {
            Mode::Panel => Mode::Strip,
            Mode::Strip => Mode::Capsule,
            Mode::Capsule => Mode::Panel,
        }
    }

    /// Default logical size (PROPOSAL §8.1).
    pub fn default_size(self) -> (f64, f64) {
        match self {
            Mode::Panel => (520.0, 640.0),
            Mode::Strip => (720.0, 88.0),
            Mode::Capsule => (420.0, 44.0),
        }
    }

    /// Only the Panel is user-resizable; Strip and Capsule have fixed shapes.
    pub fn resizable(self) -> bool {
        matches!(self, Mode::Panel)
    }

    /// Corner radius of the glass surface (logical px, matches src/styles.css).
    pub fn corner_radius(self) -> f64 {
        match self {
            Mode::Panel => 16.0,
            Mode::Strip => 12.0,
            Mode::Capsule => 22.0,
        }
    }

    /// Click-through is offered in Strip and Capsule only (PROPOSAL §7.3).
    pub fn supports_click_through(self) -> bool {
        !matches!(self, Mode::Panel)
    }

    pub fn id(self) -> &'static str {
        match self {
            Mode::Panel => "panel",
            Mode::Strip => "strip",
            Mode::Capsule => "capsule",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mode::Panel => "Panel",
            Mode::Strip => "Strip",
            Mode::Capsule => "Capsule",
        }
    }

    pub fn from_id(id: &str) -> Option<Mode> {
        Mode::ALL.iter().copied().find(|m| m.id() == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycle_visits_all_modes_and_returns() {
        let mut m = Mode::Panel;
        let mut seen = vec![m];
        for _ in 0..2 {
            m = m.next();
            seen.push(m);
        }
        assert_eq!(seen, vec![Mode::Panel, Mode::Strip, Mode::Capsule]);
        assert_eq!(m.next(), Mode::Panel);
    }

    #[test]
    fn ids_round_trip() {
        for m in Mode::ALL {
            assert_eq!(Mode::from_id(m.id()), Some(m));
        }
        assert_eq!(Mode::from_id("window"), None);
    }

    #[test]
    fn serde_uses_lowercase_ids() {
        for m in Mode::ALL {
            let json = serde_json::to_string(&m).unwrap();
            assert_eq!(json, format!("\"{}\"", m.id()));
            let back: Mode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, m);
        }
    }

    #[test]
    fn sizes_match_spec() {
        assert_eq!(Mode::Panel.default_size(), (520.0, 640.0));
        assert_eq!(Mode::Strip.default_size(), (720.0, 88.0));
        assert_eq!(Mode::Capsule.default_size(), (420.0, 44.0));
    }
}
