# Alternative STT engines — feasibility assessment (#132)

Research spike. **No product code, defaults, dependencies, or engine integration is
proposed by this document** — the deliverable is the assessment and the decision rule
in §5.

Written against `main` @ `2ad4674`. Every claim about LiveCap's current behaviour is
cited to a file and line so it can be re-checked rather than believed.

---

## 0. The deciding input has not arrived

#132 states its own precondition: *"Re-evaluate ONLY after #111 (STT calibration)
reports whether the whisper model tiers meet the real-audio accuracy bar"*, and scope
item 4 requires the recommendation be made *"with the #111 accuracy data as the
deciding input"*.

**#111 has not reported.** At the time of writing it is OPEN, carries zero comments,
and was last updated 2026-07-04. No real-audio accuracy verdict for any whisper tier
exists in the tracker.

So §5 is written as a **decision rule keyed to #111's eventual outcome**, not as an
unconditional recommendation. Producing "adopt X" or "reject X" today would mean
inventing the number the entire decision turns on.

A second, related finding — see §1.1 — is that #111's *output* has not landed in the
code either, which changes one of the ticket's stated risks.

---

## 1. What a replacement engine would actually have to satisfy

The ticket lists four risks. Checked against the source, **two are accurate, one is
overstated, and one rests on a seam that does not exist.**

### 1.1 Confidence-gate coupling — REAL, and narrower than "recalibrate everything"

`WhisperEngine::transcribe` averages whisper's real per-token probabilities per
segment (`crates/livecap-core/src/whisper/engine.rs:343`, via `full_get_token_prob`,
which is why `whisper-rs` is pulled with the `raw-api` feature —
`crates/livecap-core/Cargo.toml:51`). The resulting `0.0..=1.0` score is gated against
a **pair** of floors (`engine.rs:23-46`):

| Floor | Meaning |
|---|---|
| `forced` | minimum to emit at all when the session forces a source language |
| `auto_detect` | stricter floor to *trust* a whisper-detected language; between the two, the utterance is dropped rather than mislabelled |

The second floor is the load-bearing one and is easy to miss: it does not gate quality,
it gates **whether the engine's own language guess may be believed**, because a wrong
label mis-routes the channel and translates the wrong direction (`engine.rs:38-45`).
Any candidate engine must therefore expose *both* a per-utterance confidence scale
**and** a language-identification confidence, or that behaviour has to be rebuilt from
something else.

**Correction to the ticket's premise.** #132 describes the floor table as *"freshly
calibrated in #111"*. It is not calibrated at all: all five families still return the
same `SEED_FLOORS { forced: 0.5, auto_detect: 0.6 }` (`engine.rs:95-103`), with the
table's own comment recording that #111 is what *would* replace them
(`engine.rs:92-94`). The seed values were tuned against `tiny` while production
defaults to `small` (`engine.rs:50-54`).

Two consequences:
- The "throw away the calibration" cost of switching engines is **currently zero** —
  there is no per-family calibration to throw away. The cost is the *work* of
  calibrating, which is owed for whisper anyway.
- Any per-engine floor table inherits the same unfinished-calibration problem. An
  alternative engine does not get to skip #111's work; it duplicates it.

### 1.2 Language-stack mismatch — REAL, but the FFI toolchain is already present

LiveCap's STT core is Rust (`whisper-rs 0.13.2`). Reaching Parakeet/Nemotron means
ONNX Runtime or an Apple-framework bridge. Worth noting the objc2 stack is **already a
dependency** — `objc2 0.6`, `objc2-foundation`, `objc2-core-audio` and friends
(`Cargo.toml:52-56`), used today for the Core Audio process tap and the TCC probes. An
Apple-framework path is therefore not a new toolchain, only new bindings (§3.2).

### 1.3 License — REAL for FluidVoice, not a blocker for the models

FluidVoice is GPLv3, so no code may be copied into MIT LiveCap; any adoption is a
clean-room reimplementation. The *components* themselves are permissive:
sherpa-onnx is Apache-2.0 and `nvidia/parakeet-tdt-0.6b-v3` is CC-BY-4.0 (attribution
required, redistribution permitted).

### 1.4 Pipeline entanglement — OVERSTATED for bleed suppression

The ticket groups "bleed suppression (#56/#64), channel separation, and VAD gating" as
whisper-entangled. Reading `crates/livecap-core/src/suppression.rs:1-25`, bleed
suppression is **engine-independent**: it is (a) an energy gate that runs *before*
transcription, comparing mic energy to concurrent system energy, and (b) a
normalized-text near-duplicate drop applied *after* finalization. Neither touches
whisper internals. The same is true of VAD, which is `silero-rs` upstream of the
engine (`vad.rs:11`).

