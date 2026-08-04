# Alternative STT engines — feasibility assessment (#132)

Research spike. **No product code, defaults, dependencies, or engine integration is
proposed by this document** — the deliverable is the assessment and the decision rule
in §6.

Written against `main` @ `2ad4674`. Every claim about LiveCap's current behaviour is
cited to a file and line so it can be re-checked rather than believed.

**Evidence labelling used throughout:**
- **[measured]** — operator-measured in #111 / PR #199 (`docs/CALIBRATION.md`), cited
  here, **not independently re-measured by this spike**.
- **[vendor-claimed]** — published by the model/runtime vendor or a third-party
  benchmark. Nothing in this category was run. No competitor engine was executed for
  this document.
- **[source]** — read directly from this repository at the cited line.

---

## 0. Status of the deciding input: #111 is partial, not complete

#132 requires the recommendation be made "with the #111 accuracy data as the deciding
input", and to "Re-evaluate ONLY after #111 reports".

**#111 has now reported in part.** PR #199 (**open**, `task/111-stt-calibration`) adds
`docs/CALIBRATION.md` with a reproducible WAV-fixture harness and real numbers for
`small`, `medium` and `large-v3-turbo`. Those numbers are summarised in §1 and are the
baseline this spike judges candidates against.

**#111 is explicitly still incomplete.** Two rows are outstanding and both bear
directly on this decision:

1. **Microphone-channel phantom measurement.** The first attempt was discarded — the
   operator confirmed real speech was audible during the window, so the captions
   counted were genuine capture, not hallucination. It "cannot be synthesized: digital
   silence and synthetic noise are not classified as speech by Silero, so the VAD never
   invokes whisper and any such test passes vacuously". The system-channel half of that
   run is valid and recorded **zero** phantom captions across 10 minutes per model.
2. **Non-English rows.** Every fixture is English macOS `say` output. Multilingual
   accuracy — the specific axis Parakeet TDT is pitched on — has not been measured at
   all.

So §6 remains a **decision rule**, not an unconditional verdict: the branch that would
most favour an alternative engine is precisely the branch whose evidence is missing.

---

## 1. The incumbent baseline [measured — #111 / PR #199]

All figures below are the operator's, reproduced from `docs/CALIBRATION.md` in PR #199.
This spike did not re-run them.

| model | RTF mean | cold load | notes |
|---|---|---|---|
| `small` (current default) | **0.23** | 0.24 s | 465 MB |
| `large-v3-turbo` | **0.26** | 6.3 s | 1.5 GB; distilled, so faster than `medium` |
| `medium` | **0.32** | 5.8 s | slowest; only model to corrupt a proper noun |

