//! Audio capture: device enumeration, microphone input, and the macOS
//! system-audio tap. Derived from Meetily's `audio` / `audio_v2` modules
//! (MIT) with the mixer removed — LiveCap keeps mic and system audio as
//! separate channels.

pub mod device;
pub mod mic;
pub mod system;

/// A chunk of mono PCM samples as produced by a capture source.
///
/// `sample_rate` travels with every chunk because some sources (notably the
/// macOS system-audio tap) can change their rate mid-stream when the output
/// device changes.
#[derive(Debug, Clone)]
pub struct AudioChunk {
    /// Mono samples in `-1.0..=1.0`.
    pub samples: Vec<f32>,
    /// Sample rate of `samples` in Hz.
    pub sample_rate: u32,
}
