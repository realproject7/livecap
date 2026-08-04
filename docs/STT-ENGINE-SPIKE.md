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

**The confidence gate has not been shown to do the job the ticket credits it with.**

Every utterance measured — clean and hallucinated alike — scored **0.888–0.995**
[measured]. The floors (`forced = 0.50`, `auto_detect = 0.60`) therefore **rejected
nothing in any run**, including output containing invented text ("died long after",
0.888). Catching that case would need a threshold above 0.888, which sits between
legitimate outputs measured at 0.913 and 0.933. On the values #111 logged, the
confidence signal **does not cleanly separate hallucinated from clean output** — the
ranges overlap — and #111 accordingly left the floor table at its seed values.

**Read that claim precisely.** It is a statement about the values #111 logged. Whether
those values *are* the gate's own signal is the open question in §2.1.1, and this
document does not settle it. What holds under either answer: the shipped floors rejected
nothing that was measured, and nothing has demonstrated that the signal separates the
two cases.

This matters for #132 more than it looks (§2.1).

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
2. The ticket treats "we would lose whisper's per-token probabilities" as a major
   switching cost. **How much of a loss that is depends on an unresolved question about
   what #111 actually measured** — see §2.1.1. Under the reading the code supports, the
   loss is smaller than the ticket implies; under #111's own caveat, it is untested
   either way. It is not, on any reading, a *demonstrated* asset.

That does **not** make the coupling free: the `auto_detect` floor still needs some
language-confidence signal from any candidate (§2.4).

#### 2.1.1 Unresolved: what the 0.888–0.995 figures are

**This spike could not settle this, and the answer changes how much §1.1 is worth.
Flagging rather than picking the convenient reading.**

`docs/CALIBRATION.md` (PR #199) states its `confidence` column is *"a heuristic
per-utterance value, not the mean per-token probability #111 originally specified"*, and
that separating clean from hallucinated output *"may need the per-token distribution,
which this harness does not expose yet"*.

**The code path appears to say otherwise** [source]: `model_bench.rs` reads
`CaptionKind::Finalized { confidence }`; the pipeline fills that from
`utterance.confidence` (`pipeline.rs:678`), where `utterance` is the engine's return
value (`pipeline.rs:569`); and the engine sets it to `avg_confidence`
(`whisper/engine.rs:396`, `:403`) — the per-segment mean of `full_get_token_prob`
averaged across segments (`:334-369`). That is the **same value the floor gate compares**
(`:385`). On this reading the bench measured the gate's real signal, and §1.1's
conclusion — that it does not separate hallucinated from clean output — stands.

Two ways to resolve, neither of which this spike is authorised to do:
- If #111's caveat is describing a *different* value (a VAD-derived heuristic exists at
  `vad.rs:22-27`, constants 0.8/0.9 — but those do not match the measured spread), the
  gate's real signal is still unmeasured and §1.1 must be read as "the value #111 logged
  did not separate the cases", not as a verdict on the gate.
- If the caveat is simply out of date with the code, §1.1 stands as written and the
  floors' failure to reject anything is a measured property of the shipped gate.

**Either way the conclusion in §6 is unchanged**, because §6 does not rest on the gate
being weak — it rests on speed not being the constraint, the accuracy gap being lexical,
and the multilingual axis being unmeasured. This question should be settled in #111, not
here.

### 2.2 Language-stack mismatch — HOLDS, but the FFI toolchain is already present

The STT core is Rust (`whisper-rs 0.13.2`); reaching Parakeet/Nemotron means ONNX
Runtime or an Apple-framework bridge. Worth noting `objc2 0.6` and friends are
**already dependencies** (`Cargo.toml:52-56`), used today for the Core Audio process tap
and TCC probes — so an Apple path is new bindings, not a new toolchain (§3.2).

### 2.3 License — HOLDS for the reference solution, not a blocker for the components

The reference solution is GPLv3, so no code may be copied into MIT LiveCap; any
adoption is a clean-room reimplementation. The components themselves are permissive:
sherpa-onnx is Apache-2.0 and `nvidia/parakeet-tdt-0.6b-v3` is CC-BY-4.0
**[vendor-claimed]**.

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

