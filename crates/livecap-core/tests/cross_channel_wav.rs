//! Integration test for cross-channel speaker-bleed suppression (#56).
//!
//! Feeds TWO channels through the REAL pipeline (decode -> resample -> Silero
//! VAD -> whisper) with synthesized two-channel fixtures: the system channel
//! plays a sentence at full volume while the mic channel hears the same sentence
//! attenuated and time-offset (the speaker bleeding into the mic, as in #13's
//! speaker-at-volume-25 run), then later a genuinely DISTINCT mic sentence while
//! the system is silent.
//!
//! Asserts the bleed is suppressed on the mic channel while the distinct mic
//! speech still passes — i.e. channel separation is preserved.
//!
//! Notes for running locally (macOS only; uses `say` + downloads ggml-tiny):
//! - `cargo test -p livecap-core --test cross_channel_wav`
//! - Requires the Rust toolchain + cmake (whisper.cpp build).

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use livecap_core::{AudioChunk, CaptionKind, CaptionPipeline, Channel, PipelineConfig};

const SAMPLE_RATE: u32 = 16_000;

// Two sentences with non-overlapping keywords so resemblance is unambiguous.
const SYSTEM_SENTENCE: &str = "The system audio plays the quick brown fox.";
const MIC_SENTENCE: &str = "Let us discuss the quarterly budget review now.";

fn test_models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LIVECAP_TEST_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Caches")
        .join("livecap")
        .join("test-models")
}

/// Synthesize `text` as 16 kHz 16-bit mono WAV via macOS TTS and decode it to
/// mono f32 samples.
fn synth(text: &str) -> Vec<f32> {
    let path = std::env::temp_dir().join(format!(
        "livecap-x-{}-{}.wav",
        std::process::id(),
        text.len()
    ));
    let status = Command::new("say")
        .arg("-o")
        .arg(&path)
        .arg("--data-format=LEI16@16000")
        .arg(text)
        .status()
        .expect("failed to run `say` (macOS TTS)");
    assert!(status.success(), "`say` exited with {status}");
    let samples = decode_wav(&path);
    let _ = std::fs::remove_file(&path);
    samples
}

fn decode_wav(path: &Path) -> Vec<f32> {
    let reader = hound::WavReader::open(path).expect("failed to open fixture WAV");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, SAMPLE_RATE);
    let channels = spec.channels as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.expect("bad sample") as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .map(|s| s.expect("bad sample"))
            .collect(),
    };
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

fn silence(ms: u64) -> Vec<f32> {
    vec![0.0; (SAMPLE_RATE as u64 * ms / 1000) as usize]
}

fn scaled(samples: &[f32], gain: f32) -> Vec<f32> {
    samples.iter().map(|s| s * gain).collect()
}

/// Feed `samples` into `feeder` in 100 ms chunks, pacing each chunk in real time
/// so both channels' wall-clock timelines line up (the suppressor correlates
/// energy across channels on the shared session clock).
async fn feed_paced(feeder: tokio::sync::mpsc::UnboundedSender<AudioChunk>, samples: Vec<f32>) {
    let chunk_len = SAMPLE_RATE as usize / 10; // 100 ms
    for chunk in samples.chunks(chunk_len) {
        if feeder
            .send(AudioChunk {
                samples: chunk.to_vec(),
                sample_rate: SAMPLE_RATE,
            })
            .is_err()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(feeder);
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    let lower = haystack.to_lowercase();
    needles.iter().any(|w| lower.contains(w))
}

#[tokio::test(flavor = "multi_thread")]
async fn speaker_bleed_is_suppressed_while_distinct_mic_speech_passes() {
    let _ = env_logger::builder().is_test(true).try_init();

    let system_speech = synth(SYSTEM_SENTENCE);
    let mic_speech = synth(MIC_SENTENCE);

    // Mic timeline: 200 ms offset, then the SYSTEM sentence attenuated (bleed),
    // a silence gap, then the DISTINCT mic sentence at full volume.
    let bleed = scaled(&system_speech, 0.45);
    let mut mic_timeline = Vec::new();
    mic_timeline.extend(silence(200));
    mic_timeline.extend_from_slice(&bleed);
    mic_timeline.extend(silence(2_000));
    mic_timeline.extend_from_slice(&mic_speech);
    mic_timeline.extend(silence(1_000));

    // System timeline: the sentence at full volume, then silence (so the mic's
    // distinct sentence plays with no concurrent system energy).
    let mut system_timeline = Vec::new();
    system_timeline.extend_from_slice(&system_speech);
    let tail = mic_timeline.len().saturating_sub(system_timeline.len());
    system_timeline.extend(vec![0.0; tail]);

    let mut config = PipelineConfig::new(test_models_dir());
    config.model = "tiny".to_string();
    let (mut pipeline, mut events) = CaptionPipeline::new(config)
        .await
        .expect("pipeline construction (incl. model download) failed");

    let mic_feeder = pipeline.feeder(Channel::Mic);
    let system_feeder = pipeline.feeder(Channel::System);

    // Feed both channels concurrently, paced in real time.
    let mic_task = tokio::spawn(feed_paced(mic_feeder, mic_timeline));
    let system_task = tokio::spawn(feed_paced(system_feeder, system_timeline));
    let _ = mic_task.await;
    let _ = system_task.await;

    pipeline.finish().await.expect("pipeline shutdown failed");

    let mut mic_finals: Vec<String> = Vec::new();
    let mut system_finals: Vec<String> = Vec::new();
    while let Some(event) = events.recv().await {
        if let CaptionKind::Finalized { text, .. } = event.kind {
            match event.channel {
                Channel::Mic => mic_finals.push(text),
                Channel::System => system_finals.push(text),
            }
        }
    }

    let system_text = system_finals.join(" ");
    let mic_text = mic_finals.join(" ");
    println!("system finals: {system_text:?}");
    println!("mic finals: {mic_text:?}");

    // The system channel heard its own sentence.
    assert!(
        contains_any(&system_text, &["fox", "brown", "quick", "system"]),
        "system channel should have transcribed its sentence: '{system_text}'"
    );

    // The bleed is suppressed: the mic channel must NOT echo the system sentence.
    assert!(
        !contains_any(&mic_text, &["fox", "brown"]),
        "mic channel leaked the speaker bleed (should be suppressed): '{mic_text}'"
    );

    // Channel separation preserved: the distinct mic sentence still passes.
    assert!(
        contains_any(&mic_text, &["budget", "quarterly", "review"]),
        "distinct mic speech was wrongly suppressed: '{mic_text}'"
    );
}