The genuine engine-shaped coupling is narrower than the ticket implies:

| Contract | Where | Engine must provide |
|---|---|---|
| 16 kHz mono `f32` segments | `vad.rs:16` (`VAD_SAMPLE_RATE`), fed via `pipeline.rs:316` | same input format (all candidates do) |
| Partial every ~1200 ms, then a final | `pipeline.rs:52-68` | streaming or cheap re-decode of a growing buffer |
| `DropPartial` ordering | `pipeline.rs:113-117` | partials must be cancellable after emission |
| Per-utterance confidence | `engine.rs:343` | a probability scale to gate on |
| Language ID + its own confidence | `engine.rs:38-45` | per-utterance language, or the auto floor is unimplementable |
| `min` segment length 1.1 s | `engine.rs:21` | tolerate short segments |

---

## 2. Candidates reachable from Rust without a Swift dependency

### 2.1 sherpa-onnx (Parakeet TDT / Nemotron), via `sherpa-rs` or the `sherpa_onnx` crate

- **Confidence surface: YES.** Token-level scores are exposed (`ys_probs` on offline
  transducer results; `token_log_probs` on `OfflineRecognitionResult`; online
  `GetResult` carries per-token confidence). Converting `exp(log_prob)` gives the same
  `0..1` scale the current gate averages over — the *shape* of §1.1's first floor
  ports directly.
- **Language ID confidence: NOT equivalent.** Parakeet TDT v3 is multilingual
  (25 European languages) but does not expose a per-utterance language posterior the
  way whisper's detection does. The `auto_detect` floor would have to be rebuilt —
  most plausibly by running a separate LID model — or auto mode restricted.
- **Acceleration:** ONNX Runtime with a CoreML execution provider; ANE-eligible.
- **Size / license:** ~0.6 B params (~460 MB class); runtime Apache-2.0, model
  CC-BY-4.0.
- **Streaming:** supported (online recognizers), which fits the partial cadence better
  than whisper's fixed 30 s window.
- **Maturity risk:** three competing Rust binding crates, all young; the C API they
  wrap is stable, the Rust layer is not.

### 2.2 Apple SpeechAnalyzer (macOS 26+), via `objc2` or `speech-rs`

- **Confidence surface: PARTIAL.** `SpeechTranscriptionResult` carries confidence and
  time-range spans, so a per-utterance score is obtainable; it is Apple's own scale,
  not token probabilities, so floors must be recalibrated from scratch (they cannot be
  ported numerically from whisper).
- **Bindings maturity: the weakest link.** `speech-rs` exists and covers
  SpeechAnalyzer/SpeechTranscriber/SpeechDetector. But a comparable project
  (`swift-scribe-rs`) evaluated `objc2` for exactly this API and **chose a Swift helper
  binary instead**, citing the difficulty of hand-writing Objective-C blocks for the
  async callbacks. A Swift helper binary is precisely what #132 rules out.
- **Platform floor:** macOS 26+. This is a *product* decision, not an engineering one —
  it would either raise LiveCap's minimum OS or require whisper to be kept as the
  fallback path, i.e. two STT engines maintained rather than one.
- **Assets:** per-locale download managed by the OS; no model shipping, but also no
  control over when a locale is unavailable.
- **License:** system framework, no redistribution question.

### 2.3 Staying inside whisper: distil-whisper / smaller-faster variants

The option the ticket does not enumerate, and the only one with **zero gate redesign**:
distilled whisper variants run through the existing `whisper-rs` path, keep
`full_get_token_prob`, keep language detection, and keep both floors on the same scale.
`model_family()` already has a fallback arm for unknown names (`engine.rs:73-89`), so
adding a family is a table entry plus calibration — not a subsystem.

This is the cheapest lever on the "them"-channel accuracy problem if #111 shows the gap
is a *model-size* problem rather than a *model-architecture* problem.

---

## 3. Integration cost

Estimates are relative effort against the current pipeline, not calendar time.

| | sherpa-onnx / Parakeet | SpeechAnalyzer | distil-whisper |
|---|---|---|---|
| New dependency surface | ONNX Runtime + bindings | new bindings (or blocked) | none |
| **STT engine seam** (§3.1) | must be built | must be built | not needed |
| Confidence gate | port scale, rebuild LID floor | recalibrate from scratch | unchanged |
| Bleed suppression | unchanged (§1.4) | unchanged | unchanged |
| VAD handoff | unchanged | overlaps `SpeechDetector` | unchanged |
| Partials | native streaming (better) | native streaming | unchanged |
| Model shipping | +~460 MB download | OS-managed | swap existing |
| Platform floor | unchanged | **macOS 26+** | unchanged |
| Calibration owed | full, per model | full, new scale | per family (owed anyway) |

