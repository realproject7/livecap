# STT Calibration (#111)

Measured 2026-08-04/05 on the operator's Mac (Apple silicon, macOS 15) against
`main`. Every number here is reproducible with the harness described below —
no device state, TCC grant, or quiet room required.

## Method

`cargo run --release -p livecap-core --example model_bench -- --wav <file> --model <name>`

The harness feeds ONE recorded WAV through the **real** pipeline
(`CaptionPipeline::feeder`), so the same bytes reach the real VAD and the real
whisper engine for every model. This replaced an earlier device-capture harness
that recorded through the microphone: those numbers were discarded because a
room cannot be proven silent, and the first run was in fact contaminated by real
speech in the room (see "Discarded measurements" below).

Fixtures are macOS `say` output at 16 kHz mono:

| id | voice / rate | domain | length |
|----|--------------|--------|--------|
| f1 | default, 165 wpm | business/finance | 19.5 s |
| f2 | Samantha, 190 wpm | engineering/deploys | 12.3 s |
| f3 | Daniel, 145 wpm | clinical | 13.6 s |
| f1-pad, f3-pad | as above + 1 s of leading digital silence | hallucination stressor | +1 s |

## Throughput (real-time factor)

RTF = processing wall-time ÷ audio duration. Lower is better; < 1.0 is real-time.

| model | f1 | f2 | f3 | mean | cold load |
|-------|----|----|----|------|-----------|
| tiny | 0.098 | — | — | 0.10 | 0.13 s |
| **small** (current default) | 0.191 | 0.251 | 0.251 | **0.23** | 0.24 s |
| large-v3-turbo | 0.206 | 0.307 | 0.281 | **0.26** | 6.3 s |
| medium | 0.271 | 0.341 | 0.346 | **0.32** | 5.8 s |

`large-v3-turbo` is faster than `medium` despite being larger — it is a
distilled model. No `FallingBehind` (#141) event fired for any model, so all
three are comfortably real-time on this machine. Cold load is one-time per
session; warm loads measured 0.6–0.9 s.

## Accuracy

On clean speech (f2) all three models produced identical, fully correct text.
Differences appear on domain vocabulary and proper nouns:

- **f3 (clinical):** `small` produced "electrocardogram"; `medium` and
  `large-v3-turbo` produced "electrocardiogram" correctly.
- **f1-pad:** `medium` corrupted a proper noun ("Sarah" → "SBA");
  `large-v3-turbo` kept it correct.

## Hallucination on leading silence

The `*-pad` fixtures prepend 1 s of digital silence. This is a deliberately
harsh stressor — a real room has a noise floor, not digital zero — but it is
identical for every model, so the comparison is fair.

| model | f3-pad | f1-pad |
|-------|--------|--------|
| small | invented **"died long after"** before the speech | swallowed the opening clause ("The committee reviewed the quarterly figures" → "reviews") |
| medium | clean | invented **"AT HE"** prefix, and corrupted "Sarah" → "SBA" |
| large-v3-turbo | clean | invented a 2-character **"CT"** prefix; everything else correct |

All three models produce artifacts on leading silence; they differ in severity.
`large-v3-turbo` was the least damaged in both trials.

> An earlier draft of this document claimed only `small` hallucinated. That was
> based on a single fixture and was wrong — the second fixture showed all three
> affected. Kept here because the correction is the point: one fixture is not a
> result.

## Confidence floors — NO change recommended yet

Current floors (`whisper/engine.rs`, seeded uniformly for every family):
`forced = 0.50`, `auto_detect = 0.60`.

Every utterance measured — clean and hallucinated alike — scored **0.888 to
0.995**. The floors sit far below that entire range, so **they rejected nothing
in any run**, including the output that contained invented text ("died long
after", confidence 0.888).

Raising the floors to catch that case would require a threshold above 0.888,
which is uncomfortably close to legitimate output measured at 0.913 (`medium`,
f1-pad) and 0.933 (`small`, f3). On this evidence the confidence signal **does
not cleanly separate hallucinated from clean output** — the ranges overlap.

Therefore: **the per-family floor table is left at the seed values.** Changing
it would be tuning on noise. Model choice is the lever that actually moved
hallucination severity here; the floor is not.

Two limitations to resolve before revisiting:

1. `confidence` is a heuristic per-utterance value, not the mean per-token
   probability #111 originally specified. Separating clean from hallucinated
   output may need the per-token distribution, which this harness does not
   expose yet.
2. `say` TTS is over-articulated relative to real speech. Real meetings should
   widen the gaps between models, so these numbers are a **lower bound** on the
   differences.

## Model recommendation

**Recommend switching the default from `small` to `large-v3-turbo`** — an
operator product decision, not applied in this document.

For it:
- Best accuracy of the three (only model correct on both domain vocabulary and
  proper nouns).
- Highest confidence in every single run (0.978–0.994).
- Least damaged by the leading-silence stressor.
- RTF 0.26 vs `small`'s 0.23 — a difference with no practical consequence at
  these margins, and far from the `FallingBehind` threshold.

Against it:
- 1.5 GB download vs 465 MB — a real first-run cost on a metered connection.
- ~6 s cold load vs 0.24 s. The app already surfaces
  "preparing the caption model…" during this, but the wait is noticeable.

`medium` is not recommended: slowest of the three, and the only model that
corrupted a proper noun.

## Discarded measurements

A device-capture phantom test (10 min of "silence" per model, captions counted
through the microphone) was run first and **its microphone-channel results were
discarded**. The operator confirmed real speech was audible in the room during
the window; the 10 captions recorded against `small` were genuine capture, not
hallucination. Reporting them would have argued for a default-model change on
false evidence.

The system-channel half of that run is valid — nothing was played, and the
system tap only receives application audio — and recorded **zero** phantom
captions for all three models over 10 minutes each.

**Still outstanding:** microphone-channel phantom measurement (#111 row 1)
requires a genuinely quiet room and cannot be synthesized: digital silence and
synthetic noise are not classified as speech by Silero, so the VAD never invokes
whisper and any such test passes vacuously. It must be run in a confirmed-quiet
window, with the room state recorded alongside the numbers.

Rows 2 and 3 of the #111 matrix (forced-English on English audio; auto mode on
JA/ZH clips) also remain outstanding — they need non-English source audio that
this fixture set does not contain.
