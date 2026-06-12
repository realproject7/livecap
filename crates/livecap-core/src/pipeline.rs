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

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::device::AudioDevice;
use crate::audio::mic::MicCapture;
use crate::audio::system::SystemAudioCapture;
use crate::audio::AudioChunk;
use crate::event::{CaptionEvent, CaptionKind, Channel};
use crate::model::ModelManager;
use crate::resample::StreamResampler;
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

        let transcribe_task = tokio::spawn(transcribe_worker(
            engine,
            config.language.clone(),
            transcribe_rx,
            events_tx.clone(),
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
        self.worker_tasks
            .push(tokio::spawn(channel_worker(channel, rx, transcribe_tx, params)));
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
) {
    if let Err(e) = channel_worker_inner(channel, rx, transcribe_tx, params).await {
        log::error!("Channel worker for {channel} failed: {e:#}");
    }
}

async fn channel_worker_inner(
    channel: Channel,
    mut rx: mpsc::UnboundedReceiver<AudioChunk>,
    transcribe_tx: mpsc::UnboundedSender<TranscribeRequest>,
    params: WorkerParams,
) -> Result<()> {
    let samples_per_ms = VAD_SAMPLE_RATE as usize / 1000;
    let partial_step = params.partial_interval_ms as usize * samples_per_ms;
    let max_utterance = params.max_utterance_ms as usize * samples_per_ms;
    let min_partial = 500 * samples_per_ms; // don't transcribe partials under 0.5 s

    let mut resampler = StreamResampler::new(VAD_SAMPLE_RATE);
    let mut vad = ContinuousVadProcessor::new(VAD_SAMPLE_RATE, params.vad_redemption_ms)?;
    let mut last_partial_len = 0usize;

    let send_final = |segment: crate::vad::SpeechSegment| {
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

        for segment in vad.process_audio(&samples_16k)? {
            last_partial_len = 0;
            send_final(segment);
        }

        if vad.in_speech() {
            let current_len = vad.current_speech().len();
            if current_len >= max_utterance {
                // Bound utterance length: force-finalize the slice so far.
                if let Some(segment) = vad.take_current_speech() {
                    last_partial_len = 0;
                    send_final(segment);
                }
            } else if current_len >= min_partial && current_len >= last_partial_len + partial_step
            {
                last_partial_len = current_len;
                let _ = transcribe_tx.send(TranscribeRequest {
                    channel,
                    samples: vad.current_speech().to_vec(),
                    kind: RequestKind::Partial,
                    queued_at: Instant::now(),
                });
            }
        } else {
            last_partial_len = 0;
        }
    }

    // Source closed: flush remaining speech.
    for segment in vad.flush()? {
        send_final(segment);
    }
    Ok(())
}

/// Shared transcription worker: serializes whisper calls (one context, one
/// state at a time) so mic and system channels never contend on the GPU.
async fn transcribe_worker(
    engine: Arc<WhisperEngine>,
    language: Option<String>,
    mut rx: mpsc::UnboundedReceiver<TranscribeRequest>,
    events_tx: mpsc::UnboundedSender<CaptionEvent>,
) {
    while let Some(req) = rx.recv().await {
        // Backpressure: drop partials that sat in the queue too long —
        // they would describe an utterance that has already moved on.
        if matches!(req.kind, RequestKind::Partial) && req.queued_at.elapsed().as_millis() > 2500 {
            log::debug!("Dropping stale partial for {}", req.channel);
            continue;
        }

        let task_engine = engine.clone();
        let task_language = language.clone();
        let samples = req.samples;
        let result = tokio::task::spawn_blocking(move || {
            task_engine.transcribe(&samples, task_language.as_deref())
        })
        .await;

        let utterance = match result {
            Ok(Ok(u)) => u,
            Ok(Err(e)) => {
                log::error!("Transcription failed for {}: {e:#}", req.channel);
                continue;
            }
            Err(e) => {
                log::error!("Transcription task panicked for {}: {e}", req.channel);
                continue;
            }
        };

        if utterance.text.is_empty() {
            continue;
        }

        let kind = match req.kind {
            RequestKind::Partial => CaptionKind::Partial(utterance.text),
            RequestKind::Finalized { start_ms, end_ms } => {
                log::info!(
                    "[{}] finalized {}..{}ms ({} ms after segment close): '{}'",
                    req.channel,
                    start_ms,
                    end_ms,
                    req.queued_at.elapsed().as_millis(),
                    utterance.text
                );
                CaptionKind::Finalized {
                    text: utterance.text,
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
