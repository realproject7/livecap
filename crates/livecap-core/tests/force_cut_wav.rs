//! Integration test (#138/#162): a VAD force-cut mid-utterance must NOT
//! duplicate audio on the eventual SpeechEnd, and must NOT panic.
//!
//! This exercises the exact production path (`pipeline.rs` force-cuts at
//! `max_utterance_ms`, then the utterance ends naturally). It uses REAL speech
//! synthesized with macOS `say`: the synthetic-harmonic generator in the vad
//! unit tests is never classified as speech by this Silero build, so the
//! force-cut → SpeechEnd path can only be reached with real audio.
//!
//! Before the #162 fix this test PANICS at the natural SpeechEnd (draining
//! Silero's buffer on the cut left its state-enum `start_ms` stale). macOS only.
#![cfg(target_os = "macos")]

use std::process::Command;

use livecap_core::vad::ContinuousVadProcessor;

const SPOKEN_TEXT: &str = "This is a deliberately long spoken sentence used to \
    exercise the voice activity detector force cut path during a continuous \
    monologue that runs well past the maximum utterance length without any \
    natural pause so the detector is forced to cut it into pieces.";

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

fn decode_wav_mono(path: &std::path::Path) -> Vec<f32> {
    let reader = hound::WavReader::open(path).expect("failed to open fixture WAV");
    let spec = reader.spec();
    let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
    let interleaved: Vec<f32> = reader
        .into_samples::<i32>()
        .map(|s| s.expect("bad sample") as f32 / max)
        .collect();
    let ch = spec.channels as usize;
    interleaved
        .chunks(ch)
        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
        .collect()
}

#[test]
fn force_cut_midutterance_no_duplicate_no_panic() {
    let tmp = std::env::temp_dir().join("livecap-forcecut-fixture.wav");
    generate_fixture_wav(&tmp);
    let speech = decode_wav_mono(&tmp);
    let _ = std::fs::remove_file(&tmp);
    assert!(speech.len() > 32_000, "fixture unexpectedly short");

    // 800 ms redemption (the LiveCap live-caption default).
    let mut vad = ContinuousVadProcessor::new(16000, 800).expect("vad init");

    // Feed the speech in ~100 ms chunks; force-cut whenever ~1 s has
    // accumulated — simulating `pipeline.rs`'s `max_utterance_ms` cut, lowered
    // here so it fires repeatedly during the fixture.
    const FORCE_CUT_THRESHOLD: usize = 16_000; // 1 s @ 16 kHz
    let mut finalized: usize = 0;
    let mut force_cuts: usize = 0;
    for chunk in speech.chunks(1_600) {
        for seg in vad.process_audio(chunk).expect("process_audio") {
            finalized += seg.samples.len();
        }
        if vad.in_speech() && vad.current_speech().len() >= FORCE_CUT_THRESHOLD {
            if let Some(seg) = vad.take_current_speech() {
                finalized += seg.samples.len();
                force_cuts += 1;
            }
        }
    }

    // End the utterance with 1 s of silence (>> redemption + post-pad) so the
    // natural SpeechEnd fires. Before the fix, this call PANICS after any
    // force-cut; reaching the assertions below proves it no longer does.
    for seg in vad.process_audio(&vec![0.0f32; 16_000]).expect("process silence") {
        finalized += seg.samples.len();
    }

    // Anti-tautology: real speech must have been detected AND force-cut, i.e.
    // the panic/duplication path was actually exercised.
    assert!(
        finalized > FORCE_CUT_THRESHOLD,
        "no speech finalized ({finalized} samples) — fixture not detected as speech, test would be vacuous"
    );
    assert!(
        force_cuts >= 1,
        "no force-cut fired — the #138/#162 path was not exercised"
    );

    // No-duplication: total finalized audio stays near the input, NOT ~2× it
    // (the bug re-emitted the pre-cut audio inside the final segment). Allow ~1 s
    // of pre/post-padding slack.
    assert!(
        finalized <= speech.len() + 16_000,
        "force-cut + speech-end finalized {} samples for a {}-sample utterance \
         — audio was duplicated (#138/#162)",
        finalized,
        speech.len()
    );
}
