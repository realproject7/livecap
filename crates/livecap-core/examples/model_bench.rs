//! #111 row 5 — headless model accuracy + latency bench.
//!
//! Feeds ONE recorded WAV through the REAL pipeline (real VAD, real whisper)
//! via `pipeline.feeder(...)`, so the measurement does not depend on the room
//! being quiet, on TCC, or on anything the device is doing. Same bytes, every
//! model, every run.
//!
//! ```sh
//! cargo run --release -p livecap-core --example model_bench -- \
//!   --wav /path/fixture.wav --model small
//! ```
//!
//! Prints one `key=value` line per metric plus the finalized transcript, so a
//! caller can diff transcripts across models and compare RTF.

use std::path::PathBuf;
use std::time::Instant;

use livecap_core::{AudioChunk, CaptionKind, CaptionPipeline, Channel, PipelineConfig};

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

fn decode_wav(path: &PathBuf) -> (Vec<f32>, u32) {
    let reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    let ch = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.into_samples::<f32>().map(|s| s.unwrap()).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.unwrap() as f32 / max)
                .collect()
        }
    };
    // Downmix to mono.
    let mono = if ch > 1 {
        samples.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect()
    } else {
        samples
    };
    (mono, spec.sample_rate)
}

#[tokio::main]
async fn main() {
    let wav = PathBuf::from(arg("--wav").expect("--wav required"));
    let model = arg("--model").unwrap_or_else(|| "small".into());
    let models_dir = arg("--models-dir").map(PathBuf::from).unwrap_or_else(|| {
        let home = std::env::var("HOME").expect("HOME");
        PathBuf::from(home).join("Library/Application Support/livecap/models")
    });

    let (samples, rate) = decode_wav(&wav);
    let audio_secs = samples.len() as f64 / rate as f64;

    let mut config = PipelineConfig::new(models_dir);
    config.model = model.clone();

    let load_start = Instant::now();
    let (mut pipeline, mut events) = CaptionPipeline::new(config)
        .await
        .expect("pipeline init (model load)");
    let load_ms = load_start.elapsed().as_millis();

    let run_start = Instant::now();
    let feeder = pipeline.feeder(Channel::System);
    // Feed in ~100 ms chunks, as the real capture path does.
    let chunk = (rate as usize / 10).max(1);
    for c in samples.chunks(chunk) {
        feeder
            .send(AudioChunk { samples: c.to_vec(), sample_rate: rate })
            .expect("feeder closed");
    }
    drop(feeder);
    // Shut the pipeline down BEFORE draining: `finish()` is what closes the
    // event sender, so without it `events.recv()` never yields None and the
    // drain loop below hangs forever.
    pipeline.finish().await.expect("pipeline shutdown");

    let mut finals: Vec<(String, String, f32)> = Vec::new();
    let mut first_final_ms: Option<u128> = None;
    let mut falling_behind = 0usize;
    while let Some(ev) = events.recv().await {
        match ev.kind {
            CaptionKind::Finalized { text, lang, confidence, .. } => {
                if first_final_ms.is_none() {
                    first_final_ms = Some(run_start.elapsed().as_millis());
                }
                finals.push((text, lang, confidence));
            }
            CaptionKind::FallingBehind => falling_behind += 1,
            _ => {}
        }
    }
    let total_ms = run_start.elapsed().as_millis();

    println!("model={model}");
    println!("audio_seconds={audio_secs:.2}");
    println!("model_load_ms={load_ms}");
    println!("first_final_ms={}", first_final_ms.map(|v| v.to_string()).unwrap_or("none".into()));
    println!("total_process_ms={total_ms}");
    println!("rtf={:.3}", total_ms as f64 / 1000.0 / audio_secs.max(0.001));
    println!("finalized_count={}", finals.len());
    println!("falling_behind_events={falling_behind}");
    if !finals.is_empty() {
        let cs: Vec<f32> = finals.iter().map(|(_, _, c)| *c).collect();
        let min = cs.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = cs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let mean = cs.iter().sum::<f32>() / cs.len() as f32;
        println!("confidence_min={min:.4} confidence_mean={mean:.4} confidence_max={max:.4}");
    }
    println!("--- transcript (text | lang | confidence) ---");
    for (text, lang, conf) in &finals {
        println!("{conf:.4}\t{lang}\t{text}");
    }
}
