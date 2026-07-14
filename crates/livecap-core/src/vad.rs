//! Silero VAD utterance segmentation.
//!
//! Ported from Meetily `src/audio/vad.rs` (MIT). The continuous processor
//! consumes audio in 30 ms chunks and yields complete speech segments.
//! LiveCap additions for live captioning: access to the in-progress speech
//! buffer (for partial transcriptions) and a force-cut for very long
//! utterances.

use anyhow::{anyhow, Result};
use log::{debug, info, warn};
use silero_rs::{VadConfig, VadSession, VadTransition};
use std::collections::VecDeque;
use std::time::Duration;

/// Silero VAD requires 16 kHz input.
pub const VAD_SAMPLE_RATE: u32 = 16000;

/// Placeholder confidence for a segment we cut/ended ourselves (force-cut on a
/// very long utterance, or a flush at capture stop) rather than one Silero
/// completed on its own. Named so the two forced sites stay in lockstep if these
/// heuristics are ever retuned.
const FORCED_SEGMENT_CONFIDENCE: f32 = 0.8;

/// Placeholder confidence for a segment Silero completed via a natural SpeechEnd.
const VAD_SEGMENT_CONFIDENCE: f32 = 0.9;

/// Represents a complete speech segment detected by VAD.
#[derive(Debug, Clone)]
pub struct SpeechSegment {
    pub samples: Vec<f32>,
    pub start_timestamp_ms: f64,
    pub end_timestamp_ms: f64,
    pub confidence: f32,
}

/// Processes audio in 30 ms chunks but returns complete speech segments.
pub struct ContinuousVadProcessor {
    session: VadSession,
    chunk_size: usize,
    sample_rate: u32,
    buffer: Vec<f32>,
    speech_segments: VecDeque<SpeechSegment>,
    current_speech: Vec<f32>,
    in_speech: bool,
    processed_samples: usize,
    speech_start_sample: usize,
    // A force-cut happened during the current speech run (#138/#162): Silero
    // keeps accumulating `session_audio` from the ORIGINAL speech start, so the
    // eventual SpeechEnd transition re-contains the audio we already finalized.
    // When this is set we use our own post-cut `current_speech` for the final
    // segment instead, avoiding both the duplicate captions AND the
    // channel-killing panic that draining Silero's buffer would cause (this
    // Silero rev's SpeechEnd reads a state-enum start_ms that `take_until`
    // cannot advance).
    force_cut_pending: bool,
    // State tracking for smart logging
    last_logged_state: bool,
}

impl ContinuousVadProcessor {
    /// `input_sample_rate` is the rate of audio passed to [`Self::process_audio`];
    /// non-16 kHz input is resampled internally. `redemption_time_ms` is how
    /// long a silence gap may be before the utterance is considered finished —
    /// for live captions keep this short (LiveCap default: 800 ms) so
    /// finalized text lands quickly after the speaker stops.
    pub fn new(input_sample_rate: u32, redemption_time_ms: u32) -> Result<Self> {
        // Tuned in Meetily for capturing complete utterances without
        // fragmenting continuous speech.
        let config = VadConfig {
            sample_rate: VAD_SAMPLE_RATE as usize,
            positive_speech_threshold: 0.50, // Silero default — good for continuous speech
            negative_speech_threshold: 0.35, // Silero default — allows natural pauses
            redemption_time: Duration::from_millis(redemption_time_ms as u64),
            pre_speech_pad: Duration::from_millis(300), // pre-speech padding for context
            post_speech_pad: Duration::from_millis(400), // more context at the end
            min_speech_time: Duration::from_millis(250), // prevent tiny fragments
        };

        debug!(
            "Creating VAD session: sample_rate={}Hz, redemption={}ms, min_speech=250ms, input_rate={}Hz",
            VAD_SAMPLE_RATE, redemption_time_ms, input_sample_rate
        );

        let session = VadSession::new(config)
            .map_err(|e| anyhow!("Failed to create VAD session: {:?}", e))?;

        // VAD uses 30ms chunks at 16kHz (480 samples)
        let vad_chunk_size = (VAD_SAMPLE_RATE as f32 * 0.03) as usize;

        Ok(Self {
            session,
            chunk_size: vad_chunk_size,
            sample_rate: input_sample_rate,
            buffer: Vec::with_capacity(vad_chunk_size * 2),
            speech_segments: VecDeque::new(),
            current_speech: Vec::new(),
            in_speech: false,
            processed_samples: 0,
            speech_start_sample: 0,
            force_cut_pending: false,
            last_logged_state: false,
        })
    }

