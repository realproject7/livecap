//! The two-channel live-caption pipeline.
//!
//! Audio flow per channel (mic and system are fully independent — no mixing):
//!
//! ```text
//! capture (cpal / Core Audio tap)
//!   -> mono PCM chunks (AudioChunk)
//!   -> StreamResampler (-> 16 kHz)
//!   -> ContinuousVadProcessor (Silero) — utterance segmentation
//!   -> WhisperEngine (whisper.cpp, Metal) — shared transcription worker
//!   -> CaptionEvent { channel, Partial | Finalized }
//! ```
//!
//! The same path serves live capture and offline audio: tests feed decoded
//! WAV chunks through [`CaptionPipeline::feeder`], exactly like the capture
//! threads do.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::device::AudioDevice;
use crate::audio::mic::MicCapture;
use crate::audio::system::SystemAudioCapture;
use crate::audio::AudioChunk;
use crate::debug_dump::ChannelDump;
use crate::event::{CaptionEvent, CaptionKind, Channel};
use crate::model::ModelManager;
use crate::resample::StreamResampler;
use crate::suppression::{rms, CrossChannelSuppressor, SuppressionConfig};
use crate::vad::{ContinuousVadProcessor, VAD_SAMPLE_RATE};
use crate::whisper::WhisperEngine;

/// Pipeline configuration. The models directory is always injected — the
/// crate never decides where model files live.
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    /// Directory for whisper model files (downloaded on first use).
    pub models_dir: PathBuf,
    /// Whisper model name; see [`crate::model::MODEL_NAMES`].
    pub model: String,
    /// Transcription language: `None` auto-detects per utterance;
    /// `Some("auto-translate")` translates to English; otherwise an
    /// ISO-639-1 code.
    pub language: Option<String>,
    /// How often partial transcriptions are produced while an utterance is
    /// in progress.
    pub partial_interval_ms: u64,
    /// Silence gap (ms) after which an utterance is finalized. Smaller =
    /// snappier finals, larger = fewer mid-sentence cuts.
    pub vad_redemption_ms: u32,
    /// Utterances longer than this are force-finalized in slices.
    pub max_utterance_ms: u64,
}

impl PipelineConfig {
    pub fn new(models_dir: impl Into<PathBuf>) -> Self {
        Self {
            models_dir: models_dir.into(),
            model: crate::model::DEFAULT_MODEL.to_string(),
            language: None,
            partial_interval_ms: 1200,
            vad_redemption_ms: 800,
            max_utterance_ms: 30_000,
        }
    }

    /// Set the whisper model by name (#110); see [`crate::model::MODEL_NAMES`].
    /// The model is downloaded (SHA-256 verified) on first use when the
    /// pipeline builds.
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = model.to_string();
        self
    }

    /// Set the spoken/source transcription language (#94). A BCP-47 / ISO-639-1
    /// code forces whisper to that language; `"auto"` (or empty) keeps the
    /// current per-utterance auto-detection (`language = None`). Whisper only
    /// understands a primary subtag, so a tag like `"pt-br"` is reduced to its
    /// primary subtag (`"pt"`) before being handed to the engine.
    pub fn with_source_language(mut self, code: &str) -> Self {
        let normalized = code.trim().to_lowercase();
        self.language = match normalized.as_str() {
            "" | "auto" => None,
            other => Some(other.split('-').next().unwrap_or(other).to_string()),
        };
        self
    }
}

/// A request handed to the shared transcription worker.
struct TranscribeRequest {
    channel: Channel,
    samples: Vec<f32>,
    kind: RequestKind,
    queued_at: Instant,
}

enum RequestKind {
    Partial,
    Finalized { start_ms: u64, end_ms: u64 },
    /// A mic utterance that had already streamed partials was energy-gated as
    /// bleed (#56): no transcription, but the worker must tell consumers to drop
    /// the orphaned streaming block (#62). Routed through the same queue so it
    /// is ordered AFTER the partials it cancels (carries no samples).
    DropPartial,
}

