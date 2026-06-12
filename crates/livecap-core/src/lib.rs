//! LiveCap core: audio capture, VAD segmentation, and on-device STT.
//!
//! This crate stays free of Tauri and UI concerns so it can be built and
//! tested headless. The capture and transcription core is derived from
//! Meetily (MIT, Zackriya-Solutions/meetily) — see the NOTICE file at the
//! repository root. Unlike Meetily, microphone and system audio are kept as
//! SEPARATE channels (them/me) instead of being mixed into one stream.
//!
//! Entry point: [`pipeline::CaptionPipeline`]. It consumes per-channel PCM
//! (from live capture or any other source) and emits [`event::CaptionEvent`]s
//! — per-channel partial text and finalized sentences with language,
//! confidence, and timestamps.

pub mod audio;
pub mod error;
pub mod event;
pub mod model;
pub mod pipeline;
pub mod resample;
mod suppression;
pub mod vad;
pub mod whisper;

pub use audio::device::{
    default_input_device, default_output_device, list_audio_devices, AudioDevice, DeviceType,
};
pub use audio::AudioChunk;
pub use error::CoreError;
pub use event::{CaptionEvent, CaptionKind, Channel};
pub use model::ModelManager;
pub use pipeline::{CaptionPipeline, PipelineConfig};
