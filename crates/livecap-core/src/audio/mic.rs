//! Microphone capture on a dedicated thread.
//!
//! Derived from Meetily `src/audio_v2/stream.rs` (MIT). Instead of an
//! `unsafe impl Send` around `cpal::Stream`, the stream lives on its own
//! thread for its whole lifetime and forwards mono chunks over a tokio
//! channel.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{Device, SupportedStreamConfig};
use log::{error, info};
use tokio::sync::mpsc;

use super::device::{default_input_device, get_device_and_config, AudioDevice};
use super::AudioChunk;

/// Handle to a running microphone capture. Dropping it stops the capture.
pub struct MicCapture {
    stop_tx: std::sync::mpsc::Sender<()>,
    join: Option<std::thread::JoinHandle<()>>,
    device: AudioDevice,
    sample_rate: u32,
}

impl MicCapture {
    /// Start capturing from `device` (or the default input device when
    /// `None`), sending mono chunks to `out`.
    pub fn start(device: Option<AudioDevice>, out: mpsc::UnboundedSender<AudioChunk>) -> Result<Self> {
        let device = match device {
            Some(d) => d,
            None => default_input_device()?,
        };
        info!("Starting microphone capture on '{}'", device.name);

        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();

        let thread_device = device.clone();
        let join = std::thread::Builder::new()
            .name("livecap-mic".into())
            .spawn(move || {
                // The cpal Stream is created, started, and dropped on this
                // thread (cpal streams are not Send).
                let built = (|| -> Result<cpal::Stream> {
                    let (cpal_device, config) = get_device_and_config(&thread_device)?;
                    let sample_rate = config.sample_rate().0;
                    info!(
                        "Mic config — rate: {} Hz, channels: {}, format: {:?}",
                        sample_rate,
                        config.channels(),
                        config.sample_format()
                    );
                    let stream = build_input_stream(&cpal_device, &config, out)?;
                    stream.play()?;
                    let _ = ready_tx.send(Ok(sample_rate));
                    Ok(stream)
                })();

                match built {
                    Ok(stream) => {
                        // Block until stop is requested or the handle is dropped.
                        let _ = stop_rx.recv();
                        drop(stream);
                        info!("Microphone capture stopped");
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })?;

        let sample_rate = ready_rx
            .recv()
            .map_err(|_| anyhow!("Microphone capture thread exited before reporting status"))??;

        Ok(Self {
            stop_tx,
            join: Some(join),
            device,
            sample_rate,
        })
    }

    /// The device this capture is reading from.
    pub fn device(&self) -> &AudioDevice {
        &self.device
    }

    /// Native sample rate of the capture stream.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Average interleaved frames down to mono.
fn downmix_to_mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Build the input stream for the device's native sample format.
/// Format arms ported from Meetily's `ModernAudioStream::build_stream`.
fn build_input_stream(
    device: &Device,
    config: &SupportedStreamConfig,
    out: mpsc::UnboundedSender<AudioChunk>,
) -> Result<cpal::Stream> {
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let config_copy = config.clone();

    // Receiver may be gone during shutdown — sending into a closed channel
    // from the realtime callback is harmless, so errors are ignored.
    fn forward(out: &mpsc::UnboundedSender<AudioChunk>, samples: Vec<f32>, sample_rate: u32) {
        let _ = out.send(AudioChunk {
            samples,
            sample_rate,
        });
    }

    let err_fn = |err: cpal::StreamError| {
        error!("Microphone stream error: {}", err);
    };

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config_copy.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                forward(&out, downmix_to_mono(data, channels), sample_rate);
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config_copy.into(),
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let f32_data: Vec<f32> = data
                    .iter()
                    .map(|&sample| sample as f32 / i16::MAX as f32)
                    .collect();
                forward(&out, downmix_to_mono(&f32_data, channels), sample_rate);
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config_copy.into(),
            move |data: &[i32], _: &cpal::InputCallbackInfo| {
                let f32_data: Vec<f32> = data
                    .iter()
                    .map(|&sample| sample as f32 / i32::MAX as f32)
                    .collect();
                forward(&out, downmix_to_mono(&f32_data, channels), sample_rate);
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I8 => device.build_input_stream(
            &config_copy.into(),
            move |data: &[i8], _: &cpal::InputCallbackInfo| {
                let f32_data: Vec<f32> = data
                    .iter()
                    .map(|&sample| sample as f32 / i8::MAX as f32)
                    .collect();
                forward(&out, downmix_to_mono(&f32_data, channels), sample_rate);
            },
            err_fn,
            None,
        )?,
        other => {
            return Err(anyhow!("Unsupported sample format: {:?}", other));
        }
    };

    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_frames() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(downmix_to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn downmix_mono_is_identity() {
        let mono = [0.1, 0.2, 0.3];
        assert_eq!(downmix_to_mono(&mono, 1), mono.to_vec());
    }
}
