//! Audio permission flows for onboarding (#12, PROPOSAL §8.6 screen 1).
//!
//! macOS TCC has no programmatic "grant": the only way to surface the real
//! permission sheets is to actually touch the hardware. `request_audio_access`
//! therefore starts a transient mic capture (cpal input stream → the
//! Microphone sheet) and a transient system-audio tap (Core Audio process tap
//! → the System Audio Recording sheet on macOS 14.4+), then drops both.
//!
//! Live status: the microphone exposes a passive query
//! (AVCaptureDevice.authorizationStatus); system audio has no public status
//! API, so its "status" is whether a tap can be created right now — only
//! probed when the user is in the onboarding/grant flow, never passively.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAccess {
    /// "granted" | "denied" | "undetermined" | "restricted" | "unknown".
    pub mic: &'static str,
    /// Whether a system-audio tap could be created (≈ permission granted).
    pub system_audio: bool,
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use livecap_core::audio::system::SystemAudioCapture;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;

    // AVCaptureDevice lives in AVFoundation; link it so the class resolves.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// Passive microphone TCC status via
    /// `+[AVCaptureDevice authorizationStatusForMediaType:]` (AVMediaTypeAudio
    /// is the constant string "soun").
    pub fn mic_status() -> &'static str {
        let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
            return "unknown";
        };
        let media = NSString::from_str("soun");
        let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: &*media] };
        match status {
            0 => "undetermined",
            1 => "restricted",
            2 => "denied",
            3 => "granted",
            _ => "unknown",
        }
    }

    /// Request microphone access the canonical way:
    /// `+[AVCaptureDevice requestAccessForMediaType:completionHandler:]`.
    ///
    /// This is the ONLY reliable way to raise the mic TCC sheet. The previous
    /// approach (open a cpal stream for 150 ms to "trigger" the sheet) raced:
    /// dropping the stream before the user answered tore the sheet down, and
    /// macOS shows the mic sheet only ONCE per launch — so a missed first sheet
    /// left the button doing nothing forever. requestAccess keeps the sheet up
    /// until the user answers and calls back with the result.
    ///
    /// Returns the resulting status string. Blocking — call off the main
    /// thread; it waits (bounded) for the user to answer the sheet.
    pub fn request_mic_access() -> &'static str {
        // Already decided (granted/denied/restricted) ⇒ no sheet, return as-is.
        let current = mic_status();
        if current != "undetermined" {
            return current;
        }
        let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
            return "unknown";
        };
        let media = NSString::from_str("soun");
        let (tx, rx) = mpsc::channel::<bool>();
        // completionHandler is `void (^)(BOOL granted)`, invoked on an arbitrary
        // queue once the user answers; hand the result back over the channel.
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let _: () = unsafe {
            msg_send![class, requestAccessForMediaType: &*media, completionHandler: &*handler]
        };
        // Wait for the answer, but never hang the command forever if the user
        // walks away from the sheet.
        let _ = rx.recv_timeout(Duration::from_secs(120));
        mic_status()
    }

    /// Create (and immediately drop) a system-audio process tap. On the first
    /// ever attempt this raises the "System Audio Recording" TCC sheet;
    /// afterwards success ≈ granted.
    pub fn probe_system_audio() -> bool {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        match SystemAudioCapture::start(None, tx) {
            Ok(capture) => {
                std::thread::sleep(Duration::from_millis(150));
                drop(capture);
                true
            }
            Err(_) => false,
        }
    }

    /// Deep-link System Settings → Privacy & Security at the relevant pane.
    pub fn open_privacy_pane(section: &str) -> Result<(), String> {
        let anchor = match section {
            "microphone" => "Privacy_Microphone",
            "system-audio" => "Privacy_AudioCapture",
            other => return Err(format!("unknown privacy section: {other}")),
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open System Settings: {e}"))
    }
}

#[cfg(target_os = "macos")]
use macos as platform_impl;

#[cfg(not(target_os = "macos"))]
mod other {
    /// Non-macOS builds have no TCC; report "unknown" and let the session's
    /// own capture errors drive the UI.
    pub fn mic_status() -> &'static str {
        "unknown"
    }
    pub fn request_mic_access() -> &'static str {
        "unknown"
    }
    pub fn probe_system_audio() -> bool {
        false
    }
    pub fn open_privacy_pane(_section: &str) -> Result<(), String> {
        Err("privacy settings deep-link is macOS-only".into())
    }
}

#[cfg(not(target_os = "macos"))]
use other as platform_impl;

/* ---- commands ---- */

/// Passive microphone permission status (no prompt, no capture).
#[tauri::command]
pub fn mic_permission_status() -> &'static str {
    platform_impl::mic_status()
}

/// Raise the REAL permission prompts and report what landed. The mic uses the
/// canonical AVCaptureDevice.requestAccess (keeps the sheet up until answered);
/// system audio has no such API, so it's probed by attempting a tap. Runs off
/// the main thread and may block while the user answers the mic sheet.
#[tauri::command]
pub async fn request_audio_access() -> Result<AudioAccess, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mic = platform_impl::request_mic_access();
        let system_audio = platform_impl::probe_system_audio();
        AudioAccess { mic, system_audio }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Re-check system audio by attempting a tap (used by onboarding's "check
/// again" after the user flips the System Settings toggle).
#[tauri::command]
pub async fn probe_system_audio() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(platform_impl::probe_system_audio)
        .await
        .map_err(|e| e.to_string())
}

/// Open System Settings → Privacy & Security at "microphone" or
/// "system-audio".
#[tauri::command]
pub fn open_privacy_settings(section: String) -> Result<(), String> {
    platform_impl::open_privacy_pane(&section)
}
