# PROPOSAL: LiveCap — Local-First Real-Time Meeting Captions & Translation

> **Date:** 2026-06-11
> **Status:** Draft v1.1 (v1.0: product/architecture; v1.1: name decided **LiveCap**, domain `livecap.app`, design concept §7 + wireframes §8 added)
> **Type:** Product proposal + MVP plan
> **Name:** **LiveCap** — domain `livecap.app` (✅ available as of 2026-06-11, register immediately; optional `livecap.xyz` defensive redirect)
> **One-line summary:** A local-first desktop app that captures system audio + microphone, shows live captions in the detected language, and displays translations underneath — powered by local Whisper for STT and the user's own Claude/Codex CLI subscription (with a local-LLM fallback) for translation, summaries, and reply suggestions.

---

## 1. Executive Summary

LiveCap is a floating always-on-top overlay for live conversations (video calls, webinars, in-person meetings):

- **Captures both system audio and microphone** simultaneously, keeping the channels separate ("them" vs "me").
- **Transcribes locally** with Whisper-class models — partial text appears word-by-word, no cloud STT.
- **Translates each finalized sentence** into the user's target language and renders it under the original caption.
- **Adds LLM-powered extras** on the same engine: a rolling one-line live summary, a meeting board, a quick-translate input box, and reply suggestion chips (agree / push back / ask / suggest).
- **Auto-saves every session** as a clean Markdown file (captions + translations + summary + board) to a local folder — the meeting ends and the record already exists, with zero extra clicks.
- **Default UI language: English.** First target pair: English ↔ Korean, but language detection is automatic and the architecture is language-agnostic.

The differentiator: **no API key, no separate subscription, no cloud account.** Like open-design did for design tooling, LiveCap detects the Claude or Codex CLI already installed on the machine and reuses the user's existing plan for the LLM layer. Nobody in the current open-source field (Meetily, Hyprnote, LiveCaptions-Translator, etc.) does this.

Everything runs on-device except the optional CLI calls, which go through the user's own authenticated CLI.

---

## 2. What Exists Already (Competitive / Reuse Landscape)

Researched 2026-06-11. Two findings: (a) the building blocks are mature and permissively licensed, (b) the "reuse your CLI subscription" angle is unoccupied.