- **Speed is not the problem.** No `FallingBehind` (#141) event fired for any model;
  all three are comfortably real-time on the operator's machine.
- **Accuracy differences are narrow and lexical**: identical, fully correct text on
  clean speech; differences appear on domain vocabulary ("electrocardiogram") and
  proper nouns.
- **All three hallucinate on leading digital silence**, differing in severity;
  `large-v3-turbo` was least damaged. An earlier draft of that document claimed only
  `small` was affected and was corrected — a useful reminder that one fixture is not a
  result.
- **The measurement is a lower bound**: `say` TTS is over-articulated relative to real
  speech, so real meetings should widen the gaps between models.

### 1.1 The finding that most changes this assessment

**The confidence gate is not currently doing the job the ticket credits it with.**

Every utterance measured — clean and hallucinated alike — scored **0.888–0.995**. The
floors (`forced = 0.50`, `auto_detect = 0.60`) therefore **rejected nothing in any
run**, including output containing invented text ("died long after", 0.888). Catching
that case would need a threshold above 0.888, which sits between legitimate outputs
measured at 0.913 and 0.933. On this evidence the confidence signal **does not cleanly
separate hallucinated from clean output** — the ranges overlap — and #111 accordingly
left the floor table at its seed values.

This matters for #132 far more than it looks (§2.1).

---

## 2. What a replacement engine would actually have to satisfy

The ticket lists four risks. Checked against the source and against §1's measurements,
**one is weaker than stated, one is overstated, one rests on a seam that does not
exist, and one holds.**

### 2.1 Confidence-gate coupling — WEAKER than the ticket states

The mechanism is real: `WhisperEngine::transcribe` averages whisper's per-token
probabilities per segment (`whisper/engine.rs:343`, via `full_get_token_prob` — the
reason `whisper-rs` carries the `raw-api` feature, `Cargo.toml:51`), and gates the
result against a **pair** of floors (`engine.rs:23-46`):

| Floor | Meaning |
|---|---|
| `forced` | minimum to emit when the session forces a source language |
| `auto_detect` | stricter floor to *trust* a whisper-detected language; between the two the utterance is dropped rather than mislabelled |

The second is the load-bearing one and easy to miss: it does not gate quality, it gates
**whether the engine's own language guess may be believed**, because a wrong label
mis-routes the channel and translates the wrong direction (`engine.rs:38-45`).

**Two corrections to the ticket's framing:**

1. #132 describes the floors as *"freshly calibrated in #111"*. They are not calibrated
   at all — all five families return the same `SEED_FLOORS { forced: 0.5,
   auto_detect: 0.6 }` (`engine.rs:95-103`), and #111 **deliberately left them there**
   because the signal did not separate the cases (§1.1). There is no calibration for an
   engine switch to discard.
2. The deeper point: the ticket treats "we would lose whisper's per-token
   probabilities" as a major switching cost. Per §1.1 those probabilities **measurably
   failed to discriminate** on every fixture tried. Losing a signal that did not
   separate hallucinated from clean output is a much smaller loss than the ticket
   implies.

That does **not** make the coupling free — the `auto_detect` floor still needs *some*
language-confidence signal from any candidate, and #111 itself notes the per-utterance
`confidence` is a heuristic rather than the per-token distribution originally specified,
so a better whisper-side signal may still exist unexplored. But "the entire gate and
calibration must be redesigned per engine" overstates what is actually at stake today.

### 2.2 Language-stack mismatch — HOLDS, but the FFI toolchain is already present

The STT core is Rust (`whisper-rs 0.13.2`); reaching Parakeet/Nemotron means ONNX
Runtime or an Apple-framework bridge. Worth noting `objc2 0.6` and friends are
**already dependencies** (`Cargo.toml:52-56`), used today for the Core Audio process tap
and TCC probes — so an Apple path is new bindings, not a new toolchain (§3.2).

### 2.3 License — HOLDS for FluidVoice, not a blocker for the components

FluidVoice is GPLv3, so no code may be copied into MIT LiveCap; any adoption is a
clean-room reimplementation. The components themselves are permissive: sherpa-onnx is
Apache-2.0 and `nvidia/parakeet-tdt-0.6b-v3` is CC-BY-4.0 **[vendor-claimed]**.

### 2.4 Pipeline entanglement — OVERSTATED for bleed suppression

The ticket groups "bleed suppression (#56/#64), channel separation, and VAD gating" as
whisper-entangled. Per `suppression.rs:1-25` bleed suppression is
**engine-independent**: an energy gate *before* transcription, plus a normalized-text
near-duplicate drop *after* finalization. Neither touches whisper internals. VAD is
`silero-rs` upstream of the engine (`vad.rs:11`).

The genuine engine-shaped contract is narrower:

| Contract | Where [source] | Engine must provide |
|---|---|---|
| 16 kHz mono `f32` | `vad.rs:16`, fed at `pipeline.rs:316` | same input format (all candidates do) |
| Partial every ~1200 ms, then a final | `pipeline.rs:52-68` | streaming, or cheap re-decode of a growing buffer |
| `DropPartial` ordering | `pipeline.rs:113-117` | partials must be cancellable after emission |
| Per-utterance confidence | `engine.rs:343` | a probability scale to gate on (§1.1 caveat) |
| Language ID + its confidence | `engine.rs:38-45` | per-utterance language, or the auto floor is unimplementable |
| ≥1.1 s segments | `engine.rs:21` | tolerate short segments |

---

## 3. Candidates reachable from Rust without a Swift dependency

### 3.1 sherpa-onnx (Parakeet TDT / Nemotron), via `sherpa-rs` or the `sherpa_onnx` crate

- **Confidence surface: YES** **[vendor-claimed]**. Token-level scores are exposed
  (`ys_probs` on offline transducer results, `token_log_probs` on
  `OfflineRecognitionResult`, per-token confidence via online `GetResult`);
  `exp(log_prob)` yields the same `0..1` scale the current gate averages. Whether it
  *discriminates* better than whisper's (§1.1) is unknown and unmeasured.
- **Language ID confidence: NOT equivalent.** Parakeet TDT v3 covers 25 European
  languages **[vendor-claimed]** but does not expose a per-utterance language posterior
  the way whisper's detection does. The `auto_detect` floor would need rebuilding —
  most plausibly a separate LID model — or auto mode restricted.
- **Acceleration:** ONNX Runtime with a CoreML execution provider; ANE-eligible
  **[vendor-claimed]**.
- **Size / license:** ~0.6 B params (~460 MB class); runtime Apache-2.0, model
  CC-BY-4.0 **[vendor-claimed]**.
- **Streaming:** supported, which fits the 1200 ms partial cadence better than
  whisper's fixed 30 s window.
- **Maturity risk:** three competing Rust binding crates, all young; the C API they wrap
  is stable, the Rust layer is not.
- **Unmeasured against our baseline:** FluidVoice rates Parakeet top-tier on speed and
  accuracy **[vendor-claimed]** — but §1 shows speed is not our constraint, so the only
  claim that would matter is accuracy on *real meeting audio in the languages we
  support*, which nobody has measured on either side.

### 3.2 Apple SpeechAnalyzer (macOS 26+), via `objc2` or `speech-rs`

- **Confidence surface: PARTIAL** **[vendor-claimed]**. `SpeechTranscriptionResult`
  carries confidence and time-range spans, so a per-utterance score is obtainable; it is
  Apple's own scale, so floors cannot be ported numerically and would need calibration
  from scratch.
- **Bindings maturity: the weakest link.** `speech-rs` covers
  SpeechAnalyzer/SpeechTranscriber/SpeechDetector, but a comparable project
  (`swift-scribe-rs`) evaluated `objc2` for exactly this API and **chose a Swift helper
  binary instead**, citing hand-written Objective-C blocks for the async callbacks. A
  Swift helper binary is what #132 rules out.
- **Platform floor:** macOS 26+ — a product decision, not an engineering one. It would
  either raise LiveCap's minimum OS or require keeping whisper as a fallback, i.e. two
  STT engines maintained.
- **Assets:** OS-managed per-locale download; no model shipping, but no control over an
  unavailable locale either.

### 3.3 Staying inside whisper: a tier change, or distilled variants

The option the ticket does not enumerate, and the only one with **zero gate redesign**.
Distilled variants run through the existing `whisper-rs` path, keep
`full_get_token_prob`, keep language detection, and keep both floors on one scale;
`model_family()` already has a fallback arm for unknown names (`engine.rs:73-89`), so
adding a family is a table entry plus calibration, not a subsystem.

**#111 already recommends the cheapest version of this**: switch the default from
`small` to `large-v3-turbo` — best accuracy of the three, least damaged by the
leading-silence stressor, RTF 0.26 with no practical consequence, at the cost of a
1.5 GB download and ~6 s cold load **[measured]**. That is an operator product decision
recorded in PR #199, not something this spike applies.

---

## 4. Integration cost

Relative effort against the current pipeline, not calendar time.

| | sherpa-onnx / Parakeet | SpeechAnalyzer | whisper tier / distilled |
|---|---|---|---|
| New dependency surface | ONNX Runtime + bindings | new bindings (or blocked) | none |
| **STT engine seam** (§4.1) | must be built | must be built | not needed |
| Confidence gate | port scale; rebuild LID floor | recalibrate from scratch | unchanged |
| Bleed suppression | unchanged (§2.4) | unchanged | unchanged |
| VAD handoff | unchanged | overlaps `SpeechDetector` | unchanged |
| Partials | native streaming (better) | native streaming | unchanged |
| Model shipping | +~460 MB | OS-managed | 465 MB → 1.5 GB for turbo |
| Platform floor | unchanged | **macOS 26+** | unchanged |
| Calibration owed | full, new scale | full, new scale | already owed (§1.1) |

### 4.1 There is no STT engine-selection seam

Scope item 4 offers "add ONE alternative behind the existing engine-selection seam".
**That seam does not exist for STT.** `EnginePref = "cli" | "local"`
(`src/protocol.ts:72`) selects the *translation* engine; the STT path holds a concrete
`Arc<WhisperEngine>` (`pipeline.rs:496`) constructed at `pipeline.rs:151`, with no trait
abstraction over transcription anywhere in the crate.

Any multi-engine option therefore includes building that seam first: a transcription
trait, a per-engine gate strategy (the gate is not engine-neutral, §2.1), and a settings
surface. It is the cost most likely to be under-estimated, precisely because the
ticket's phrasing implies it already exists.

---

## 5. What would change these conclusions

- **#111's outstanding rows land** (§0) — specifically the mic-channel phantom
  measurement and any non-English evidence.
- **A per-utterance LID confidence appears for Parakeet**, closing §3.1's functional gap.
- **`objc2` grows first-class Speech bindings**, removing the helper-binary problem.
- **A better whisper-side confidence signal is tried** — #111 notes the current value is
  a heuristic, not the per-token distribution originally specified (§2.1). If the
  per-token distribution *does* separate hallucinated from clean output, the incumbent
  gate becomes materially stronger and the case for switching weakens further.

---

## 6. Recommendation — decision rule, resolved by #111's remaining rows

**On the evidence available today: keep whisper-only, and do not open engine work.**

Not because the alternatives are weak, but because every measured axis points away from
an engine swap being the lever:

- **Speed is not the constraint** — RTF 0.23–0.32, no `FallingBehind` for any model
  **[measured]**. An alternative engine cannot be justified on throughput.
- **The accuracy gap that exists is lexical and moved by model tier**, and #111 already
  recommends the tier change that addresses it **[measured]**.
- **The confidence gate the ticket treats as the expensive coupling is not currently
  discriminating** (§1.1), so it is neither a strong asset to protect nor an expensive
  thing to lose.
- **The one axis where an alternative might genuinely win — multilingual real-meeting
  accuracy — is unmeasured on both sides.**

When #111's remaining rows land, this resolves without another research round:

**A. Mic-channel phantom measurement comes back clean, and no non-English gap is
reported.**
→ **Stay whisper-only; close #132.** Adopt the #111 tier recommendation as a product
decision. Revisit only if real-world reports contradict the bench.

**B. Phantom captions are confirmed on the mic channel in a verified-quiet room.**
→ **Not an engine question first.** §1.1 shows the confidence gate does not separate
these cases, so the fix is a *suppression* strategy — per-token distribution, or a
non-confidence signal — filed as its own ticket. An engine swap would inherit the same
unsolved discrimination problem with a less-understood confidence scale.

**C. A non-English accuracy gap is measured that `large-v3-turbo` does not close.**
→ **This is the branch that justifies engine work.** Open a separate ticket for the seam
in §4.1, and evaluate **sherpa-onnx + Parakeet TDT** first: the only candidate that
keeps a real per-token confidence surface, stays permissively licensed, and does not
raise the platform floor. Its LID gap (§3.1) must be scoped in that ticket, because auto
mode depends on it. **SpeechAnalyzer stays deferred** until the bindings question
(§3.2) is answered by something other than a Swift helper binary.

**In all branches:** any candidate must be measured against §1's fixtures before
adoption, not against vendor benchmarks. Every competitor figure in this document is
**[vendor-claimed]**; none was run here, and #111's own harness exists precisely because
claimed numbers were not trusted.

---

## Sources

Repository claims are cited inline to `main` @ `2ad4674`. Measured figures are from
#111 / PR #199 (`docs/CALIBRATION.md`, open at the time of writing). External claims:

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
