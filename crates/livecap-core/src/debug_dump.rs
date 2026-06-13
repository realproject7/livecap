//! Gated raw-WAV debug dump (#64).
//!
//! #56's bleed suppression was tuned against synthetic fixtures; real speaker
//! acoustics (room reverb, AGC boosting the quiet bleed toward the system level,
//! mic-vs-system timing skew) defeat those thresholds. To tune against REAL
//! audio we need real two-channel fixtures — so when `LIVECAP_BLEED_DUMP_DIR` is
//! set, each channel worker writes the exact 16 kHz mono stream the VAD and the
//! suppressor see to `<dir>/livecap-bleed-<channel>.wav`.
//!
//! PRIVACY (EPIC #1): this records the user's raw audio, so it is OFF by default
//! and only ever runs on an explicit env opt-in — like a packet capture. It is
//! NOT a log: nothing about caption/transcript content is written anywhere, and
//! enabling it emits a one-time content-free warning.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use hound::{SampleFormat, WavSpec, WavWriter};

use crate::event::Channel;
use crate::vad::VAD_SAMPLE_RATE;

/// A per-channel WAV sink for the captured 16 kHz mono stream.
pub struct ChannelDump {
    // `Option` so `Drop` can take and finalize the writer (which consumes self).
    writer: Option<WavWriter<BufWriter<File>>>,
}

impl ChannelDump {
    /// Create `<dir>/livecap-bleed-<channel>.wav` (16 kHz mono, 16-bit PCM).
    /// Errors are returned so the caller can simply skip the dump rather than
    /// fail the session.
    pub fn create(dir: &Path, channel: Channel) -> hound::Result<Self> {
        let spec = WavSpec {
            channels: 1,
            sample_rate: VAD_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let path = dir.join(format!("livecap-bleed-{channel}.wav"));
        Ok(Self {
            writer: Some(WavWriter::create(path, spec)?),
        })
    }

    /// Append 16 kHz mono `f32` samples as 16-bit PCM. Per-sample write errors
    /// are ignored — a debug dump must never disturb the live pipeline.
    pub fn write(&mut self, samples: &[f32]) {
        if let Some(writer) = self.writer.as_mut() {
            for &sample in samples {
                let pcm = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
                let _ = writer.write_sample(pcm);
            }
        }
    }
}

impl Drop for ChannelDump {
    fn drop(&mut self) {
        // Patch the WAV header (data length) so the file is readable.
        if let Some(writer) = self.writer.take() {
            let _ = writer.finalize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_readable_16khz_mono_wav() {
        let dir = std::env::temp_dir().join(format!("livecap-dump-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let samples = vec![0.0f32, 0.5, -0.5, 1.0, -1.0];
        {
            let mut dump = ChannelDump::create(&dir, Channel::System).unwrap();
            dump.write(&samples);
        } // drop → finalize patches the header

        let path = dir.join("livecap-bleed-system.wav");
        let reader = hound::WavReader::open(&path).expect("dump should be a readable WAV");
        assert_eq!(reader.spec().sample_rate, VAD_SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.len(), samples.len() as u32);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