    /// Process incoming audio samples and return any complete speech segments.
    /// Handles resampling from the input sample rate to 16 kHz.
    pub fn process_audio(&mut self, samples: &[f32]) -> Result<Vec<SpeechSegment>> {
        let resampled_audio = if self.sample_rate == VAD_SAMPLE_RATE {
            samples.to_vec()
        } else {
            self.resample_to_16k(samples)?
        };

        self.buffer.extend_from_slice(&resampled_audio);
        let mut completed_segments = Vec::new();

        // Process complete 30ms chunks (480 samples at 16kHz)
        while self.buffer.len() >= self.chunk_size {
            let chunk: Vec<f32> = self.buffer.drain(..self.chunk_size).collect();
            self.process_chunk(&chunk)?;

            while let Some(segment) = self.speech_segments.pop_front() {
                completed_segments.push(segment);
            }
        }

        Ok(completed_segments)
    }

    /// Whether the processor is currently inside a speech region.
    pub fn in_speech(&self) -> bool {
        self.in_speech
    }

    /// The samples accumulated for the utterance currently in progress
    /// (16 kHz). Used to produce partial transcriptions while the speaker is
    /// still talking.
    pub fn current_speech(&self) -> &[f32] {
        &self.current_speech
    }

    /// Force-cut the utterance currently in progress and return it as a
    /// segment, keeping the session in speech state. Used to bound utterance
    /// length when someone talks for a very long time without pausing.
    pub fn take_current_speech(&mut self) -> Option<SpeechSegment> {
        if !self.in_speech || self.current_speech.is_empty() {
            return None;
        }
        let ms_per_sample = 1000.0 / VAD_SAMPLE_RATE as f64;
        let start_ms = self.speech_start_sample as f64 * ms_per_sample;
        let end_ms = (self.processed_samples as f64 * ms_per_sample).max(start_ms);

        // Return our own post-cut accumulation and reset it; mark that a
        // force-cut happened so the eventual SpeechEnd uses `current_speech`
        // (the tail since this cut) rather than Silero's transition `samples`,
        // which re-contain everything from the original speech start (#138/#162).
        // We deliberately do NOT drain Silero's internal buffer: this Silero rev
        // emits SpeechEnd against a state-enum `start_ms` that `take_until`
        // cannot advance, so draining makes the next SpeechEnd PANIC (crashing
        // the channel worker — strictly worse than the duplication it fixed).
        self.force_cut_pending = true;
        let segment = SpeechSegment {
            samples: std::mem::take(&mut self.current_speech),
            start_timestamp_ms: start_ms,
            end_timestamp_ms: end_ms,
            confidence: FORCED_SEGMENT_CONFIDENCE,
        };
        self.speech_start_sample = self.processed_samples;
        Some(segment)
    }