- **Confidence surface: OFFLINE ONLY — and this is a design constraint, not a
  footnote.** Checked against the C API the Rust crates wrap, not against feature
  requests:
  - `SherpaOnnxOfflineRecognizerResult` exposes *"optional token log probabilities,
    parallel to `tokens_arr`"* — reachable from Rust, and `exp(log_prob)` yields the
    same `0..1` scale the current gate averages.
  - `SherpaOnnxOnlineRecognizerResult` — the **streaming** path — exposes text, tokens
    and optional timestamps, and **no probability field**.

  So sherpa cannot currently give LiveCap *both* native streaming partials *and* a
  confidence signal on the same path. A design would have to emit partials from the
  streaming recognizer and re-decode each finalized utterance offline to obtain the
  gate input — extra compute per utterance, and a second decode path to keep
  consistent. That is a materially larger integration than "swap the engine".
  - **Correction to an earlier draft of this document:** it cited sherpa-onnx
    PR #2897 (`token_log_probs` / `vocab_log_probs` on `OfflineRecognitionResult`) as
    an available capability. **That PR is closed without merging** and must not be
    counted on. Related work exists (`ys_probs` upstream; PR #2736 exposing it to
    JNI/Kotlin/Java; PR #2843 token-level confidence), but the only thing this
    document now relies on is what the C API header actually declares, above.
  - Whether that signal *discriminates* better than whisper's (§1.1, §2.1.1) is
    unknown and unmeasured on both sides.
- **Language ID confidence: NOT equivalent.** Parakeet TDT v3 covers 25 European
  languages **[vendor-claimed]** but does not expose a per-utterance language posterior
  the way whisper's detection does. The `auto_detect` floor would need rebuilding —
  most plausibly a separate LID model — or auto mode restricted.
- **Acceleration:** ONNX Runtime with a CoreML execution provider; ANE-eligible
  **[vendor-claimed]**.
- **Size / license:** ~0.6 B params (~460 MB class); runtime Apache-2.0, model
  CC-BY-4.0 **[vendor-claimed]**.
- **Streaming:** supported, and on its own it fits the 1200 ms partial cadence better
  than whisper's fixed 30 s window — but see the confidence bullet above: the streaming
  result carries no probabilities, so streaming and gating cannot come from the same
  path.
- **Maturity risk:** three competing Rust binding crates, all young; the C API they wrap
  is stable, the Rust layer is not.
- **Unmeasured against our baseline:** the reference solution rates Parakeet top-tier
  on speed and accuracy **[vendor-claimed]** — but §1 shows speed is not our
  constraint, so the only claim that would matter is accuracy on *real meeting audio in
  the languages we support*, which nobody has measured on either side.

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
| Partials | native streaming, but **no confidence on that path** — finals need a second, offline decode (§3.1) | native streaming | unchanged |
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
- **The confidence gate the ticket treats as the expensive coupling is not a
  demonstrated asset.** The floors rejected nothing in any measured run [measured]; what
  remains genuinely unresolved is whether the value #111 logged is the gate's own signal
  or a different heuristic (§2.1.1). Under either reading it has not been shown to
  separate hallucinated from clean output — which is enough for this conclusion, and no
  more than that should be claimed for it.
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
in §4.1, and evaluate **sherpa-onnx + Parakeet TDT** first: it is the candidate that
keeps a per-token confidence surface reachable from Rust, stays permissively licensed,
and does not raise the platform floor. **Three things must be scoped in that ticket, not
assumed** (§3.1): the LID gap, because auto mode depends on it; the offline-only
confidence surface, which forces streaming partials and gated finals onto two different
decode paths; and the young Rust binding layer. **SpeechAnalyzer stays deferred** until
the bindings question (§3.2) is answered by something other than a Swift helper binary.

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
- [sherpa-onnx C API header — offline result declares optional token log probabilities; the online/streaming result does not](https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/sherpa-onnx/c-api/c-api.h)
- [sherpa-onnx PR #2897 — **closed without merging**; cited only to record that it must NOT be relied on](https://github.com/k2-fsa/sherpa-onnx/pull/2897)
- [sherpa-onnx ASR engine overview](https://deepwiki.com/k2-fsa/sherpa-onnx/2.1-automatic-speech-recognition-(asr)-engine)
- [sherpa-onnx Parakeet TDT support (issue #2183)](https://github.com/k2-fsa/sherpa-onnx/issues/2183)
- [`nvidia/parakeet-tdt-0.6b-v3` (CC-BY-4.0)](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [Apple: Bring advanced speech-to-text to your app with SpeechAnalyzer (WWDC25)](https://developer.apple.com/videos/play/wwdc2025/277/)
- [`speech-rs` — Rust bindings for Apple's Speech framework](https://github.com/doom-fish/speech-rs)
- [`swift-scribe-rs` — chose a Swift helper binary over objc2 for SpeechAnalyzer](https://github.com/NimbleAINinja/swift-scribe-rs)
- [SpeechAnalyzer vs SFSpeechRecognizer](https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer)
