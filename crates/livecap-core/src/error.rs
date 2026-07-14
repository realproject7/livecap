//! Typed errors for paths that can be structurally unavailable.
//!
//! Most fallible functions in this crate return `anyhow::Result`; callers that
//! need to distinguish "this platform simply cannot do that" from transient
//! failures can downcast to [`CoreError`].

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    /// System-audio capture is unavailable on the current platform. (On macOS it
    /// uses a Core Audio process tap; other platforms would need WASAPI/PulseAudio
    /// loopback, which LiveCap does not ship yet.)
    // A target-capability statement, not a deferred stub: system audio is not implemented for non-macOS targets. no-stub-allow
    #[error("system audio capture is unavailable on {platform}: {reason}")]
    SystemAudioUnavailable {
        platform: &'static str,
        reason: String,
    },

    /// A requested audio device could not be found.
    #[error("audio device not found: {0}")]
    DeviceNotFound(String),

    /// An unknown whisper model name was requested.
    #[error("unknown whisper model: {0}")]
    UnknownModel(String),

    /// A downloaded model failed checksum verification.
    #[error("model checksum mismatch for {model}: expected sha256:{expected}, got sha256:{actual}")]
    ModelChecksumMismatch {
        model: String,
        expected: String,
        actual: String,
    },
}
