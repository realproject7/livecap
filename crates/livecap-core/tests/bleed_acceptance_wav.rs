//! #64 real-speaker bleed acceptance, through the REAL pipeline.
//!
//! Two modes, one harness:
//! - **CI / default**: a content-neutral SYNTHETIC two-channel fixture is built
//!   at test time (macOS `say` — no audio is committed) reproducing the bleed
//!   geometry: an attenuated + offset system copy on the mic, including a tail
//!   that extends past the system into a gap (so both the energy gate and the
//!   dedup path are exercised), plus a distinct mic sentence. Asserts the bleed
//!   is suppressed while distinct mic speech still passes — a regression guard
//!   for the tuned production defaults.
//! - **Operator acceptance**: set `LIVECAP_BLEED_FIXTURE_SYSTEM` +
//!   `LIVECAP_BLEED_FIXTURE_MIC` to the locally-captured real WAVs (which must
//!   NOT be committed — copyright/privacy) and the same harness runs them through
//!   the real pipeline and asserts mic finalizations <= 1 over the clip (the
//!   `Me <= 5 / hr` target). Tune with the `LIVECAP_BLEED_*` env overrides until
//!   it passes, then bake the values into `SuppressionConfig::default`.
//!
//! macOS only (uses `say` + Metal whisper); needs the Rust toolchain + cmake.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use livecap_core::{AudioChunk, CaptionKind, CaptionPipeline, Channel, PipelineConfig};

const SAMPLE_RATE: u32 = 16_000;
const SYSTEM_SENTENCE: &str = "The system audio plays the quick brown fox.";
const MIC_SENTENCE: &str = "Let us discuss the quarterly budget review now.";

fn test_models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LIVECAP_TEST_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home).join("Library").join("Caches").join("livecap").join("test-models")
}

fn synth(text: &str) -> Vec<f32> {
    let path = std::env::temp_dir().join(format!("livecap-acc-{}-{}.wav", std::process::id(), text.len()));
    let status = Command::new("say")
        .arg("-o")
        .arg(&path)
        .arg("--data-format=LEI16@16000")
        .arg(text)
        .status()
        .expect("failed to run `say`");
    assert!(status.success(), "`say` exited with {status}");
    let s = decode_wav(&path);
    let _ = std::fs::remove_file(&path);
    s
}

fn decode_wav(path: &Path) -> Vec<f32> {
    let reader = hound::WavReader::open(path).expect("failed to open WAV");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, SAMPLE_RATE, "fixtures must be 16 kHz");
    let channels = spec.channels as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.into_samples::<i32>().map(|s| s.expect("bad sample") as f32 / max).collect()
        }
        hound::SampleFormat::Float => {
            reader.into_samples::<f32>().map(|s| s.expect("bad sample")).collect()
        }
    };
    interleaved.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
}

fn silence(ms: u64) -> Vec<f32> {
    vec![0.0; (SAMPLE_RATE as u64 * ms / 1000) as usize]
}

fn scaled(samples: &[f32], gain: f32) -> Vec<f32> {
    samples.iter().map(|s| s * gain).collect()
}

async fn feed_paced(feeder: tokio::sync::mpsc::UnboundedSender<AudioChunk>, samples: Vec<f32>) {
    let chunk_len = SAMPLE_RATE as usize / 10; // 100 ms
    for chunk in samples.chunks(chunk_len) {
        if feeder
            .send(AudioChunk { samples: chunk.to_vec(), sample_rate: SAMPLE_RATE })
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

/// Real captured fixtures via env, else a synthetic bleed scenario.
fn fixtures() -> (Vec<f32>, Vec<f32>, bool) {
    let sys = std::env::var("LIVECAP_BLEED_FIXTURE_SYSTEM").ok();
    let mic = std::env::var("LIVECAP_BLEED_FIXTURE_MIC").ok();
    if let (Some(s), Some(m)) = (sys, mic) {
        return (decode_wav(Path::new(&s)), decode_wav(Path::new(&m)), true);
    }

    let speech = synth(SYSTEM_SENTENCE);
    let distinct = synth(MIC_SENTENCE);
    // Mic: concurrent attenuated bleed (offset), a SECOND attenuated copy during
    // system silence (gap bleed → dedup-only), then distinct mic speech.
    let bleed = scaled(&speech, 0.4);
    let mut mic = silence(200);
    mic.extend_from_slice(&bleed);
    mic.extend(silence(1_500));
    mic.extend_from_slice(&bleed); // gap bleed (system is silent by now)
    mic.extend(silence(2_000));
    mic.extend_from_slice(&distinct);
    mic.extend(silence(1_000));

    // System: the sentence once, then silence padded to the mic length.
    let mut system = speech;
    if mic.len() > system.len() {
        system.extend(vec![0.0; mic.len() - system.len()]);
    }
    (system, mic, false)
}

#[tokio::test(flavor = "multi_thread")]
async fn bleed_meets_acceptance_through_the_real_pipeline() {
    let _ = env_logger::builder().is_test(true).try_init();
    let (system, mic, is_real) = fixtures();

    let mut config = PipelineConfig::new(test_models_dir());
    config.model = "tiny".to_string();
    let (mut pipeline, mut events) =
        CaptionPipeline::new(config).await.expect("pipeline construction failed");

    let mic_feeder = pipeline.feeder(Channel::Mic);
    let system_feeder = pipeline.feeder(Channel::System);
    let mic_task = tokio::spawn(feed_paced(mic_feeder, mic));
    let system_task = tokio::spawn(feed_paced(system_feeder, system));
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
    println!("system finals: {system_finals:?}");
    println!("mic finals ({}): {mic_finals:?}", mic_finals.len());

    if is_real {
        // Pure speaker→mic bleed (operator stayed silent): every mic final is
        // bleed. Acceptance: <= 1 over the clip (the `Me <= 5 / hr` target).
        assert!(
            mic_finals.len() <= 1,
            "real-fixture bleed escaped suppression ({} mic finalizations): {mic_finals:?}",
            mic_finals.len()
        );
    } else {
        let mic_text = mic_finals.join(" ");
        // Bleed (concurrent + gap copies of the system sentence) suppressed...
        assert!(
            !contains_any(&mic_text, &["fox", "brown"]),
            "synthetic bleed leaked to the mic channel: '{mic_text}'"
        );
        // ...while genuinely distinct mic speech still passes (no false suppression).
        assert!(
            contains_any(&mic_text, &["budget", "quarterly", "review"]),
            "distinct mic speech was wrongly suppressed: '{mic_text}'"
        );
    }
}
