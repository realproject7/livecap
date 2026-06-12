//! Public caption event types emitted by the pipeline.

/// Which capture channel an event belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
    /// The local microphone ("me").
    Mic,
    /// System audio — what the machine is playing ("them").
    System,
}

impl std::fmt::Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Channel::Mic => write!(f, "mic"),
            Channel::System => write!(f, "system"),
        }
    }
}

/// The payload of a caption event.
#[derive(Debug, Clone)]
pub enum CaptionKind {
    /// In-progress text for an utterance that is still being spoken.
    /// Superseded by later partials and ultimately by a `Finalized` event.
    Partial(String),
    /// A finished utterance.
    Finalized {
        text: String,
        /// ISO-639-1 language code detected by whisper (e.g. "en", "ko"),
        /// or "unknown" when detection failed.
        lang: String,
        /// Heuristic confidence in `0.0..=1.0`.
        confidence: f32,
        /// Utterance start, milliseconds since the channel started.
        start_ms: u64,
        /// Utterance end, milliseconds since the channel started.
        end_ms: u64,
    },
}

/// A caption event for one channel.
#[derive(Debug, Clone)]
pub struct CaptionEvent {
    pub channel: Channel,
    pub kind: CaptionKind,
}