/// The two-channel live caption pipeline. See the module docs for the data
/// flow. Create with [`CaptionPipeline::new`], start capture (or feed PCM
/// manually), read [`CaptionEvent`]s from the receiver returned by `new`,
/// and call [`CaptionPipeline::finish`] to drain and shut down.
pub struct CaptionPipeline {
    config: PipelineConfig,
    events_tx: mpsc::UnboundedSender<CaptionEvent>,
    transcribe_tx: Option<mpsc::UnboundedSender<TranscribeRequest>>,
    transcribe_task: JoinHandle<()>,
    worker_tasks: Vec<JoinHandle<()>>,
    mic_capture: Option<MicCapture>,
    system_capture: Option<SystemAudioCapture>,
    /// Shared cross-channel speaker-bleed suppression (#56).
    suppressor: Arc<CrossChannelSuppressor>,
    /// Monotonic session clock: the common timeline both channels report
    /// energy/finalizations against, so the suppressor can correlate them (#56).
    start: Instant,
}

impl CaptionPipeline {
    /// Build the pipeline: ensures the configured model is downloaded
    /// (SHA-256 verified) and loaded, and starts the transcription worker.
    /// Returns the pipeline and the caption event receiver.
    pub async fn new(
        config: PipelineConfig,
    ) -> Result<(Self, mpsc::UnboundedReceiver<CaptionEvent>)> {
        let manager = ModelManager::new(config.models_dir.clone());
        let model_path = manager.ensure_model(&config.model).await?;

        let model_name = config.model.clone();
        let engine = tokio::task::spawn_blocking(move || {
            WhisperEngine::load(&model_path, &model_name)
        })
        .await
        .map_err(|e| anyhow!("Model load task failed: {e}"))??;
        let engine = Arc::new(engine);

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (transcribe_tx, transcribe_rx) = mpsc::unbounded_channel();

        let suppressor = Arc::new(CrossChannelSuppressor::new(SuppressionConfig::from_env()));
        let start = Instant::now();

        let transcribe_task = tokio::spawn(transcribe_worker(
            engine,
            config.language.clone(),
            transcribe_rx,
            events_tx.clone(),
            suppressor.clone(),
            start,
        ));

        Ok((
            Self {
                config,
                events_tx,
                transcribe_tx: Some(transcribe_tx),
                transcribe_task,
                worker_tasks: Vec::new(),
                mic_capture: None,
                system_capture: None,
                suppressor,
                start,
            },
            events_rx,
        ))
    }

    /// Convenience: start both captures. `mic`/`system`: `Some(device)`
    /// captures from that device, `None` skips the channel entirely. Use
    /// [`Self::start_mic`] / [`Self::start_system`] for default-device
    /// capture of a single channel.
    pub fn start_capture(
        &mut self,
        mic: Option<AudioDevice>,
        system: Option<AudioDevice>,
    ) -> Result<()> {
        if mic.is_none() && system.is_none() {
            return Err(anyhow!("At least one of mic/system must be provided"));
        }
        if let Some(mic_device) = mic {
            self.start_mic(Some(mic_device))?;
        }
        if let Some(system_device) = system {
            self.start_system(Some(&system_device))?;
        }
        Ok(())
    }

    /// Start microphone capture (`None` = system default input device) on
    /// the [`Channel::Mic`] channel.
    pub fn start_mic(&mut self, device: Option<AudioDevice>) -> Result<()> {
        if self.mic_capture.is_some() {
            return Err(anyhow!("Microphone capture is already running"));
        }
        let feeder = self.feeder(Channel::Mic);
        self.mic_capture = Some(MicCapture::start(device, feeder)?);
        Ok(())
    }

    /// Start system-audio capture on the [`Channel::System`] channel. On
    /// macOS this is a global Core Audio tap (the device argument is
    /// informational); on other platforms this returns
    /// [`crate::error::CoreError::SystemAudioUnavailable`].
    pub fn start_system(&mut self, device: Option<&AudioDevice>) -> Result<()> {
        if self.system_capture.is_some() {
            return Err(anyhow!("System-audio capture is already running"));
        }
        let feeder = self.feeder(Channel::System);
        self.system_capture = Some(SystemAudioCapture::start(device, feeder)?);
        Ok(())
    }

    /// Stop live capture WITHOUT shutting the pipeline down (#11 pause):
    /// capture threads stop and each channel's VAD state flushes (any
    /// trailing speech is finalized). Capture can be started again on the
    /// same pipeline to resume.
    pub fn stop_capture(&mut self) {
        self.mic_capture.take();
        self.system_capture.take();
    }

