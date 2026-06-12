//! macOS NSWindow integration: Spaces/fullscreen behavior, window level,
//! screen-capture exclusion (EPIC launch gate), and the glass material.
//!
//! Everything here must run on the main thread; callers go through
//! `run_on_main_thread` (Tauri's `setup` already runs there).

use tauri::WebviewWindow;

use crate::modes::Mode;

#[cfg(target_os = "macos")]
mod imp {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowSharingType};
    use tauri::WebviewWindow;
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    /// NSStatusWindowLevel — above normal and floating windows so the overlay
    /// stays visible over fullscreen apps.
    const STATUS_WINDOW_LEVEL: isize = 25;

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        let ptr = window.ns_window().ok()?;
        // SAFETY: Tauri hands back a valid NSWindow* for a live window; we
        // only use it on the main thread for the lifetime of `window`.
        Some(unsafe { &*(ptr as *const NSWindow) })
    }

    pub fn configure_overlay(window: &WebviewWindow) {
        if let Some(ns) = ns_window(window) {
            let behavior = ns.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            ns.setCollectionBehavior(behavior);
            ns.setLevel(STATUS_WINDOW_LEVEL);
            ns.setSharingType(NSWindowSharingType::None);
        }
    }

    pub fn capture_excluded(window: &WebviewWindow) -> bool {
        ns_window(window)
            .map(|ns| ns.sharingType() == NSWindowSharingType::None)
            .unwrap_or(false)
    }

    pub fn joins_all_spaces_and_fullscreen(window: &WebviewWindow) -> bool {
        ns_window(window)
            .map(|ns| {
                let b = ns.collectionBehavior();
                b.contains(NSWindowCollectionBehavior::CanJoinAllSpaces)
                    && b.contains(NSWindowCollectionBehavior::FullScreenAuxiliary)
            })
            .unwrap_or(false)
    }

    pub fn apply_glass(window: &WebviewWindow, corner_radius: f64) {
        // Re-applying replaces the effect view, so clear the previous one
        // first (mode switches change the corner radius).
        let _ = clear_vibrancy(window);
        let _ = apply_vibrancy(
            window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(corner_radius),
        );
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::WebviewWindow;

    pub fn configure_overlay(_window: &WebviewWindow) {}

    pub fn capture_excluded(_window: &WebviewWindow) -> bool {
        false
    }

    pub fn joins_all_spaces_and_fullscreen(_window: &WebviewWindow) -> bool {
        false
    }

    pub fn apply_glass(_window: &WebviewWindow, _corner_radius: f64) {}
}

/// One-time overlay window setup: all-Spaces + fullscreen-auxiliary
/// collection behavior, status window level, and sharingType = none.
pub fn configure_overlay(window: &WebviewWindow) {
    imp::configure_overlay(window);
}

/// Read back the ACTUAL NSWindow sharingType (not a cached flag) so capture
/// exclusion can be verified programmatically.
pub fn capture_excluded(window: &WebviewWindow) -> bool {
    imp::capture_excluded(window)
}

/// Read back the actual collectionBehavior bits.
pub fn joins_all_spaces_and_fullscreen(window: &WebviewWindow) -> bool {
    imp::joins_all_spaces_and_fullscreen(window)
}

/// (Re)apply the glass material behind the webview with the mode's radius.
pub fn apply_glass(window: &WebviewWindow, mode: Mode) {
    imp::apply_glass(window, mode.corner_radius());
}
