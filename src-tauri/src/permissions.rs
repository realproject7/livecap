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
//! API at all, so its status is inferred from what a transient tap actually
//! delivers (see [`classify_system_audio`]) — only probed when the user is in
//! the onboarding/grant flow, never passively.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAccess {
    /// "granted" | "denied" | "undetermined" | "restricted" | "unknown".
    pub mic: &'static str,
    /// "granted" | "denied" | "unknown" — see [`classify_system_audio`].
    pub system_audio: &'static str,
}

/// What a transient probe tap could be observed doing. Kept separate from the
/// Core Audio plumbing so the verdict below is unit-testable: TCC decisions are
/// per-app-bundle and cannot be simulated from a test binary (a test run from a
/// terminal captures real audio under the TERMINAL's grant even while the app
/// itself is denied), so the only thing worth testing is the decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TapObservation {
    /// The process tap could be created — this is what raises the TCC sheet.
    pub created: bool,
    /// At least one non-zero sample arrived while the probe listened.
    pub heard_signal: bool,
}

/// Tri-state system-audio verdict (#168).
///
/// `AudioHardwareCreateProcessTap` succeeds whether the user granted OR denied
/// System Audio Recording — a denied tap just yields silence (documented at
/// `livecap-core/src/audio/system.rs:246-249`) — so tap creation alone proves
/// nothing and must never be reported as "granted".
///
/// - real (non-zero) audio arrived ⇒ `granted` (the only positive signal)
/// - tap created but silent ⇒ `unknown`: a granted-but-quiet Mac is
///   indistinguishable from a denied tap, both being all zeros
/// - tap could not be created ⇒ `denied`: system audio is definitively
///   unavailable right now (no output device, unsupported tap format, or an
///   OS-level refusal). This is the same "no access" the old boolean reported.
///
/// `unknown` and `denied` both route the UI to remediation; only `granted`
/// clears it.
pub fn classify_system_audio(observed: TapObservation) -> &'static str {
    if !observed.created {
        "denied"
    } else if observed.heard_signal {
        "granted"
    } else {
        "unknown"
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use livecap_core::audio::system::SystemAudioCapture;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use tokio::sync::mpsc::error::TryRecvError;

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

    /// How long the probe listens to the tap for a positive signal before
    /// giving up and reporting `unknown`. The pump forwards a chunk every few
    /// tens of milliseconds, so this is many chunks' worth of listening.
    const PROBE_LISTEN: Duration = Duration::from_millis(500);

    /// Create (and immediately drop) a system-audio process tap. On the first
    /// ever attempt this raises the "System Audio Recording" TCC sheet.
    ///
    /// Creation succeeding does NOT mean the grant landed (#168) — a denied tap
    /// is created just the same and yields silence — so we listen to the tap
    /// briefly and let [`super::classify_system_audio`] rule on what arrived.
    pub fn probe_system_audio() -> &'static str {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let Ok(capture) = SystemAudioCapture::start(None, tx) else {
            return super::classify_system_audio(super::TapObservation {
                created: false,
                heard_signal: false,
            });
        };

        // Listen for a non-zero sample. Only the yes/no fact is kept — never
        // the audio itself, and nothing is logged.
        let deadline = Instant::now() + PROBE_LISTEN;
        let mut heard_signal = false;
        while !heard_signal && Instant::now() < deadline {
            match rx.try_recv() {
                Ok(chunk) => heard_signal = chunk.samples.iter().any(|s| *s != 0.0),
                Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
                Err(TryRecvError::Disconnected) => break,
            }
        }
        drop(capture);

        super::classify_system_audio(super::TapObservation {
            created: true,
            heard_signal,
        })
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
    /// No process tap exists off macOS, so the tap can never be created and
    /// system audio is reported as unavailable ("denied").
    pub fn probe_system_audio() -> &'static str {
        super::classify_system_audio(super::TapObservation {
            created: false,
            heard_signal: false,
        })
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
/// system audio has no such API, so it's probed by creating a tap and listening
/// to what it delivers. Runs off the main thread and may block while the user
/// answers the mic sheet.
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

/// Re-check system audio by attempting a tap and listening to it (used by
/// onboarding's "check again" after the user flips the System Settings
/// toggle). Returns the tri-state of [`classify_system_audio`].
#[tauri::command]
pub async fn probe_system_audio() -> Result<&'static str, String> {
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

#[cfg(test)]
mod tests {
    use super::{classify_system_audio, TapObservation};

    /// The #168 bug itself: a created tap is NOT evidence of a grant, because a
    /// denied tap is created too and simply yields silence.
    #[test]
    fn silent_tap_is_unknown_never_granted() {
        let verdict = classify_system_audio(TapObservation {
            created: true,
            heard_signal: false,
        });
        assert_eq!(verdict, "unknown");
        assert_ne!(verdict, "granted");
    }

    /// Real audio off the tap is the only positive signal we accept.
    #[test]
    fn tap_with_real_audio_is_granted() {
        assert_eq!(
            classify_system_audio(TapObservation {
                created: true,
                heard_signal: true,
            }),
            "granted"
        );
    }

    /// No tap at all ⇒ system audio is unavailable; still never "granted".
    #[test]
    fn tap_that_could_not_be_created_is_denied() {
        assert_eq!(
            classify_system_audio(TapObservation {
                created: false,
                heard_signal: false,
            }),
            "denied"
        );
    }

    /// Every non-granted verdict must reach onboarding's remediation path, so
    /// the only verdict that may ever clear it is a heard signal.
    #[test]
    fn granted_requires_a_heard_signal() {
        for created in [true, false] {
            for heard_signal in [true, false] {
                let verdict = classify_system_audio(TapObservation {
                    created,
                    heard_signal,
                });
                assert_eq!(
                    verdict == "granted",
                    created && heard_signal,
                    "created={created} heard_signal={heard_signal} ⇒ {verdict}"
                );
                assert!(matches!(verdict, "granted" | "denied" | "unknown"));
            }
        }
    }
}