    /// Stop ONLY the microphone capture (#53 mid-session mic toggle): the
    /// mic channel's VAD flushes (trailing speech finalizes) while system
    /// capture continues. [`Self::start_mic`] resumes it on the same
    /// pipeline.
    pub fn stop_mic(&mut self) {
        self.mic_capture.take();
    }

    /// Whether microphone capture is currently running.
    pub fn mic_running(&self) -> bool {
        self.mic_capture.is_some()
    }

    /// Create a raw PCM feeder for `channel`, spawning its processing
    /// worker. Capture threads use this internally; tests and other audio
    /// sources can use it directly — close the feeder (drop the sender) to
    /// flush the channel's VAD state.
    pub fn feeder(&mut self, channel: Channel) -> mpsc::UnboundedSender<AudioChunk> {
        let (tx, rx) = mpsc::unbounded_channel();
        let transcribe_tx = self
            .transcribe_tx
            .clone()
            .expect("transcribe_tx alive until finish()");
        let params = WorkerParams {
            partial_interval_ms: self.config.partial_interval_ms,
            vad_redemption_ms: self.config.vad_redemption_ms,
            max_utterance_ms: self.config.max_utterance_ms,
        };
        self.worker_tasks.push(tokio::spawn(channel_worker(
            channel,
            rx,
            transcribe_tx,
            params,
            self.suppressor.clone(),
            self.start,
        )));
        tx
    }

    /// Stop captures, flush all channels, wait for in-flight transcriptions,
    /// and shut down. Any feeders handed out via [`Self::feeder`] must be
    /// dropped by the caller before this resolves fully.
    pub async fn finish(mut self) -> Result<()> {
        // Stop captures: drops their chunk senders, ending channel workers.
        self.mic_capture.take();
        self.system_capture.take();

        // Wait for channel workers to flush their VAD state and exit.
        for task in self.worker_tasks.drain(..) {
            let _ = task.await;
        }

        // Close the transcribe queue and wait for it to drain.
        self.transcribe_tx.take();
        let _ = (&mut self.transcribe_task).await;

        drop(self.events_tx);
        Ok(())
    }
}

struct WorkerParams {
    partial_interval_ms: u64,
    vad_redemption_ms: u32,
    max_utterance_ms: u64,
}

/// Per-channel worker: resample -> VAD -> transcription requests.
async fn channel_worker(
    channel: Channel,
    rx: mpsc::UnboundedReceiver<AudioChunk>,
    transcribe_tx: mpsc::UnboundedSender<TranscribeRequest>,
    params: WorkerParams,
    suppressor: Arc<CrossChannelSuppressor>,
    start: Instant,
) {
    if let Err(e) = channel_worker_inner(channel, rx, transcribe_tx, params, suppressor, start).await
    {
        log::error!("Channel worker for {channel} failed: {e:#}");
    }
}