### 3.1 There is no STT engine-selection seam

Scope item 4 offers "add ONE alternative behind the existing engine-selection seam".
**That seam does not exist for STT.** `EnginePref = "cli" | "local"`
(`src/protocol.ts:72`) selects the *translation* engine. The STT path holds a concrete
`Arc<WhisperEngine>` (`crates/livecap-core/src/pipeline.rs:496`), constructed directly
at `pipeline.rs:151`, and there is no trait abstraction over transcription anywhere in
the crate.

Any multi-engine option therefore includes building that seam first: a transcription
trait, a per-engine floor/gate strategy (because the gate is *not* engine-neutral —
§1.1), and a settings surface. That work is a prerequisite for both alternatives, and
it is the item most likely to be under-estimated, because the ticket's phrasing implies
it is already there.

---

## 4. What would change these conclusions

- **#111 reports.** The entire decision is downstream of it (§5).
- **A `parakeet` LID story appears.** If a per-utterance language posterior becomes
  available, §2.1's main functional gap closes and it becomes the strongest candidate.
- **`objc2` grows first-class Speech bindings**, removing the helper-binary problem
  that currently makes §2.2 impractical under this ticket's constraints.

---

## 5. Recommendation — decision rule, resolved by #111

**Today, on the evidence available: keep whisper-only and defer.** Not because the
alternatives are weak, but because the one input that would justify a subsystem-scale
change does not exist yet, and the cheapest lever (§2.3) has not been tried.

When #111 reports, this resolves without another research round:

**A. #111 finds `large-v3-turbo` meets the real-audio bar on the "them" channel.**
→ **Stay whisper-only. Close #132.** Land the per-family floors #109 left seeded
(`engine.rs:95-103`); no engine work is justified.

**B. #111 finds the gap is model *size* — accuracy scales with tier, `turbo` is close
but the tier is too slow or too large.**
→ **Try §2.3 first** (distilled whisper in the existing path). Zero gate redesign, no
new seam. Only if that fails does an alternative engine become the next lever.

**C. #111 finds the gap is architectural — `large-v3-turbo` plateaus below the bar on
real meeting audio regardless of tier.**
→ **Then, and only then, open a separate ticket for the seam in §3.1**, and evaluate
**sherpa-onnx + Parakeet TDT** as the first candidate: it is the only option that keeps
a real per-token confidence surface (§2.1), stays permissively licensed, and does not
raise the platform floor. Its LID gap (§2.1) must be scoped in that ticket, because
auto-language mode depends on it. **SpeechAnalyzer stays deferred** until the bindings
question (§2.2) is answered by something other than a Swift helper binary.

**In all three branches:** the calibration work #111 was meant to produce is owed
regardless (§1.1). It is not a cost of switching engines; it is a cost already
outstanding for the engine in production today.

---

## Sources

Repository claims are cited inline to `main` @ `2ad4674`. External claims:

- [sherpa-onnx Rust bindings (`sherpa-rs`)](https://github.com/thewh1teagle/sherpa-rs)
- [`sherpa_onnx` crate docs](https://docs.rs/sherpa-onnx/latest/sherpa_onnx/)
- [`parakeet_rs` crate docs](https://docs.rs/parakeet-rs)
- [sherpa-onnx: vocabulary/token log-probabilities API (PR #2897)](https://github.com/k2-fsa/sherpa-onnx/pull/2897)
- [sherpa-onnx ASR engine overview](https://deepwiki.com/k2-fsa/sherpa-onnx/2.1-automatic-speech-recognition-(asr)-engine)
- [sherpa-onnx Parakeet TDT support (issue #2183)](https://github.com/k2-fsa/sherpa-onnx/issues/2183)
- [`nvidia/parakeet-tdt-0.6b-v3` (CC-BY-4.0)](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [Apple: Bring advanced speech-to-text to your app with SpeechAnalyzer (WWDC25)](https://developer.apple.com/videos/play/wwdc2025/277/)
- [`speech-rs` — Rust bindings for Apple's Speech framework](https://github.com/doom-fish/speech-rs)
- [`swift-scribe-rs` — chose a Swift helper binary over objc2 for SpeechAnalyzer](https://github.com/NimbleAINinja/swift-scribe-rs)
- [SpeechAnalyzer vs SFSpeechRecognizer](https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer)
