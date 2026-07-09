//! Live two-channel caption harness (issue #4 acceptance check).
//!
//! Opens the default microphone ("me") and the macOS system-audio tap
//! ("them") and prints caption events to stdout. Run it, play a video, talk
//! over it:
//!
//! ```sh
//! cargo run -p livecap-core --example live_caption
//! cargo run -p livecap-core --example live_caption -- --model tiny --lang en
//! ```
//!
//! Options:
//!   --model NAME        whisper model (default: small)
//!   --models-dir PATH   model storage dir
//!                       (default: $LIVECAP_MODELS_DIR or
//!                        ~/Library/Application Support/livecap/models)
//!   --lang CODE         force a language / "auto-translate" (default: auto)
//!   --no-system         mic only
//!   --no-mic            system audio only
//!
//! macOS will prompt for Microphone and (on 14.4+) Audio Capture permission
//! on first run; if system-audio permission is denied the tap yields silence.

use std::path::PathBuf;
use std::time::Instant;

use livecap_core::{CaptionKind, CaptionPipeline, PipelineConfig};

fn default_models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LIVECAP_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("livecap")
        .join("models")
}

struct Args {
    model: String,
    models_dir: PathBuf,
    lang: Option<String>,
    mic: bool,
    system: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        model: "small".to_string(),
        models_dir: default_models_dir(),
        lang: None,
        mic: true,
        system: true,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--model" => args.model = it.next().expect("--model needs a value"),
            "--models-dir" => {
                args.models_dir = PathBuf::from(it.next().expect("--models-dir needs a value"))
            }
            "--lang" => args.lang = Some(it.next().expect("--lang needs a value")),
            "--no-system" => args.system = false,
            "--no-mic" => args.mic = false,
            other => {
                eprintln!("Unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    args
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args();

    println!("LiveCap live caption harness");
    println!("  model:      {}", args.model);
    println!("  models dir: {}", args.models_dir.display());
    println!(
        "  channels:   {}{}",
        if args.mic { "mic " } else { "" },
        if args.system { "system" } else { "" }
    );

    let mut config = PipelineConfig::new(&args.models_dir);
    config.model = args.model;
    config.language = args.lang;

    let (mut pipeline, mut events) = CaptionPipeline::new(config).await?;

    if args.mic {
        pipeline.start_mic(None)?;
        println!("  mic:        default input device started");
    }
    if args.system {
        match pipeline.start_system(None) {
            Ok(()) => println!("  system:     Core Audio tap started"),
            Err(e) => {
                eprintln!("  system:     FAILED to start: {e:#}");
                if !args.mic {
                    return Err(e);
                }
            }
        }
    }

    println!("\nListening — Ctrl+C to stop.\n");
    let started = Instant::now();

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("\nStopping...");
                break;
            }
            event = events.recv() => {
                let Some(event) = event else { break };
                let t = started.elapsed().as_secs_f32();
                let who = match event.channel {
                    livecap_core::Channel::Mic => "me  ",
                    livecap_core::Channel::System => "them",
                };
                match event.kind {
                    CaptionKind::Partial(text) => {
                        println!("[{t:8.2}s] [{who}] … {text}");
                    }
                    CaptionKind::PartialDropped => {
                        println!("[{t:8.2}s] [{who}] ⨯ (partial suppressed)");
                    }
                    CaptionKind::Finalized { text, lang, confidence, start_ms, end_ms } => {
                        println!(
                            "[{t:8.2}s] [{who}] ✓ ({lang}, conf {confidence:.2}, {start_ms}–{end_ms}ms) {text}"
                        );
                    }
                    CaptionKind::FallingBehind => {
                        println!("[{t:8.2}s] ⚠ transcription falling behind — a smaller model may keep up");
                    }
                }
            }
        }
    }

    pipeline.finish().await?;
    println!("Done.");
    Ok(())
}