    /// Resampling from the input sample rate to 16 kHz with basic
    /// anti-aliasing (moving-average low-pass + linear interpolation).
    fn resample_to_16k(&self, samples: &[f32]) -> Result<Vec<f32>> {
        if self.sample_rate == VAD_SAMPLE_RATE {
            return Ok(samples.to_vec());
        }

        let ratio = self.sample_rate as f64 / VAD_SAMPLE_RATE as f64;
        let output_len = (samples.len() as f64 / ratio) as usize;
        let mut resampled = Vec::with_capacity(output_len);

        // Simple moving average filter (basic low-pass) before downsampling.
        let filter_size = 3usize;
        let mut filtered_samples = Vec::with_capacity(samples.len());
        for i in 0..samples.len() {
            let start = i.saturating_sub(filter_size);
            let end = std::cmp::min(i + filter_size + 1, samples.len());
            let sum: f32 = samples[start..end].iter().sum();
            filtered_samples.push(sum / (end - start) as f32);
        }

        // Linear interpolation downsampling.
        for i in 0..output_len {
            let source_pos = i as f64 * ratio;
            let source_index = source_pos as usize;
            let fraction = source_pos - source_index as f64;

            if source_index + 1 < filtered_samples.len() {
                let sample1 = filtered_samples[source_index];
                let sample2 = filtered_samples[source_index + 1];
                resampled.push(sample1 + (sample2 - sample1) * fraction as f32);
            } else if source_index < filtered_samples.len() {
                resampled.push(filtered_samples[source_index]);
            }
        }

        Ok(resampled)
    }

    /// Flush any remaining audio and return final speech segments.
    pub fn flush(&mut self) -> Result<Vec<SpeechSegment>> {
        debug!(
            "VAD flush: in_speech={}, current_speech_len={}, buffer_len={}, queued={}",
            self.in_speech,
            self.current_speech.len(),
            self.buffer.len(),
            self.speech_segments.len()
        );

        let mut completed_segments = Vec::new();

        // Process any remaining buffered audio (padded to a full chunk).
        if !self.buffer.is_empty() {
            let mut padded_chunk = std::mem::take(&mut self.buffer);
            if padded_chunk.len() < self.chunk_size {
                padded_chunk.resize(self.chunk_size, 0.0);
            }
            self.process_chunk(&padded_chunk)?;
        }

        // Force end any ongoing speech.
        if self.in_speech && !self.current_speech.is_empty() {
            let ms_per_sample = 1000.0 / VAD_SAMPLE_RATE as f64;
            let start_ms = self.speech_start_sample as f64 * ms_per_sample;
            let end_ms = (self.processed_samples as f64 * ms_per_sample).max(start_ms);

            debug!(
                "VAD flush: force-ending speech — start={start_ms}ms, end={end_ms}ms, samples={}",
                self.current_speech.len()
            );

            self.speech_segments.push_back(SpeechSegment {
                samples: std::mem::take(&mut self.current_speech),
                start_timestamp_ms: start_ms,
                end_timestamp_ms: end_ms,
                confidence: FORCED_SEGMENT_CONFIDENCE,
            });
            self.in_speech = false;
        }

        while let Some(segment) = self.speech_segments.pop_front() {
            completed_segments.push(segment);
        }

        Ok(completed_segments)
    }

