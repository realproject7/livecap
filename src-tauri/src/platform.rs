//! macOS NSWindow integration: Spaces/fullscreen behavior, window level,
//! screen-capture exclusion (EPIC launch gate), and the glass material.
//!
//! Everything here must run on the main thread; callers go through
//! `run_on_main_thread` (Tauri's `setup` already runs there).

use tauri::WebviewWindow;

use crate::modes::Mode;

#[cfg(target_os = "macos")]
mod imp {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowSharingType};
    use tauri::WebviewWindow;
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    /// NSFloatingWindowLevel — a pinned overlay floats above ordinary app
    /// windows (and, with FullScreenAuxiliary, over fullscreen apps) but stays
    /// BELOW system UI such as the TCC permission sheets and the menu bar.
    /// NSStatusWindowLevel (25) sat above those and hid the mic-permission
    /// prompt behind the overlay; floating (3) is high enough to be an overlay
    /// without fighting system dialogs.
    const PINNED_WINDOW_LEVEL: isize = 3;
    /// NSNormalWindowLevel — an unpinned overlay sits with ordinary app
    /// windows and can be covered by them.
    const NORMAL_WINDOW_LEVEL: isize = 0;
    /// The Spaces/fullscreen bits a pinned overlay carries; cleared when
    /// unpinned so the window lives on a single Space like a normal one.
    const PINNED_BEHAVIOR: NSWindowCollectionBehavior = NSWindowCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces.0
            | NSWindowCollectionBehavior::FullScreenAuxiliary.0,
    );

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        let ptr = window.ns_window().ok()?;
        // SAFETY: Tauri hands back a valid NSWindow* for a live window; we
        // only use it on the main thread for the lifetime of `window`.
        Some(unsafe { &*(ptr as *const NSWindow) })
    }

    /// Window level for the pin state — pure, so the level mapping is unit
    /// testable without an NSWindow.
    pub(super) fn level_for(pinned: bool) -> isize {
        if pinned {
            PINNED_WINDOW_LEVEL
        } else {
            NORMAL_WINDOW_LEVEL
        }
    }

    /// Apply the pin state to a base collection behavior: set the
    /// all-Spaces/fullscreen bits when pinned, clear them when unpinned, leaving
    /// every other bit untouched. Pure, so the bit math is unit testable.
    pub(super) fn behavior_for(
        base: NSWindowCollectionBehavior,
        pinned: bool,
    ) -> NSWindowCollectionBehavior {
        let cleared = base & !PINNED_BEHAVIOR;
        if pinned {
            cleared | PINNED_BEHAVIOR
        } else {
            cleared
        }
    }

    /// Window level + Spaces/fullscreen collection behavior for the pin state.
    /// Pinned: floating level + join-all-Spaces|fullscreen-auxiliary (floats over
    /// every Space). Unpinned: normal level, those bits cleared (ordinary
    /// single-Space window). Tauri's `set_always_on_top` is flipped by the
    /// caller alongside this.
    pub fn set_pinned(window: &WebviewWindow, pinned: bool) {
        if let Some(ns) = ns_window(window) {
            ns.setCollectionBehavior(behavior_for(ns.collectionBehavior(), pinned));
            ns.setLevel(level_for(pinned));
        }
    }

    /// Read back whether the window is pinned: floating-level AND carrying the
    /// all-Spaces/fullscreen bits.
    pub fn pinned(window: &WebviewWindow) -> bool {
        ns_window(window)
            .map(|ns| {
                ns.level() == PINNED_WINDOW_LEVEL
                    && ns.collectionBehavior().contains(PINNED_BEHAVIOR)
            })
            .unwrap_or(false)
    }

    pub fn configure_overlay(window: &WebviewWindow, pinned: bool, capture_visible: bool) {
        set_pinned(window, pinned);
        if let Some(ns) = ns_window(window) {
            // `capture_visible` (resolved in lib.rs from LIVECAP_CAPTURE_VISIBLE,
            // or dev-flags.json in debug builds, #108) keeps the overlay visible
            // to screen capture — DEV/VERIFICATION ONLY (the operator's
            // screenshot-based checks can't see an excluded window, #54).
            // Production default is exclusion; the privacy row in Settings
            // reads the real state.
            if capture_visible {
                eprintln!("WARNING: capture exclusion DISABLED (dev capture-visible flag)");
            } else {
                ns.setSharingType(NSWindowSharingType::None);
            }
        }
    }

    /// Bring the overlay to the front and activate the app, so a tray/dock
    /// click reliably surfaces LiveCap even from another app or Space.
    /// `orderFrontRegardless` raises the window without requiring the app to be
    /// active first; `activateIgnoringOtherApps` then pulls LiveCap to the
    /// foreground so the window can take key focus.
    pub fn bring_to_front(window: &WebviewWindow) {
        if let Some(ns) = ns_window(window) {
            ns.orderFrontRegardless();
        }
        if let Some(cls) = AnyClass::get(c"NSApplication") {
            // SAFETY: called on the main thread (run_on_main_thread); the
            // shared NSApplication is always live for a running app.
            unsafe {
                let app: *mut AnyObject = msg_send![cls, sharedApplication];
                if !app.is_null() {
                    let _: () = msg_send![app, activateIgnoringOtherApps: true];
                }
            }
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn level_maps_pinned_to_floating_unpinned_to_normal() {
            assert_eq!(level_for(true), PINNED_WINDOW_LEVEL);
            assert_eq!(level_for(false), NORMAL_WINDOW_LEVEL);
        }

        #[test]
        fn pinned_behavior_sets_both_bits_and_unpinned_clears_them() {
            let empty = NSWindowCollectionBehavior::Default;
            let pinned = behavior_for(empty, true);
            assert!(pinned.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
            assert!(pinned.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));

            let unpinned = behavior_for(pinned, false);
            assert!(!unpinned.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
            assert!(!unpinned.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        }

        #[test]
        fn toggling_pin_preserves_unrelated_collection_bits() {
            // A bit LiveCap never touches (Managed) must survive a pin/unpin.
            let base = NSWindowCollectionBehavior::Managed;
            let pinned = behavior_for(base, true);
            assert!(pinned.contains(NSWindowCollectionBehavior::Managed));
            let unpinned = behavior_for(pinned, false);
            assert!(unpinned.contains(NSWindowCollectionBehavior::Managed));
            assert!(!unpinned.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::WebviewWindow;

    pub fn configure_overlay(_window: &WebviewWindow, _pinned: bool, _capture_visible: bool) {}

    pub fn set_pinned(_window: &WebviewWindow, _pinned: bool) {}

    pub fn pinned(_window: &WebviewWindow) -> bool {
        false
    }

    pub fn capture_excluded(_window: &WebviewWindow) -> bool {
        false
    }

    pub fn joins_all_spaces_and_fullscreen(_window: &WebviewWindow) -> bool {
        false
    }

    pub fn apply_glass(_window: &WebviewWindow, _corner_radius: f64) {}

    pub fn bring_to_front(_window: &WebviewWindow) {}
}

/// One-time overlay window setup: applies the initial pin state (window level
/// plus Spaces/fullscreen collection behavior) and sharingType = none (capture
/// exclusion). `pinned` comes from the persisted shell state;
/// `capture_visible` is the resolved dev capture-visible flag (env var, or
/// dev-flags.json in debug builds — see `dev_flags`) which skips the
/// exclusion for screenshot-based verification.
pub fn configure_overlay(window: &WebviewWindow, pinned: bool, capture_visible: bool) {
    imp::configure_overlay(window, pinned, capture_visible);
}

/// Flip the overlay's pin state at runtime: status vs. normal window level and
/// the all-Spaces/fullscreen collection bits. Does NOT touch sharingType, so
/// capture exclusion is unaffected. Tauri's `set_always_on_top` is flipped by
/// the caller alongside this. Main-thread only.
pub fn set_pinned(window: &WebviewWindow, pinned: bool) {
    imp::set_pinned(window, pinned);
}

/// Read back the ACTUAL pin state from the NSWindow (status level + the
/// all-Spaces/fullscreen bits), for verification.
pub fn pinned(window: &WebviewWindow) -> bool {
    imp::pinned(window)
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

/// Raise the overlay and activate the app so a tray/dock click surfaces it.
/// Main-thread only.
pub fn bring_to_front(window: &WebviewWindow) {
    imp::bring_to_front(window);
}
