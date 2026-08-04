# STT Calibration (#111)

Measured 2026-08-04 18:00 – 2026-08-05 (KST) on the operator's Mac (Apple silicon, macOS 15) against
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
| tiny | 0.098 | — | — | 0.10 (single fixture) | 0.13 s |
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

### Every measured utterance, with what was wrong with it

Each run produced exactly ONE finalized utterance (`finalized_count=1`), so a
run label IS an utterance label — there is no averaging hiding inside a row.
Confidence is the value the harness prints per finalized utterance.

| fixture / model | confidence | damage in that exact output |
|---|---|---|
| f1-pad / `small` | 0.9465 | swallowed the opening clause |
| f1-pad / `medium` | **0.9134** | invented "AT HE" prefix; "Sarah" → "SBA" |
| f1-pad / `large-v3-turbo` | 0.9813 | invented "CT" prefix |
| f1-pad / `large-v3-turbo-q5_0` | 0.9786 | invented "Katie" prefix |
| f3-pad / `small` | **0.8884** | invented "died long after" |
| f3-pad / `medium` | 0.9557 | none found |
| f3-pad / `large-v3-turbo` | 0.9787 | none found |
| f3-pad / `large-v3-turbo-q5_0` | 0.9773 | none found |
| f1 / `small` | 0.9698 | opening words dropped (fixture artifact — no leading audio) |
| f1 / `medium` | 0.9949 | none found |
| f1 / `large-v3-turbo` | 0.9936 | opening words dropped (same artifact) |
| f1 / `large-v3-turbo-q5_0` | 0.9921 | opening words dropped (same artifact) |
| f2 / `small` | 0.9577 | none found |
| f2 / `medium` | 0.9679 | none found |
| f2 / `large-v3-turbo` | 0.9781 | none found |
| f2 / `large-v3-turbo-q5_0` | 0.9768 | none found |
| f3 / `small` | **0.9330** | "electrocardogram"; "2 weeks" |
| f3 / `medium` | 0.9479 | "wor sen" split |
| f3 / `large-v3-turbo` | 0.9879 | "wor sen" split |
| f3 / `large-v3-turbo-q5_0` | 0.9893 | none found |

Regenerate any row with the command in **Method** above.

### What the table shows

Sorting the 20 rows by confidence and marking each as damaged or clean settles
the question the earlier drafts of this document got wrong twice:

- clean utterances span **0.9557 – 0.9949** (n=9)
- damaged utterances span **0.8884 – 0.9936** (n=11)

**The ranges overlap.** Six damaged utterances score ABOVE the lowest clean one
(0.9557): 0.9698, 0.9786, 0.9813, 0.9879, 0.9921, 0.9936. Three of those six are
the f1 fixture-artifact rows, so excluding them entirely — the most sceptical
reading — three still remain (0.9786 "Katie" prefix, 0.9813 "CT" prefix, 0.9879
"wor sen"). The conclusion holds either way.

So **confidence does not separate damaged from clean output.** Most damage lands
squarely inside the clean range.

> **Correction history, kept deliberately.** The first draft asserted this
> overlap but cited two damaged runs (0.913, 0.933) as if they were "legitimate
> output" — a real error, caught in review. The second draft over-corrected and
> WITHDREW the overlap claim entirely, and additionally stated that "the four
> highest scores all have no damage found", which the table above falsifies: the
> top four are 0.9893 clean, 0.9921 damaged, 0.9936 damaged, 0.9949 clean. Both
> corrections came from review, not from the author. The claim is right; the
> first draft simply had not published the data that proves it.

### What a floor could and could not do

The floors sit at 0.50/0.60, far below the entire measured range, so **they
rejected nothing in any run** — including the output that invented a phrase
(0.888). That is the operative fact today.

A floor placed between 0.8884 and 0.9557 would remove the single worst output
without rejecting any clean one. But that is the *tail*, not the *classes*: six
damaged utterances (three excluding fixture artifacts) sit above the lowest clean
score and no threshold can reach them without discarding good captions. A floor
can trim the worst hallucination; it cannot be the mechanism that tells damaged
from clean.

Therefore: **the per-family floor table is left at the seed values.** Setting one
at ~0.90 would be fitting a threshold to a single observation (0.888) from five
over-articulated TTS fixtures, and it would buy only the tail while leaving the
overlap untouched.

Two limitations to resolve before revisiting:

1. `confidence` is a heuristic per-utterance value, not the mean per-token
   probability #111 originally specified. Since the heuristic demonstrably does
   NOT separate the classes, measuring the per-token distribution is the
   substantive next step — it is the remaining candidate for a real gate.
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
captions for all three models over 10 minutes each. The full row was later
re-measured cleanly in a confirmed-quiet room; see "Row 1 phantom measurement"
above.

### Row 1 phantom measurement — system channel COMPLETE, mic channel INCONCLUSIVE

Re-run 2026-08-04 21:39–22:15 (KST) in an operator-confirmed quiet room, 10 min
per model after a 90 s warm-up:

| model | system-channel phantoms | mic-channel phantoms |
|---|---|---|
| `small` | 0 | 0 |
| `medium` | 0 | 0 |
| `large-v3-turbo` | 0 | 0 |

Each model was gated behind a **readiness check** before its silence window —
a spoken sentence had to be transcribed first, so a model that failed to load
could not score a false zero. (An earlier run reported `large-v3-turbo` as
producing nothing at all; that turned out to be a 25 s warm-up that was too
short for a 1.5 GB model, not a defect. The readiness gate exists because of it.)

Session liveness during each silence window was verified rather than assumed:
the archive file was still being written at 21:50:59, i.e. to the end of the
window, and the final count was taken before the app was stopped. The 2-minute
span shown in the archive header is the last **brief** timestamp, not the
session length — silence produces no content to summarise, so `endClock` stops
advancing (`packages/archive/src/writer.ts:178-179`).

**The mic-channel result is NOT claimed as complete, and the zero above must not
be read as one.** The readiness check exercises the SYSTEM channel only (a played
sentence). Mic liveness inside the window is *circumstantially* supported —
`captureMic: true`, no channel-off note in the archive header (#53 writes one
when a channel is disabled), and the same build captured real mic speech earlier
the same evening — but it was never positively confirmed **inside** the
measurement window, and a dead mic stream produces exactly the same zero. Until
the harness grows a mic-channel readiness check, this row is:

- **system channel: complete** — 0 phantoms, all three models, 10 min each, with
  a positive readiness control
- **mic channel: inconclusive** — 0 observed, but the negative control is
  unverified

Treating the mic half as done would be the same vacuous-zero mistake the
readiness gate exists to prevent.

**Superseded:** an earlier attempt at this row was discarded. Its
microphone-channel numbers (2, then 10 captions against `small`) were real
speech in the room, confirmed by the operator, not hallucination — see
"Discarded measurements" below.

Rows 2 and 3 of the #111 matrix (forced-English on English audio; auto mode on
JA/ZH clips) also remain outstanding — they need non-English source audio that
this fixture set does not contain.