async fn channel_worker_inner(
    channel: Channel,
    mut rx: mpsc::UnboundedReceiver<AudioChunk>,
    transcribe_tx: mpsc::UnboundedSender<TranscribeRequest>,
    params: WorkerParams,
    suppressor: Arc<CrossChannelSuppressor>,
    start: Instant,
) -> Result<()> {
    let samples_per_ms = VAD_SAMPLE_RATE as usize / 1000;
    let partial_step = params.partial_interval_ms as usize * samples_per_ms;
    let max_utterance = params.max_utterance_ms as usize * samples_per_ms;
    let min_partial = 500 * samples_per_ms; // don't transcribe partials under 0.5 s

    let mut resampler = StreamResampler::new(VAD_SAMPLE_RATE);
    let mut vad = ContinuousVadProcessor::new(VAD_SAMPLE_RATE, params.vad_redemption_ms)?;
    let mut last_partial_len = 0usize;
    // Whether the current utterance has already emitted a partial to consumers.
    // If it has and the utterance is then suppressed as bleed, we must cancel
    // that orphaned partial (#62). Reset at every utterance boundary.
    let mut streamed_partial = false;

    // Gated raw-WAV fixture dump (#64): OFF unless LIVECAP_BLEED_DUMP_DIR is set.
    // Captures the exact 16 kHz stream the VAD/suppressor see, for tuning bleed
    // thresholds against real acoustics. Privacy: explicit opt-in only (EPIC #1).
    let mut dump = std::env::var_os("LIVECAP_BLEED_DUMP_DIR").and_then(|dir| {
        match ChannelDump::create(Path::new(&dir), channel) {
            Ok(d) => {
                log::warn!("[#64] bleed audio dump ENABLED for {channel} (raw 16 kHz WAV, debug only)");
                Some(d)
            }
            Err(e) => {
                log::error!("[#64] could not open bleed dump for {channel}: {e}");
                None
            }
        }
    });

    // Energy gate (#56): on the mic channel, drop a segment that is attenuated
    // speaker bleed concurrent with the system channel, before it costs a
    // transcription. Always false on the system channel and when there is no
    // concurrent system energy, so distinct mic speech is untouched.
    let is_mic_bleed = |samples: &[f32], duration_ms: u64| -> bool {
        if channel != Channel::Mic {
            return false;
        }
        let now_ms = start.elapsed().as_millis() as u64;
        suppressor.mic_segment_is_energy_bleed(now_ms, duration_ms, rms(samples))
    };

    let send_final = |segment: crate::vad::SpeechSegment, streamed_partial: bool| {
        let duration_ms = (segment.end_timestamp_ms - segment.start_timestamp_ms).max(0.0) as u64;
        if is_mic_bleed(segment.samples.as_slice(), duration_ms) {
            log::info!("[mic] energy-gated speaker bleed ({duration_ms} ms) suppressed (#56)");
            // If this utterance already streamed partials to consumers, cancel
            // that orphaned streaming block so it does not linger or poison the
            // next genuine utterance (#62). Ordered after the partials it cancels
            // because it shares their queue.
            if streamed_partial {
                let _ = transcribe_tx.send(TranscribeRequest {
                    channel,
                    samples: Vec::new(),
                    kind: RequestKind::DropPartial,
                    queued_at: Instant::now(),
                });
            }
            return;
        }
        let _ = transcribe_tx.send(TranscribeRequest {
            channel,
            samples: segment.samples,
            kind: RequestKind::Finalized {
                start_ms: segment.start_timestamp_ms.max(0.0) as u64,
                end_ms: segment.end_timestamp_ms.max(0.0) as u64,
            },
            queued_at: Instant::now(),
        });
    };

    while let Some(chunk) = rx.recv().await {
        let samples_16k = resampler.process(&chunk.samples, chunk.sample_rate)?;
        if samples_16k.is_empty() {
            continue;
        }

        // Capture the resampled stream for offline tuning when the dump is on (#64).
        if let Some(d) = dump.as_mut() {
            d.write(&samples_16k);
        }

        // Publish the system channel's energy envelope for the gate (#56).
        if channel == Channel::System {
            let now_ms = start.elapsed().as_millis() as u64;
            suppressor.record_system_energy(now_ms, rms(&samples_16k));
        }

        for segment in vad.process_audio(&samples_16k)? {
            send_final(segment, streamed_partial);
            last_partial_len = 0;
            streamed_partial = false;
        }

        if vad.in_speech() {
            let current_len = vad.current_speech().len();
            if current_len >= max_utterance {
                // Bound utterance length: force-finalize the slice so far.
                if let Some(segment) = vad.take_current_speech() {
                    send_final(segment, streamed_partial);
                    last_partial_len = 0;
                    streamed_partial = false;
                }
            } else if current_len >= min_partial && current_len >= last_partial_len + partial_step
            {
                last_partial_len = current_len;
                let partial_samples = vad.current_speech().to_vec();
                let duration_ms = (current_len / samples_per_ms) as u64;
                // Suppress in-progress bleed partials too, so the live mic view
                // doesn't stream the speaker's garbled echo (#56).
                if !is_mic_bleed(partial_samples.as_slice(), duration_ms) {
                    streamed_partial = true;
                    let _ = transcribe_tx.send(TranscribeRequest {
                        channel,
                        samples: partial_samples,
                        kind: RequestKind::Partial,
                        queued_at: Instant::now(),
                    });
                }
            }
        } else {
            last_partial_len = 0;
            streamed_partial = false;
        }
    }

    // Source closed: flush remaining speech.
    for segment in vad.flush()? {
        send_final(segment, streamed_partial);
        streamed_partial = false;
    }
    Ok(())
}