    fn process_chunk(&mut self, chunk: &[f32]) -> Result<()> {
        let current_speech_size = self.current_speech.len();
        if current_speech_size > 1_000_000 {
            // More than ~62 seconds of accumulated speech at 16 kHz.
            warn!(
                "VAD: accumulated speech buffer is large: {} samples ({:.1}s)",
                current_speech_size,
                current_speech_size as f64 / VAD_SAMPLE_RATE as f64
            );
        }

        let transitions = self
            .session
            .process(chunk)
            .map_err(|e| anyhow!("VAD processing failed: {}", e))?;

        for transition in transitions {
            match transition {
                VadTransition::SpeechStart { timestamp_ms } => {
                    if !self.last_logged_state {
                        debug!("VAD: speech started at {}ms", timestamp_ms);
                        self.last_logged_state = true;
                    }
                    self.in_speech = true;
                    // Silero's timestamp is absolute session time (fix over
                    // Meetily, which added processed_samples on top and
                    // produced inflated start timestamps on forced ends).
                    self.speech_start_sample = timestamp_ms * VAD_SAMPLE_RATE as usize / 1000;
                    self.current_speech.clear();
                    // Fresh utterance — no force-cut has happened for it yet.
                    self.force_cut_pending = false;
                }
                VadTransition::SpeechEnd {
                    start_timestamp_ms,
                    end_timestamp_ms,
                    samples,
                } => {
                    if self.last_logged_state {
                        debug!(
                            "VAD: speech ended at {}ms (duration: {}ms)",
                            end_timestamp_ms,
                            end_timestamp_ms - start_timestamp_ms
                        );
                        self.last_logged_state = false;
                    }
                    self.in_speech = false;

                    // After a force-cut, Silero's transition `samples` re-contain
                    // the audio already finalized by the cut(s) — using them
                    // would duplicate captions (#138/#162). Our own
                    // `current_speech` was reset at the last cut and holds only
                    // the tail since then, so use it instead. Otherwise prefer
                    // the transition samples (they carry Silero's pre/post
                    // padding); fall back to `current_speech` when empty.
                    let was_force_cut = self.force_cut_pending;
                    let speech_samples = if was_force_cut {
                        std::mem::take(&mut self.current_speech)
                    } else if !samples.is_empty() {
                        samples
                    } else {
                        self.current_speech.clone()
                    };
                    self.force_cut_pending = false;

                    if !speech_samples.is_empty() {
                        // After a force-cut the tail audio starts at the cut
                        // point, NOT Silero's original speech start — otherwise
                        // this tail segment would overlap the already-finalized
                        // force-cut segment in time and report an inflated
                        // duration for only the tail (#162). `speech_start_sample`
                        // was reset to the cut point in `take_current_speech`.
                        let start_ms = if was_force_cut {
                            self.speech_start_sample as f64 * 1000.0 / VAD_SAMPLE_RATE as f64
                        } else {
                            start_timestamp_ms as f64
                        };
                        let segment = SpeechSegment {
                            samples: speech_samples,
                            start_timestamp_ms: start_ms,
                            end_timestamp_ms: end_timestamp_ms as f64,
                            confidence: VAD_SEGMENT_CONFIDENCE,
                        };

                        info!(
                            "VAD: completed speech segment: {:.1}ms duration, {} samples",
                            end_timestamp_ms as f64 - start_ms,
                            segment.samples.len()
                        );

                        self.speech_segments.push_back(segment);
                    }

                    self.current_speech.clear();
                }
            }
        }

        // Accumulate speech if we're currently in a speech state.
        if self.in_speech {
            self.current_speech.extend_from_slice(chunk);
        }

        self.processed_samples += chunk.len();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate synthetic speech-like audio with alternating speech/silence:
    /// bursts of harmonics with amplitude modulation, 5 s of "speech" at the
    /// start of every 10 s cycle.
    fn generate_test_audio_with_speech(duration_seconds: f32, sample_rate: u32) -> Vec<f32> {
        let total_samples = (duration_seconds * sample_rate as f32) as usize;
        let mut samples = vec![0.0f32; total_samples];

        let speech_interval = 10.0;
        let speech_duration = 5.0;

        for (i, sample) in samples.iter_mut().enumerate() {
            let time = i as f32 / sample_rate as f32;
            let cycle_time = time % speech_interval;

            if cycle_time < speech_duration {
                let freq1 = 200.0 + (time * 50.0).sin() * 100.0;
                let freq2 = freq1 * 2.0;
                let freq3 = freq1 * 3.0;

                let amplitude = 0.3 + 0.1 * (time * 5.0).sin();
                *sample = amplitude
                    * (0.5 * (2.0 * std::f32::consts::PI * freq1 * time).sin()
                        + 0.3 * (2.0 * std::f32::consts::PI * freq2 * time).sin()
                        + 0.2 * (2.0 * std::f32::consts::PI * freq3 * time).sin());
            }
        }

        samples
    }

    #[test]
    fn vad_state_is_maintained_across_chunks() {
        let mut processor =
            ContinuousVadProcessor::new(16000, 2000).expect("Failed to create processor");

        let chunk_size = 160_000; // 10 seconds
        let audio = generate_test_audio_with_speech(30.0, 16000);

        let mut all_segments = Vec::new();
        for chunk in audio.chunks(chunk_size) {
            let segments = processor.process_audio(chunk).expect("Processing failed");
            all_segments.extend(segments);
        }
        all_segments.extend(processor.flush().expect("Flush failed"));

        assert!(!all_segments.is_empty(), "Expected at least 1 speech segment");
        assert!(all_segments.iter().all(|s| !s.samples.is_empty()
            && s.end_timestamp_ms > s.start_timestamp_ms));
    }

    #[test]
    fn longer_redemption_does_not_fragment_more() {
        let audio = generate_test_audio_with_speech(60.0, 16000);

        let run = |redemption: u32| -> Vec<SpeechSegment> {
            let mut p = ContinuousVadProcessor::new(16000, redemption).unwrap();
            let mut segments = p.process_audio(&audio).unwrap();
            segments.extend(p.flush().unwrap());
            segments
        };

        let segments_400 = run(400);
        let segments_2000 = run(2000);

        // Guard against a vacuous pass (#176): if this Silero build ever stops
        // classifying the synthetic generator as speech, both runs return 0 and the
        // `<=` below would pass silently (0 <= 0). Require the baseline to have
        // produced segments so the comparison is real — a failure here signals the
        // synthetic fixture needs porting to a real-speech WAV (cf. force_cut_wav).
        assert!(
            !segments_400.is_empty(),
            "precondition: the synthetic generator must be detected as speech; 0 segments \
             makes the redemption comparison vacuous (Silero build changed?)"
        );

        // Longer redemption bridges more pauses, so it must not produce more
        // segments than the short one.
        assert!(
            segments_2000.len() <= segments_400.len(),
            "2000ms redemption ({}) produced more segments than 400ms ({})",
            segments_2000.len(),
            segments_400.len()
        );
    }

    #[test]
    fn take_current_speech_force_cuts_utterance() {
        let mut p = ContinuousVadProcessor::new(16000, 2000).unwrap();
        // 4 seconds of continuous "speech".
        let audio: Vec<f32> = generate_test_audio_with_speech(4.0, 16000);
        let _ = p.process_audio(&audio).unwrap();

        if p.in_speech() {
            let len_before = p.current_speech().len();
            assert!(len_before > 0);
            let segment = p.take_current_speech().expect("expected a forced segment");
            assert_eq!(segment.samples.len(), len_before);
            assert!(
                segment.end_timestamp_ms >= segment.start_timestamp_ms,
                "forced segment has inverted timestamps: {}..{}",
                segment.start_timestamp_ms,
                segment.end_timestamp_ms
            );
            assert!(p.in_speech(), "force cut must keep the in-speech state");
            assert!(p.current_speech().is_empty());
        } else {
            // The synthetic signal was not detected as speech on this Silero
            // version; the API contract still holds:
            assert!(p.take_current_speech().is_none());
        }
    }

    // NOTE (#176 — corrected): the force-cut → natural-SpeechEnd no-duplication /
    // no-panic invariant (#138/#162) is covered by the REAL-SPEECH integration
    // test in `tests/force_cut_wav.rs`, which drives the exact production path with
    // realistic utterance timing (the #162 panic reproduced only there). The
    // synthetic-harmonic generator above IS classified as speech by this Silero
    // build — `vad_state_is_maintained_across_chunks` asserts non-empty segments
    // and passes, so the earlier claim that it is "never" detected was wrong — but
    // the continuous synthetic signal does not reproduce the force-cut → natural
    // end sequence. Because these two unit tests DO depend on synthetic detection,
    // they are Silero-version-sensitive: a model bump that changes detection would
    // fail `vad_state_is_maintained_across_chunks` (and trip the vacuity guard in
    // `longer_redemption_does_not_fragment_more`), signalling the fixtures need a
    // refresh rather than passing on false confidence.
}
