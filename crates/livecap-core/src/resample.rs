//! Streaming resampler to the 16 kHz mono format whisper and Silero expect.
//!
//! Meetily resampled with linear interpolation; LiveCap uses rubato's
//! FFT-based resampler (the dependency Meetily already pins) for better
//! anti-aliasing, wrapped with input buffering so it can consume arbitrarily
//! sized capture chunks. The source rate may change mid-stream (macOS system
//! tap); the inner resampler is rebuilt when that happens.

use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, Resampler};

/// Fixed input chunk size fed to rubato (samples). At 48 kHz this is ~21 ms
/// of buffering latency.
const CHUNK_IN: usize = 1024;

/// Streaming single-channel resampler with a fixed output rate.
pub struct StreamResampler {
    to_rate: u32,
    from_rate: u32,
    inner: Option<FftFixedIn<f32>>,
    input_buf: Vec<f32>,
}

impl StreamResampler {
    pub fn new(to_rate: u32) -> Self {
        Self {
            to_rate,
            from_rate: 0,
            inner: None,
            input_buf: Vec::new(),
        }
    }

    /// Feed `samples` recorded at `from_rate`; returns however many output
    /// samples are ready (possibly none — input is buffered into fixed
    /// chunks).
    pub fn process(&mut self, samples: &[f32], from_rate: u32) -> Result<Vec<f32>> {
        if from_rate == 0 {
            return Err(anyhow!("Invalid input sample rate: 0 Hz"));
        }
        if from_rate == self.to_rate {
            // Pass-through; drop any residue from a previous rate.
            self.inner = None;
            self.from_rate = from_rate;
            self.drop_residue();
            return Ok(samples.to_vec());
        }

        if self.inner.is_none() || self.from_rate != from_rate {
            log::info!(
                "Resampler: configuring {} Hz -> {} Hz",
                from_rate,
                self.to_rate
            );
            self.inner = Some(FftFixedIn::<f32>::new(
                from_rate as usize,
                self.to_rate as usize,
                CHUNK_IN,
                2,
                1,
            )?);
            self.from_rate = from_rate;
            self.drop_residue();
        }

        self.input_buf.extend_from_slice(samples);
        let resampler = self.inner.as_mut().expect("resampler initialized above");

        let mut out = Vec::new();
        while self.input_buf.len() >= CHUNK_IN {
            let chunk: Vec<f32> = self.input_buf.drain(..CHUNK_IN).collect();
            let result = resampler.process(&[chunk], None)?;
            out.extend_from_slice(&result[0]);
        }
        Ok(out)
    }

    /// Discard the sub-`CHUNK_IN` residue buffered at the OLD rate on a rate change
    /// (#178). This is a DELIBERATE, correct drop, NOT a bug to "fix": those
    /// samples were captured at the old rate, so they can neither be fed through
    /// the freshly-rebuilt new-rate resampler (a rate mismatch would itself corrupt
    /// the output) nor emitted as new-rate pass-through. The loss is bounded (at
    /// most CHUNK_IN-1 samples, ~21ms at 48kHz) and only occurs at a mid-meeting
    /// device/rate switch. The count (never any audio) is logged so the drop is
    /// observable rather than silent — the one thing the finding actually asks for.
    fn drop_residue(&mut self) {
        if !self.input_buf.is_empty() {
            log::debug!(
                "Resampler: dropping {} buffered old-rate sample(s) at a rate change (#178)",
                self.input_buf.len()
            );
            self.input_buf.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_at_target_rate() {
        let mut r = StreamResampler::new(16000);
        let input = vec![0.5f32; 800];
        let out = r.process(&input, 16000).unwrap();
        assert_eq!(out, input);
    }

    #[test]
    fn downsamples_48k_to_16k_at_one_third_length() {
        let mut r = StreamResampler::new(16000);
        // 1 second of a 440 Hz sine at 48 kHz.
        let input: Vec<f32> = (0..48000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin())
            .collect();
        let mut total = 0usize;
        for chunk in input.chunks(1000) {
            total += r.process(chunk, 48000).unwrap().len();
        }
        // ~16000 samples out, allowing for internal buffering/latency.
        assert!(
            (14000..=16500).contains(&total),
            "unexpected output length: {total}"
        );
    }

    #[test]
    fn handles_rate_change_mid_stream() {
        let mut r = StreamResampler::new(16000);
        r.process(&vec![0.0f32; 4096], 48000).unwrap();
        // Rate change must not error; resampler is rebuilt.
        let out = r.process(&vec![0.0f32; 4096], 44100).unwrap();
        assert!(out.len() < 4096);
    }

    #[test]
    fn rejects_zero_rate() {
        let mut r = StreamResampler::new(16000);
        assert!(r.process(&[0.0], 0).is_err());
    }
}