| Project | License | What it proves / what we take |
|---|---|---|
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | **MIT** | Primary reuse target. Rust/Tauri core: simultaneous mic + system audio capture with mixing/ducking, live Whisper/Parakeet STT (Metal/CUDA), speaker diarization. macOS + Windows. **No real-time translation** — that's the gap we fill. |
| [Hyprnote](https://hyprnote.com/opensource) | GPL-3.0 | Validates the local meeting-notepad market. **Do not copy code** (GPL). |
| [LiveCaptions-Translator](https://github.com/SakiRinn/LiveCaptions-Translator) | — | Closest UX reference (caption + translation stacked). Windows-only, depends on Windows Live Captions. |
| [electron-speech-to-speech](https://github.com/Kutalia/electron-speech-to-speech) | Apache-2.0 | Proves whisper.cpp native addon with Metal/Vulkan in a desktop webview app. |
| [open-design](https://github.com/nexu-io/open-design) | Apache-2.0 | The CLI-integration pattern (§5). Adapter def + stream parser are directly reusable references. |
| whisper.cpp, faster-whisper, Tauri | MIT | Core building blocks, all safe. |

**Known gotcha:** Whisper's built-in `translate` task is X→English only. It cannot produce English→Korean. Translation must be a separate layer — which is exactly where the LLM goes.

---

## 3. Architecture

```
┌─ System audio ─┐
│                ├─► Audio capture (Meetily-derived Rust core, Tauri)
└─ Microphone ───┘        │
                          ▼
                   VAD + segmenter (Silero)
                          │
                          ▼
                   Whisper STT (whisper.cpp / Parakeet, Metal/CUDA)
                     ├─ partial text ──► caption block, updated live (greyed)
                     └─ finalized sentence ──► translation queue (batch 2–4)
                                                    │
                                                    ▼
                                     Translation Provider (pluggable, §4)
                                                    │
                                                    ▼
                                     translation rendered under caption
                          │
                          └─ accumulated transcript ──every 60s──►
                             same provider ──► live summary / meeting board /
                                               reply suggestions
```

- **Framework: Tauri, not Electron.** Same framework as the Meetily core (zero porting friction), ~10 MB binary, native always-on-top overlay, and it sidesteps Electron's macOS loopback-audio quirks entirely.
- **Two-stage caption display** (validated against the reference app's UX): original text streams in word-by-word immediately; translation attaches once the sentence finalizes (punctuation + VAD pause). Expected lag between caption and translation: ~0.5–1.5 s.
- **Queue discipline:** when speech outruns translation, merge the backlog into one batched request and always prioritize the newest sentence. Without this the translation column drifts 30+ seconds behind.

---

## 4. Translation Engine — Three-Tier Provider Interface

One interface (`sentence + rolling context + glossary in → translation out`), three implementations:

| Tier | Engine | Cost | Role |
|---|---|---|---|
| **1. CLI mode** (default when detected) | Claude Code / Codex CLI, persistent stream-json session, model pinned to Haiku | Agent SDK credit pool (§6) | Best quality: cleans up disfluencies, keeps terminology consistent via rolling context + glossary. Also powers summary/board/suggestions. |
| **2. Local LLM fallback** | llama.cpp + Qwen3 4B Instruct (Apache 2.0), bundled/auto-downloaded | $0 | Auto-engaged when no CLI is found or the credit pool nears exhaustion. Product survives any Anthropic policy change. |
| **3. BYO API key** (post-MVP) | Anthropic/OpenAI API | User-paid | Heavy users who outgrow the pool. |

Why an LLM and not an NMT model (M2M100 etc.): live STT output is full of disfluencies ("and and… hard to… somebody's one"). NMT translates the fragments literally; an LLM tidies them into natural target-language sentences and uses conversation context. NLLB is ruled out regardless (CC-BY-NC). A 4B-class model at Q4 on Apple Silicon emits 50–100+ tok/s → sub-second per sentence; RAM footprint ~3 GB alongside Whisper's ~1 GB.

Prompt contract for all tiers: low temperature, "output the translation only, nothing else," empty output allowed for non-translatable fragments, last N sentence pairs + glossary as context (cacheable system prompt in CLI mode).

---

## 5. CLI Integration Pattern (verified from open-design source)

Analyzed from a clone of nexu-io/open-design (Apache-2.0), 2026-06-11. No PTY tricks, no hidden API — the pattern is plain headless CLI driven over stdio:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       [--include-partial-messages]        # probe `claude -p --help` first; older builds reject it
       [--model haiku]
       [--resume <session-id> | --session-id <app-generated-uuid>]
```

Key mechanics to replicate:

1. **Detection:** scan PATH for `claude` / `codex` (+ argv-compatible forks as fallback bins). Probe `--version` and `-p --help` output for capability flags before using them.
2. **Prompt via stdin, not argv** — avoids Linux `E2BIG` and Windows command-line length limits.
3. **`--input-format stream-json` keeps stdin open** — the app streams JSONL user messages into one live turn. For our use case: one process stays alive for the whole meeting; each finalized sentence batch is one stdin line; each response streams back as `text_delta` events.
4. **Session continuity** via app-generated `--session-id`, resumed with `--resume` if the process restarts.
5. **Auth = don't interfere.** Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child env (unless a custom base URL is set) so the CLI's own `claude login` (Pro/Max OAuth) wins. This is the entire "use your subscription" mechanism — open-design issue #398 documents the failure mode when you don't.
6. **Stream parser:** JSONL stdout → events. We need only `text_delta` and `usage`; open-design's 549-line parser (claude-stream.ts) is the reference, ours will be far smaller (no tool_use handling).
7. **`usage` events carry `total_cost_usd`** — this drives the credit gauge (§6) for free.

Codex CLI gets a sibling adapter (`codex proto` stdio protocol) behind the same interface.

---

## 6. Billing Reality (June 15, 2026 Policy) — Why This Still Works

Verified against the [official policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [headless docs](https://code.claude.com/docs/en/headless):

- From **2026-06-15**, all programmatic CLI use (`claude -p`, Agent SDK, stream-json) draws from a **monthly Agent SDK credit pool**, separate from interactive limits: **Pro $20 / Max 5x $100 / Max 20x $200**. Exhausted pool = hard stop (or API-rate overflow if the user opts into usage credits). Credits are per-user, no rollover.
- **PTY-wrapping the interactive CLI to dodge the classification is explicitly out of scope.** It is undocumented gray area, it gambles with users' accounts, and Anthropic's trajectory (Jan OAuth crackdown → June credit split) says it dies in one policy update. We do not build on it.
- **The pool is sufficient for this workload.** Unlike coding agents (which burn the pool in days — open-design has no public mitigation yet; their answer is their own hosted router, AMR), translation is cheap. Haiku at ~250 in / ~60 out tokens per sentence, 2-sentence batching, ~700 sentences/hour:

| Item | Cost per meeting-hour |
|---|---|
| Translation (Haiku, batched) | ~$0.30 |
| Live summary (60 s cadence, cached system prompt) | ~$0.10 |
| **Total** | **~$0.40/hr → Pro pool ≈ 50 hrs/mo, Max 5x ≈ 250 hrs/mo** |

- **Product features that make the policy livable:**
  - **Credit gauge** in-app: accumulate `total_cost_usd` per response → "$7.40 of $20 pool used (~32 hrs)".
  - **Graceful degradation:** as the pool nears empty, auto-switch to the local LLM tier with a toast — the captions never stop.

> ⚠️ The $0.40/hr figure is an estimate. **PoC #1 exists to measure it** before anything else is built.

---

## 7. Design Concept — "Glass"

**Design principle: the app is a pane of glass between you and the conversation. The words are the product; everything else must disappear.**

LiveCap lives *next to* a meeting the user is actively in. Every pixel of chrome competes with a real human on the other side of the call. So the charm budget is spent on exactly one thing — **typography hierarchy on translucent glass** — and the discipline budget on one thing: **never demanding attention.**

### 7.1 The five rules

1. **Text floats, chrome vanishes.** No borders, no card outlines, no visible buttons at rest. Controls exist only on hover and fade out after 3 s of stillness. Separation comes from spacing and 4%-white hairlines, never boxes.
2. **Hierarchy is brightness.** Original caption = full brightness. Translation = one tone down. Streaming partial text = two tones down. The eye learns the layers in seconds without a single label.
3. **One accent color.** A warm amber, used only for *live* things: the recording dot, the live-summary bullet, a pin. Everything else is monochrome.
4. **Motion is fade, never slide.** New captions fade in over ~150 ms in place. Nothing bounces, slides, or scrolls unexpectedly under the user's eyes mid-meeting.
5. **Invisible to everyone else.** The overlay window is excluded from screen capture (`sharingType = none` on macOS) — when the user shares their screen, the audience never sees LiveCap. This single feature is the strongest "seamless" guarantee in the product and a marketing line on its own: *"Your captions. Nobody else's."*

### 7.2 Design tokens (launch set)

| Token | Value | Used for |
|---|---|---|
| `glass/bg` | near-black @ ~55% opacity + 24 px backdrop blur | panel background |
| `text/original` | #F2F4F6 (full) | finalized caption |
| `text/translation` | #B8BEC6 (one tone down) | translation line |
| `text/partial` | #8A9099 (two tones down) | streaming words |
| `text/meta` | #6B7178, 11 px | timestamps, channel labels |
| `accent/live` | warm amber #E8B84B | rec dot, summary bullet, pins |
| `hairline` | white @ 4% | only divider allowed |
| Type scale | original 15/1.45 · translation 13.5/1.4 · meta 11 | system font (SF Pro / Segoe) |
| Numerals | monospaced digits | credit gauge, timers |

App icon: a dark frosted-glass rounded square with two text lines — a bright one over a dim one. The icon *is* the product's hierarchy rule.

Brand surfaces: wordmark `LiveCap` appears in the menu bar item, onboarding, and Settings/About only. The live panel itself is brand-silent — rule 1 applies to our own logo too.

### 7.3 Seamless behaviors (what "sits beside your meeting" means concretely)

| Behavior | Spec |
|---|---|
| Always available | always-on-top; joins all Spaces and fullscreen apps (macOS `collectionBehavior`) |
| Three sizes, one app | **Capsule** (one-line pill) ↔ **Strip** (TV-subtitle bar) ↔ **Panel** (full feed). Cycle via hover control or `⌥Space` family of hotkeys; size remembered per display |
| Edge-snap | magnetic to screen edges/corners; Strip docks to bottom-center by default |
| Screen-share privacy | excluded from capture (rule 5); amber dot in our own UI confirms "hidden from share" |
| Click-through (Strip/Capsule) | optional: mouse events pass through to the app underneath; hover near edge to regain controls |
| Quiet failures | engine hiccups never modal; a one-line inline notice in the meta tone ("reconnecting engine…") |
| Channel identity | "them" captions left-aligned, "me" right-aligned — no avatars, no names, alignment is the label |

---

## 8. Wireframes

All frames share the Glass tokens; `▍` marks live-streaming text; `(amber)` marks the single accent.

> **Design package (hi-fi):** `~/Projects/z-design/livecap-design/` — tokens.css + design-system sheet, final app icon & menu bar glyph (Open Design pipeline), and 2× PNG mockups of every screen below (HTML sources included for iteration). See its `README.md` for the asset→section→ticket mapping.

### 8.1 The three window modes

```txt
CAPSULE — idle/minimal (one line, latest caption only, ~420×44)
╭──────────────────────────────────────────────╮
│ ●(amber)  …and treat it as a stack rank ▍    │
╰──────────────────────────────────────────────╯
   click → Panel · drag → move · ⌥Space → cycle

STRIP — TV-subtitle mode (bottom-center dock, ~720×88, click-through on)
╭────────────────────────────────────────────────────────────╮
│   That doesn't necessarily… somebody's one or somebody's   │
│   three may be more important ▍                            │
│   몇몇 사람의 '1'이 다른 사람의 '3'보다 중요할 수 있습니다     │
╰────────────────────────────────────────────────────────────╯

PANEL — full feed (default ~520×640, the main screen, §8.2)
```

### 8.2 Live Panel (main screen)

```txt
╭──────────────────────────────────────────────────────╮
│ ⏸ ⏹    Live · Summary · Board            ⌃ ⋯ ✕     │ ← chrome row:
│                                                      │   visible on hover
├──────────────────────────────────────────────────────┤   only, fades 3s
│ ●(amber) Discussing MAU criteria and how to rank     │ ← live summary,
│          interest levels…                            │   refreshed ~60s
│                                                      │
│   Pat, thanks a lot.                          10:45  │ ← them: left,
│   Pat, 정말 고마워요.                                  │   translation
│                                                      │   one tone down
│   Have a good day.                            10:45  │
│   좋은 하루 보내세요.                                  │
│                                                      │
│                      I agree, but I'm a bit   10:45  │ ← me: right-
│                      worried about the budget.       │   aligned, same
│                      동의하지만 예산이 걱정돼요.        │   hierarchy
│                                                      │
│   📌 …treat it as a stack rank rather than    10:46  │ ← pinned: amber
│   a raw excitement level.                            │   pin, stays
│   단순 흥미도가 아니라 스택 랭킹으로 보자는 것.          │   above input
│                                                      │
│   And I had, um, I started by ju▍                    │ ← streaming:
│                                                      │   2 tones down,
├──────────────────────────────────────────────────────┤   no translation
│  ✦ Suggest   👍 Agree   ✋ Push back   ? Ask          │ ← reply chips
│ ╭──────────────────────────────────────────────╮     │
│ │ Quick translate — type in your language…   ↑ │     │ ← quick-translate
│ ╰──────────────────────────────────────────────╯     │
╰──────────────────────────────────────────────────────╯
```

Interaction notes:
- Scroll up = history (auto-scroll pauses); any new caption shows a "↓ live" chip; one click snaps back.
- Hover a caption block → ghost actions appear inline: 📌 pin · ⧉ copy · ⟳ retranslate.
- Hover the translation → original/translation swap emphasis (useful when listening in your own language).

### 8.3 Caption block states

```txt
1. STREAMING (partial, no translation yet)
   And I had, um, I started by ju▍            ← two tones down

2. FINALIZED (translation pending, <1.5s window)
   And I had — I started by just listing      ← full brightness
   ⋯                                          ← subtle ellipsis shimmer

3. TRANSLATED (steady state)
   And I had — I started by just listing
   목록을 만드는 것부터 시작했습니다             ← one tone down

4. LOW-CONFIDENCE (STT unsure / heavy crosstalk)
   (and treat it as a stack(?) rank…)         ← meta tone + (?)
   그리고 그것을 스택 랭크(?)로 취급…

5. PINNED
   📌(amber) + block held above the input row until unpinned
```

### 8.4 Summary · Board tabs (same window, same glass)

```txt
SUMMARY                                   BOARD
╭────────────────────────────────╮  ╭────────────────────────────────╮
│ MEETING SO FAR        47 min   │  │ MEETING BOARD                  │
│                                │  │                                │
│ • Stack-rank vs raw excitement │  │ DECISIONS                      │
│   scoring for feature voting   │  │ • Use stack rank, not raw      │
│ • Budget concern raised on     │  │   excitement scores            │
│   contractor expansion         │  │ ACTION ITEMS                   │
│ • MAU threshold: 3 candidate   │  │ □ Mike → share apps list       │
│   definitions discussed        │  │ □ Me → budget memo by Fri      │
│                                │  │ OPEN QUESTIONS                 │
│ (English ▾ / 한국어 ▾)          │  │ ? Which MAU definition wins    │
│ [Copy] [Save .md]              │  │ [Copy] [Save .md]              │
╰────────────────────────────────╯  ╰────────────────────────────────╯
```

Board updates on the same 60 s cadence as the summary — one LLM call feeds both.

### 8.5 Reply chips & quick translate

```txt
tap ✋ Push back →
╭──────────────────────────────────────────────────────╮
│ ✋ In English, you could say:                         │
│                                                      │
│   "I see the logic, but I'd push back on using       │
│    stack rank alone — intensity matters when         │
│    two features tie."                                │
│                                                      │
│   [⧉ Copy]  [⟳ Another]  [✕]                         │
╰──────────────────────────────────────────────────────╯
   — generated from the last ~10 captions; never auto-sent;
     copy-to-clipboard is the only output (we are not a bot).

quick translate: type "이거 다음 분기로 미루면 어때요?" + ↑ →
   inline result card: "How about pushing this to next
   quarter?" + [⧉ Copy] — same glass, no popup window.
```

### 8.6 First-run onboarding (3 screens, <60 seconds)

```txt
1 · AUDIO                        2 · LANGUAGE                   3 · ENGINE
╭───────────────────────╮  ╭───────────────────────╮  ╭───────────────────────╮
│ LiveCap hears two     │  │ Translate into…       │  │ ✓ Claude CLI found    │
│ things:               │  │  [한국어 ▾]            │  │   (Pro plan, signed   │
│  🔊 what you hear     │  │                       │  │    in as cho@…)       │
│  🎤 what you say      │  │ Speech is detected    │  │ → meetings use your   │
│                       │  │ automatically — no    │  │   plan: ~50 hrs/mo    │
│ [Grant audio access]  │  │ source language to    │  │ ▢ or: local model     │
│  → macOS permission   │  │ pick.                 │  │   (free, 2.4 GB DL)   │
│    sheet              │  │                       │  │                       │
│                       │  │        [Continue]     │  │   [Start captioning]  │
╰───────────────────────╯  ╰───────────────────────╯  ╰───────────────────────╯
```

If no CLI is found, screen 3 leads with the local model and mentions CLI support one line below — never a dead end.

### 8.7 Settings (single sheet) & credit gauge

```txt
╭──────────────────────────────────────────────╮
│ SETTINGS                                     │
│                                              │
│ ENGINE                                       │
│  ◉ Claude CLI (Haiku)      ○ Local (Qwen 4B) │
│  This month  ▓▓▓▓▓▓░░░░  $7.40 / $20.00      │ ← monospaced digits
│  ≈ 32 meeting-hours left · resets Jul 1      │
│  ▢ Auto-switch to Local when pool runs low ✓ │
│                                              │
│ LANGUAGE     translate into [한국어 ▾]        │
│ CAPTIONS     size [Aa Aa Aa]  ▢ click-through│
│ PRIVACY      ✓ hidden from screen sharing    │
│              ✓ audio never leaves this Mac   │
│ HOTKEYS      show/hide ⌥Space · mode ⌥⇧Space │
╰──────────────────────────────────────────────╯
```

### 8.8 Menu bar presence

```txt
  …  ◐(amber when live)  LiveCap
      ├ Show / Hide          ⌥Space
      ├ Mode: Capsule·Strip·Panel
      ├ Pool: $7.40/$20 (≈32 hrs)
      ├ Start/Stop captioning
      └ Settings… · Quit
```

The menu bar dot is the only place LiveCap exists when hidden — closing the panel never kills the session unless Stop is chosen.

### 8.9 Session Archive (auto-save)

**Every session writes itself to disk.** When captioning stops (Stop button, app quit, or 10 min of silence → auto-stop prompt), LiveCap finalizes a Markdown file it has been appending to throughout the session — a crash mid-meeting loses nothing, because the file is written incrementally, not at the end.

```txt
~/Documents/LiveCap/
  2026-06-11 1045 — Stack-rank scoring discussion.md   ← title = first line
  2026-06-10 0930 — Weekly sync.md                        of the LLM summary
```

File format (one file = the whole meeting, readable anywhere):

```markdown
# Stack-rank scoring discussion
> 2026-06-11 10:45–11:32 (47 min) · EN → KO · engine: Claude CLI ($0.31)

## Summary
- Stack-rank vs raw excitement scoring for feature voting
- Budget concern raised on contractor expansion

## Board
**Decisions** — Use stack rank, not raw excitement scores
**Action items** — Mike: share apps list · Me: budget memo by Fri
**Open questions** — Which MAU definition wins?

## Transcript
**Them** (10:45) — Pat, thanks a lot.
> Pat, 정말 고마워요.

**Me** (10:45) — I agree, but I'm a bit worried about the budget.
> 동의하지만 예산이 조금 걱정돼요.

📌 **Them** (10:46) — …treat it as a stack rank rather than a raw
excitement level.
> 단순 흥미도가 아니라 스택 랭킹으로 취급하자는 것.
```

Rules:
- **Markdown only at MVP** (pins carried over as 📌; low-confidence lines keep their `(?)`). A machine-readable JSONL sidecar (per-utterance timestamps, channel, confidence) is post-MVP, for users who want to pipe transcripts into other tools.
- **Local only, plain files** — no database, no sync, no telemetry. The folder is the product's memory; users can grep it, back it up, or point Obsidian at it.
- Settings: archive folder picker · auto-save on/off · optional retention ("delete files older than 90 days") for the privacy-cautious.
- Capsule/Strip modes archive identically — saving never depends on which window mode was visible.

Settings sheet (§8.7) gains one row:

```txt
│ ARCHIVE      ✓ auto-save transcripts                 │
│              folder [~/Documents/LiveCap ▾]          │
│              keep [forever ▾]                        │
```

### 8.10 Design workplan

| Phase | Deliverable |
|---|---|
| D0 | Token sheet + type scale in Figma; the five rules as a one-page design contract |
| D1 | Panel mode high-fi (states §8.3 included) — built directly against Tauri webview, not pixel-pushed in Figma forever |
| D2 | Strip + Capsule modes, snapping & click-through prototypes |
| D3 | Onboarding + Settings + menu bar; app icon |
| D4 | Motion pass (fade timings, live-summary shimmer) + dark-room/bright-room legibility QA over real video calls |

---

## 9. MVP Plan

| Phase | Deliverable | Gate |
|---|---|---|
| **0. Cost PoC (1 day)** | Persistent `claude -p` stream-json session translating a recorded meeting transcript; log cumulative `total_cost_usd`. | Measured cost ≤ ~$1/hr, latency ≤ 1.5 s/sentence. **This number is the product's premise — measure first.** |
| **1. Caption core (week 1)** | Meetily Rust core extracted: mic + system audio → live captions in a bare Tauri window. | Core separates cleanly from Meetily's Next.js frontend (the one unverified assumption — see Risks). |
| **2. Translation provider (week 2)** | Provider interface + CLI adapter (detection, env-strip, stream parser) + credit gauge. | End-to-end: speak English, see Korean, watch the gauge move. |
| **3. Local fallback (week 2–3)** | llama.cpp + Qwen3 4B tier, auto-download, auto-switch on pool exhaustion / no CLI. | Captions continue seamlessly when CLI tier is disabled mid-meeting. |
| **4. Product UI (week 3–4)** | Glass design system (§7), Panel + Strip + Capsule modes, two-channel display, summary strip, quick-translate box, session auto-save (§8.9, incremental writes). | Usable in a real meeting; passes the "share your screen, audience sees nothing" test; kill the app mid-meeting → transcript file is intact. |
| **5. Post-MVP** | Reply-suggestion chips, meeting board, Codex adapter, BYO key, Windows. | — |

---

## 10. Risks

1. **Anthropic tightens policy again.** Trajectory is restrictive (Jan OAuth block → June credit split). *Mitigation:* the local-LLM tier ships in the MVP, not later; the product must survive CLI mode being killed entirely.
2. **Meetily core coupling unknown.** Docs claim modularity; actual frontend coupling unverified until Phase 1. *Mitigation:* Phase 1 is scoped as a go/no-go spike; fallback is building capture directly on cpal + whisper-rs (more work, same stack).
3. **Cost estimate wrong.** If real usage is 5× the estimate, Pro-plan users get ~10 hrs/mo and the CLI tier stops being the default story. *Mitigation:* Phase 0 measures before any UI is built; batching depth and summary cadence are the tuning knobs.
4. **Translation queue lag in fast speech.** *Mitigation:* batching + newest-first discipline (§3); worst case, summary cadence drops before captions do.
5. **Translation quality of 4B fallback** is noticeably below Haiku. Acceptable: user said quality parity is not required; fallback exists for continuity, not excellence.
6. **Screen-capture exclusion is macOS-strong, Windows-weak.** `sharingType` is solid on macOS; Windows equivalents (`SetWindowDisplayAffinity`) interact unpredictably with some conferencing apps. *Mitigation:* macOS-first launch; treat Windows privacy parity as a launch gate for the Windows port, not a footnote.

---

## 11. Decisions Log

| # | Decision | Rationale |
|---|---|---|
| D1 | Tauri over Electron | Meetily core is Tauri; smaller binary; avoids Electron macOS loopback quirks |
| D2 | STT is always local (Whisper-class) | CLIs can't do streaming STT; privacy; latency |
| D3 | LLM over NMT for translation | Disfluency cleanup + context; NLLB license (CC-BY-NC) rules out the best NMT anyway |
| D4 | CLI tier = headless stream-json, **no PTY workaround** | Account risk + single-policy-update fragility; open-design's own pattern is plain `-p` |
| D5 | Model pinned to Haiku in CLI tier | 25× cheaper than Sonnet-class; translation doesn't need more |
| D6 | Local fallback ships in MVP | Policy-risk insurance is a launch feature, not a backlog item |
| D7 | English UI default; EN↔KO first pair | Per product owner |
| D8 | **Name: LiveCap, domain `livecap.app`** | Most intuitive candidate (zero-explanation); `.app` TLD reads as a sentence and maximizes guessability; both confirmed available 2026-06-11 |
| D9 | **Design concept: "Glass"** (§7) | The app lives beside a live meeting; chrome competes with humans; text-only hierarchy on translucent glass, single amber accent |
| D10 | Overlay excluded from screen capture | The strongest seamlessness guarantee; macOS-first because Windows parity is unreliable (Risk 6) |
| D11 | Auto-save sessions as local Markdown, written incrementally | Post-meeting utility with zero clicks; plain files (grep/Obsidian-friendly) over a database; crash-safe by construction |

**Open questions:** bundle Qwen weights vs first-run download · diarization in MVP or post-MVP · Strip mode click-through default on/off.

---

## 12. Build Judgment

**Verdict: build.** Difficulty is medium-low given the reuse plan: the historically hard 70% (simultaneous system-audio + mic capture, streaming STT) is a solved problem in MIT-licensed code (Meetily); the CLI integration pattern is fully documented in Apache-licensed code (open-design); the only genuinely new work is the translation provider layer and a small overlay UI. One person, ~3–4 weeks to a usable MVP, with the two real unknowns (Meetily core extraction, real-world CLI cost) deliberately front-loaded as Phase 0–1 gates.