/// Rolling real-time-factor watch over FINALS (#141). `record_final(rtf)` returns
/// true EXACTLY ONCE per "falling behind" episode: when the mean RTF over the
/// last `WINDOW` finals first crosses `FALLING_BEHIND`. It re-arms only after the
/// mean drops back below `RECOVERED` (hysteresis), so a session that hovers near
/// the threshold does not spam the notice.
struct RtfWatch {
    recent: std::collections::VecDeque<f64>,
    notified: bool,
}

impl RtfWatch {
    const WINDOW: usize = 5;
    const FALLING_BEHIND: f64 = 0.7;
    const RECOVERED: f64 = 0.5;

    fn new() -> Self {
        Self {
            recent: std::collections::VecDeque::with_capacity(Self::WINDOW),
            notified: false,
        }
    }

    /// Record one final's real-time factor; returns true iff this is the crossing
    /// that should emit the notice.
    fn record_final(&mut self, rtf: f64) -> bool {
        if self.recent.len() == Self::WINDOW {
            self.recent.pop_front();
        }
        self.recent.push_back(rtf);
        if self.recent.len() < Self::WINDOW {
            return false;
        }
        let mean = self.recent.iter().sum::<f64>() / Self::WINDOW as f64;
        if !self.notified && mean > Self::FALLING_BEHIND {
            self.notified = true;
            return true;
        }
        if self.notified && mean < Self::RECOVERED {
            self.notified = false; // recovered — re-arm for a new episode
        }
        false
    }
}

