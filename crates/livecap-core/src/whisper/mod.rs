//! whisper.cpp transcription engine (via whisper-rs), ported from Meetily's
//! `whisper_engine` module (MIT) and trimmed of its Tauri command wrappers.

pub mod acceleration;
pub mod engine;

pub use acceleration::{whisper_context_acceleration, WhisperCompiledBackend};
pub use engine::{Utterance, WhisperEngine};
