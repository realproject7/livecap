//! Integration test: feed a recorded WAV fixture through the REAL pipeline
//! (decode -> resample -> Silero VAD -> whisper) and assert that it yields
//! non-empty finalized text.
//!
//! The fixture is synthesized at test time with macOS TTS (`say`), so no
//! audio binary is committed. The whisper `tiny` model is used to keep the
//! first-run download small (~75 MB), through the exact same model-management
//! and transcription code path as production (model name is a parameter).
//!
//! Notes for running locally:
//! - First run downloads ggml-tiny.bin (SHA-256 verified) into
//!   `$LIVECAP_TEST_MODELS_DIR` or `~/Library/Caches/livecap/test-models`.
//! - macOS only (uses `say`); skipped elsewhere.

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::process::Command;

use livecap_core::{AudioChunk, CaptionKind, CaptionPipeline, Channel, PipelineConfig};

const SPOKEN_TEXT: &str =
    "This is a live caption integration test. The quick brown fox jumps over the lazy dog.";

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

/// Synthesize the spoken fixture as 16 kHz 16-bit mono WAV via macOS TTS.
fn generate_fixture_wav(path: &std::path::Path) {
    let status = Command::new("say")
        .arg("-o")
        .arg(path)
        .arg("--data-format=LEI16@16000")
        .arg(SPOKEN_TEXT)
        .status()
        .expect("failed to run `say` (macOS TTS)");
    assert!(status.success(), "`say` exited with {status}");
}

/// Decode the WAV fixture to mono f32 samples + sample rate.
fn decode_wav(path: &std::path::Path) -> (Vec<f32>, u32) {
    let reader = hound::WavReader::open(path).expect("failed to open fixture WAV");
    let spec = reader.spec();
    let channels = spec.channels as usize;
    assert!(channels >= 1);

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

    let mono: Vec<f32> = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    (mono, spec.sample_rate)
}

#[tokio::test(flavor = "multi_thread")]
async fn wav_fixture_yields_finalized_text() {
    let _ = env_logger::builder().is_test(true).try_init();

    // 1. Fixture: synthesized speech.
    let wav_path = std::env::temp_dir().join(format!(
        "livecap-fixture-{}.wav",
        std::process::id()
    ));
    generate_fixture_wav(&wav_path);
    let (samples, sample_rate) = decode_wav(&wav_path);
    let _ = std::fs::remove_file(&wav_path);
    assert!(
        samples.len() > sample_rate as usize,
        "fixture should be at least 1 second long"
    );

    // 2. Real pipeline, tiny model (same code path; model name is a parameter).
    let mut config = PipelineConfig::new(test_models_dir());
    config.model = "tiny".to_string();
    let (mut pipeline, mut events) = CaptionPipeline::new(config)
        .await
        .expect("pipeline construction (incl. model download) failed");

    // 3. Stream the fixture into the mic channel in 100 ms chunks, exactly
    //    like a capture source would, then add a second of trailing silence
    //    so the VAD can close the final utterance naturally.
    let feeder = pipeline.feeder(Channel::Mic);
    let chunk_len = sample_rate as usize / 10;
    for chunk in samples.chunks(chunk_len) {
        feeder
            .send(AudioChunk {
                samples: chunk.to_vec(),
                sample_rate,
            })
            .expect("feeder closed unexpectedly");
    }
    feeder
        .send(AudioChunk {
            samples: vec![0.0; sample_rate as usize],
            sample_rate,
        })
        .expect("feeder closed unexpectedly");
    drop(feeder);

    // 4. Drain the pipeline.
    pipeline.finish().await.expect("pipeline shutdown failed");

    let mut finalized: Vec<(String, String, f32, u64, u64)> = Vec::new();
    let mut partials = 0usize;
    while let Some(event) = events.recv().await {
        assert_eq!(event.channel, Channel::Mic);
        match event.kind {
            CaptionKind::Partial(text) => {
                println!("partial: {text}");
                partials += 1;
            }
            // A suppressed-bleed partial-clear (#62); not expected for this
            // single-channel mic fixture, but the match must be exhaustive.
            CaptionKind::PartialDropped => println!("partial dropped"),
            // #141 RTF notice — not a caption; ignore in this fixture.
            CaptionKind::FallingBehind => println!("falling behind"),
            CaptionKind::Finalized {
                text,
                lang,
                confidence,
                start_ms,
                end_ms,
            } => {
                println!("finalized [{lang} conf={confidence:.2} {start_ms}..{end_ms}ms]: {text}");
                finalized.push((text, lang, confidence, start_ms, end_ms));
            }
        }
    }

    // 5. The real pipeline must produce non-empty finalized text with sane
    //    metadata.
    assert!(
        !finalized.is_empty(),
        "expected at least one finalized utterance (got {partials} partials, 0 finals)"
    );
    let combined = finalized
        .iter()
        .map(|(text, ..)| text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        !combined.trim().is_empty(),
        "finalized text must be non-empty"
    );
    for (text, _lang, confidence, start_ms, end_ms) in &finalized {
        assert!(!text.trim().is_empty());
        assert!((0.0..=1.0).contains(confidence));
        assert!(end_ms > start_ms, "end_ms must be after start_ms");
    }

    // Loose content check: TTS speech of a fixed sentence through the tiny
    // model reliably contains at least one of these words.
    let lower = combined.to_lowercase();
    assert!(
        ["caption", "test", "fox", "dog", "quick"]
            .iter()
            .any(|w| lower.contains(w)),
        "transcription did not resemble the spoken fixture: '{combined}'"
    );
}