/// Shared transcription worker: serializes whisper calls (one context, one
/// state at a time) so mic and system channels never contend on the GPU.
async fn transcribe_worker(
    engine: Arc<WhisperEngine>,
    language: Option<String>,
    mut rx: mpsc::UnboundedReceiver<TranscribeRequest>,
    events_tx: mpsc::UnboundedSender<CaptionEvent>,
    suppressor: Arc<CrossChannelSuppressor>,
    start: Instant,
) {
    // Per-channel language pinned for the in-progress utterance (#140, M1). In
    // AUTO mode the first partial's detected language is pinned so subsequent
    // PARTIALS skip whisper's extra per-call auto-detect encoder pass; the final
    // always re-detects. Keyed by channel because mic and system utterances
    // interleave through this one worker.
    let mut pinned_lang: HashMap<Channel, String> = HashMap::new();
    // AUTO mode = the session did not force a specific language. `with_source_
    // language` normalises "auto"/"" to `None`; `"auto-translate"` is NOT auto
    // (it force-translates) and must not be pinned.
    let session_auto = matches!(language.as_deref(), None | Some("auto"));

    // Rolling real-time-factor watch over FINALS (#141): a sustained mean RTF
    // above the threshold means the model is too heavy for this Mac and captions
    // are falling behind. Read-only — surfaces a content-free notice, does NOT
    // change queue behavior or switch models (that is the post-MVP #164).
    let mut rtf_watch = RtfWatch::new();

    while let Some(req) = rx.recv().await {
        // A mic utterance was energy-gated as bleed after streaming partials:
        // cancel its orphaned streaming block on consumers (#62). Processed in
        // queue order, so it lands after the partials it cancels.
        if matches!(req.kind, RequestKind::DropPartial) {
            // The utterance is abandoned — drop any pinned language so the next
            // utterance on this channel auto-detects afresh (#140).
            pinned_lang.remove(&req.channel);
            if events_tx
                .send(CaptionEvent {
                    channel: req.channel,
                    kind: CaptionKind::PartialDropped,
                })
                .is_err()
            {
                break;
            }
            continue;
        }

        // Backpressure: drop partials that sat in the queue too long —
        // they would describe an utterance that has already moved on.
        if matches!(req.kind, RequestKind::Partial) && req.queued_at.elapsed().as_millis() > 2500 {
            log::debug!("Dropping stale partial for {}", req.channel);
            continue;
        }

        let is_partial = matches!(req.kind, RequestKind::Partial);
        // Language for THIS call (#140, M1): a forced language / auto-translate
        // passes through unchanged; in auto mode a partial reuses the pinned
        // detection (None on the first partial), and the final always re-detects.
        let call_language: Option<String> = if !session_auto {
            language.clone()
        } else if is_partial {
            pinned_lang.get(&req.channel).cloned()
        } else {
            None
        };

        let task_engine = engine.clone();
        let samples = req.samples;
        let audio_samples = samples.len(); // captured before the move (#141 RTF)
        let transcribe_started = Instant::now();
        let result = tokio::task::spawn_blocking(move || {
            task_engine.transcribe(&samples, call_language.as_deref(), is_partial, session_auto)
        })
        .await;
        let transcribe_wall_ms = transcribe_started.elapsed().as_secs_f64() * 1000.0;

        let utterance = match result {
            Ok(Ok(u)) => u,
            Ok(Err(e)) => {
                log::error!("Transcription failed for {}: {e:#}", req.channel);
                // A failed FINAL must still end its utterance's pin, or a stale
                // language leaks into the next utterance's partials (#140, M1).
                if matches!(req.kind, RequestKind::Finalized { .. }) {
                    pinned_lang.remove(&req.channel);
                }
                continue;
            }
            Err(e) => {
                log::error!("Transcription task panicked for {}: {e}", req.channel);
                if matches!(req.kind, RequestKind::Finalized { .. }) {
                    pinned_lang.remove(&req.channel);
                }
                continue;
            }
        };

        // Maintain the per-channel language pin (#140, M1) — before the empty
        // text check so a final ALWAYS clears its channel's pin. Auto mode only.
        if session_auto {
            match req.kind {
                RequestKind::Partial => {
                    if utterance.lang != "unknown" && !utterance.lang.is_empty() {
                        pinned_lang
                            .entry(req.channel)
                            .or_insert_with(|| utterance.lang.clone());
                    }
                }
                RequestKind::Finalized { .. } => {
                    pinned_lang.remove(&req.channel);
                }
                RequestKind::DropPartial => {}
            }
        }

        // Real-time-factor tracking for FINALS (#141) — before the empty-text
        // continue, so a slow low-confidence-dropped final still counts. Partials
        // are excluded (they decode greedily and get shed). Emits ONE content-free
        // notice per falling-behind episode.
        if matches!(req.kind, RequestKind::Finalized { .. }) && audio_samples > 0 {
            let audio_ms = audio_samples as f64 / VAD_SAMPLE_RATE as f64 * 1000.0;
            let rtf = transcribe_wall_ms / audio_ms;
            if rtf_watch.record_final(rtf) {
                log::warn!(
                    "transcription falling behind: mean RTF over recent finals crossed the threshold on model '{}' — a smaller model may keep up",
                    engine.model_name()
                );
                let _ = events_tx.send(CaptionEvent {
                    channel: req.channel,
                    kind: CaptionKind::FallingBehind,
                });
            }
        }

        if utterance.text.is_empty() {
            continue;
        }

        let kind = match req.kind {
            // Handled above (no transcription) and `continue`d past — it never
            // reaches this transcription-result match.
            RequestKind::DropPartial => unreachable!("DropPartial is handled before transcription"),
            RequestKind::Partial => CaptionKind::Partial(utterance.text),
            RequestKind::Finalized { start_ms, end_ms } => {
                let text = utterance.text;
                let now_ms = start.elapsed().as_millis() as u64;
                match req.channel {
                    // Remember system finalizations so a later mic re-hearing can
                    // be recognized as a duplicate (#56).
                    Channel::System => suppressor.record_system_final(now_ms, &text),
                    // Drop a mic finalization that re-states a recent system one —
                    // the speaker bled through loudly enough to pass the energy
                    // gate but is still a duplicate caption (#56).
                    Channel::Mic => {
                        if suppressor.mic_text_is_duplicate(now_ms, &text) {
                            log::info!(
                                "[mic] dropping near-duplicate of a system finalization; clearing its partial (#56/#62)"
                            );
                            // The dropped final had streamed partials (it passed
                            // the energy gate): cancel that orphaned block so it
                            // does not linger or poison the next utterance (#62).
                            if events_tx
                                .send(CaptionEvent {
                                    channel: req.channel,
                                    kind: CaptionKind::PartialDropped,
                                })
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                    }
                }
                // Never log caption content (SECURITY.md / EPIC #1) — metadata only.
                log::info!(
                    "[{}] finalized {}..{}ms ({} ms after segment close, {} chars)",
                    req.channel,
                    start_ms,
                    end_ms,
                    req.queued_at.elapsed().as_millis(),
                    text.chars().count()
                );
                CaptionKind::Finalized {
                    text,
                    lang: utterance.lang,
                    confidence: utterance.confidence,
                    start_ms,
                    end_ms,
                }
            }
        };

        if events_tx
            .send(CaptionEvent {
                channel: req.channel,
                kind,
            })
            .is_err()
        {
            // Event receiver dropped — nobody is listening anymore.
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtf_watch_stays_quiet_below_the_window_and_when_fast() {
        let mut w = RtfWatch::new();
        // Fewer than WINDOW finals: never fires, even if slow.
        for _ in 0..RtfWatch::WINDOW - 1 {
            assert!(!w.record_final(2.0));
        }
        // A full window of FAST finals: never fires.
        let mut w = RtfWatch::new();
        for _ in 0..RtfWatch::WINDOW * 2 {
            assert!(!w.record_final(0.2));
        }
    }

    #[test]
    fn rtf_watch_fires_once_per_falling_behind_episode() {
        let mut w = RtfWatch::new();
        // Fill the window with slow finals; the fire happens on the crossing.
        let mut fires = 0;
        for _ in 0..RtfWatch::WINDOW {
            if w.record_final(1.5) {
                fires += 1;
            }
        }
        assert_eq!(fires, 1, "should notify exactly once when it first crosses");
        // Still slow → debounced, no repeat.
        for _ in 0..RtfWatch::WINDOW {
            assert!(!w.record_final(1.5), "must not re-fire while still notified");
        }
    }

    #[test]
    fn rtf_watch_rearms_after_recovery() {
        let mut w = RtfWatch::new();
        for _ in 0..RtfWatch::WINDOW {
            w.record_final(1.5);
        }
        // Recover: a window of fast finals drops the mean below RECOVERED.
        for _ in 0..RtfWatch::WINDOW {
            w.record_final(0.1);
        }
        // A new slow episode fires again.
        let mut refires = 0;
        for _ in 0..RtfWatch::WINDOW {
            if w.record_final(1.5) {
                refires += 1;
            }
        }
        assert_eq!(refires, 1, "should re-fire after recovering and falling behind again");
    }

    #[test]
    fn source_language_auto_maps_to_none() {
        // #94: "auto" (and empty) keep per-utterance auto-detection.
        let dir = std::path::PathBuf::from("/tmp/livecap-models");
        assert_eq!(PipelineConfig::new(&dir).with_source_language("auto").language, None);
        assert_eq!(PipelineConfig::new(&dir).with_source_language("").language, None);
        assert_eq!(PipelineConfig::new(&dir).with_source_language("  AUTO ").language, None);
    }

    #[test]
    fn with_model_overrides_the_default() {
        // #110: the Settings pick lands in PipelineConfig.model; the default
        // stays DEFAULT_MODEL for callers that never set one.
        let dir = std::path::PathBuf::from("/tmp/livecap-models");
        assert_eq!(PipelineConfig::new(&dir).model, crate::model::DEFAULT_MODEL);
        assert_eq!(
            PipelineConfig::new(&dir).with_model("large-v3-turbo").model,
            "large-v3-turbo"
        );
    }

    #[test]
    fn source_language_forces_primary_subtag() {
        // #94: a real code forces whisper; a BCP-47 region tag is reduced to its
        // primary subtag (whisper only understands the primary language).
        let dir = std::path::PathBuf::from("/tmp/livecap-models");
        assert_eq!(
            PipelineConfig::new(&dir).with_source_language("en").language,
            Some("en".to_string())
        );
        assert_eq!(
            PipelineConfig::new(&dir).with_source_language("PT-BR").language,
            Some("pt".to_string())
        );
        assert_eq!(
            PipelineConfig::new(&dir).with_source_language(" zh-hans ").language,
            Some("zh".to_string())
        );
    }
}
