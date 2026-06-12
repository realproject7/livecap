# Manual verification

Automated checks (`cargo clippy -D warnings`, `cargo test`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `scripts/no-stub-gate.sh`) are green. The
items below need a human at a real screen.

Launch: `source ~/.cargo/env && pnpm install && pnpm tauri dev`
(first run compiles for a few minutes; the overlay appears as a centered
glass Panel; the LiveCap glyph appears in the menu bar; no Dock icon).

---

# #11 Caption feed + live pipeline E2E

Prerequisites on the test Mac:
- `claude` CLI installed and signed in (`claude login`, Pro/Max plan) — the
  host detects it on PATH (plus `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`).
- Node.js ≥ 20 on PATH (or `LIVECAP_NODE=/path/to/node`); the session host
  runs as a Node child process from `dist-host/main.mjs` (built by
  `pnpm build:host`, which `pnpm tauri dev` runs automatically).
- An English-speech video (e.g. any recorded talk) to play as system audio.
- First session start downloads the whisper `small` model (~500 MB) into
  `~/Library/Application Support/app.livecap.desktop/models/` — the summary
  strip shows status; give it a minute.
- macOS prompts for System Audio Recording (and Microphone) permission on
  first start — accept both.

## A. Live captions + translation latency (AC)

1. Menu bar → **Start Captioning** (or hover the Panel → ▶). The status
   strip walks "preparing the caption model…" → "starting the translation
   engine…" → live (amber dot, "Listening…"); the menu bar glyph turns amber
   and the tray item flips to "Stop Captioning".
2. Play the English video. Expect:
   - grey partial text streams in on the left (them), two tones down, with a
     blinking cursor;
   - on a sentence pause the block brightens to full tone, gains a timestamp
     and a `⋯` shimmer;
   - the Korean translation streams in under it (one tone down). Stopwatch
     check: first Korean characters must appear **< 1.5 s** after the
     sentence finalizes (display starts on the first streamed delta — it
     never waits for batch completion).
3. Speak into the mic → your caption appears right-aligned (me). Alignment
   is the only channel label.
4. Mumbled/overlapping audio → low-confidence captions render in the meta
   tone with a trailing `(?)`.

## B. Fast-speech backlog (AC)

1. Play the video at 1.5–2× speed for a few minutes.
2. Watch the gap between the newest caption and its translation: backlog
   merges into single newest-first batches, so the most recent sentence's
   translation stays **≤ 10 s** behind with no unbounded drift (older
   sentences may fill in afterwards — that is the design).

## C. Feed interactions

- Hover a caption block → ghost actions (📌 pin · ⧉ copy · ⟳ retranslate)
  fade in; copy puts "source\ntranslation" on the clipboard; retranslate
  re-queues the sentence (block returns to `⋯`, then updates — also fixed in
  the archive on the next rewrite).
- Pin a block → amber 📌 appears and a copy docks above the reply-chip row;
  unpin (✕ in the dock, or 📌 again) removes it. The pin carries into the
  archive transcript.
- Scroll up in the feed → auto-scroll pauses; a new caption raises the
  "↓ live" chip; one click snaps back. Appends never shift existing content
  (150 ms opacity fades only).
- Hover a translated block → original/translation brightness swaps (§8.2).

## D. Summary strip, extras, archive (AC)

1. After ~60 s of speech the summary strip (amber dot) fills with one line
   and refreshes on the cadence (backing off when nothing new is said).
2. Reply chips (✦ Suggest / 👍 Agree / ✋ Push back / ? Ask) → inline card
   with one suggested line + ⧉ Copy / ⟳ Another / ✕. Quick translate: type
   Korean in the input, Enter or ↑ → inline card with the English line.
   Copy-to-clipboard is the only output (never auto-sent anywhere).
3. Mid-session, in a terminal:
   `ls ~/Documents/LiveCap/ && cat ~/Documents/LiveCap/*recording*.md`
   → a `… — (recording).md` file exists and **grows incrementally** (re-cat
   after more speech: transcript lines appended; Summary/Board rewritten).
4. `kill -9` the livecap process (and the node session host) mid-meeting →
   the `(recording).md` file is intact and readable; a relaunch starts a new
   file (no overwrite).
5. Stop captioning (tray or ⏹) → status "saving the transcript…", then a
   toast "Saved — <file>"; the file is renamed to
   `YYYY-MM-DD HHMM — <first summary line>.md` with the §8.9 layout (header
   date/clock, EN → KO, engine, cost; Summary; Board; Transcript with
   Them/Me, `>` translation lines, 📌 pins, `(?)` markers).

## E. Engine switch + credit gauge

1. Devtools: `const { invoke } = window.__TAURI_INTERNALS__;
   await invoke("gauge_state")` → `{ poolUsd: 20, spentUsd, dollarsPerHour,
   estimatedHoursRemaining, … }`; spentUsd grows as turns complete
   (persisted at `…/app.livecap.desktop/credit-ledger.json`).
2. Forced-switch drill (no need to burn the pool): with the app stopped,
   write the ledger as nearly spent —
   ```sh
   K=$(date +%Y-%m)
   echo "{\"version\":1,\"periodKey\":\"$K\",\"spentUsd\":19.6,\"meteredMs\":3600000}" \
     > ~/Library/Application\ Support/app.livecap.desktop/credit-ledger.json
   ```
   At ~$19.6/hr rolling and $0.40 left, estimated hours remaining is under
   the 2 h threshold, so the session starts on the local tier: expect the
   one-line meta toast "switched to local (qwen3 4b) — captions continue"
   and, on first use, the Qwen3-4B (~2.5 GB) + llama-server downloads with
   progress statuses in the strip. A mid-session crossing behaves the same
   and is loss-free: the in-flight batch completes on the CLI (#7).
   Delete the ledger file afterwards to reset.
3. Pause (⏸) mid-session → captures stop (no new captions), the glyph
   reverts; ▶ resumes onto the same session and archive file.

## F. Silence auto-stop

Leave the session running with no audio for 10 minutes → a native dialog
asks "No speech detected for 10 minutes. Stop captioning and save the
transcript?" — "Stop & save" finalizes the archive; "Keep going" re-arms the
watchdog for another 10 minutes. (To test quickly, temporarily lower
`SILENCE_THRESHOLD_MS` in `src/host/silence.ts` and rerun
`pnpm build:host`.)

## G. Strip / Capsule

⌥⇧Space to Strip → the latest caption + translation render centered
(partial text in the partial tone); Capsule → one line with the live dot.
Both update from the same stream; sessions archive identically regardless
of the visible mode.

## Known limits for the reviewer (#11)

- ~~Languages are fixed this round~~ — closed by #12: the target language is
  a setting (KO default) and reaches the translation prompt, the
  summary/extras output, and the archive header.
- The session host needs a system Node.js in dev and in the bundled app
  (resolved from PATH/`LIVECAP_NODE`/Homebrew paths); bundling a runtime is
  a packaging follow-up.
- A webview reload mid-session (dev hot-reload) clears the on-screen feed;
  the session, translations, and archive continue unaffected.

---

# #12 Onboarding (3 steps) + Settings sheet

Automated coverage (already green): settings persistence + sanitization
(`cargo test -p livecap-app` — settings.rs), language plumbing through the
host protocol and gauge/router mapping (`pnpm test:app` —
test/start-config.test.ts, test/languages.test.ts), generic-source prompt
contract (engine prompt.test.ts). The flows below need a human, real TCC
sheets, and a real `claude` binary.

## A. Fresh-machine onboarding (<60 s, AC)

Reset this Mac to a "fresh" state:

```sh
tccutil reset Microphone app.livecap.desktop
tccutil reset All app.livecap.desktop   # also clears system-audio recording
rm ~/Library/Application\ Support/app.livecap.desktop/settings.json
```

1. Start a stopwatch, launch (`pnpm tauri dev`). The Panel opens on
   onboarding card **1 · AUDIO** ("LiveCap hears two things").
2. Click **Grant audio access** → the REAL macOS Microphone sheet appears
   (triggered by a transient capture, not a fake) and, on macOS 14.4+, the
   System Audio Recording sheet follows. Accept both → both rows gain an
   amber ✓ (mic via live AVCaptureDevice status polling; system audio via a
   tap probe). Deny instead → the row shows "✕ no access" plus
   "Open System Settings" (deep-links the right Privacy pane) and
   "Check again"; **Continue** still appears — never a dead end.
3. Card **2 · LANGUAGE**: "Translate into…" with 한국어 preselected; note
   says the spoken language is detected automatically. Continue.
4. Card **3 · ENGINE**: runs a real CLI probe (`--probe` host mode).
   With `claude` on PATH: "✓ Claude CLI found · …uses your plan's SDK
   credits — about **50 hrs/month**" (for the $20 default pool) and a
   "Use the local model instead — free, 2.4 GB download" link.
5. **Start captioning** → onboarding closes, a session starts, play English
   audio → first captions render. Stop the stopwatch: **< 60 s** from app
   open (record the time in the PR).
6. Relaunch → onboarding does NOT reappear
   (`settings.json` has `"onboardingComplete": true`).

## B. No-CLI path (AC)

1. With settings.json deleted again, launch with the CLI hidden:
   `PATH=/usr/bin:/bin LIVECAP_NODE=$(which node) pnpm tauri dev`
   (the host augments PATH with `~/.local/bin` etc., so on this Mac also
   temporarily `mv ~/.local/bin/claude{,.off}`).
2. Onboarding card 3 now LEADS with "Use the local model" (size + 
   download-on-first-use stated); the CLI is one meta line below
   ("No Claude CLI found — install and sign in…"). No dead end.
3. Start captioning → status strip shows the model download progress
   ("downloading local model NN%…"), then captions + translations work on
   the local tier. Restore the binary afterwards.

## C. Settings sheet (menu bar → Settings…)

Menu bar → **Settings…** → the Panel surfaces (switching mode to Panel if
needed) and the sheet opens INSIDE the Panel window on the same glass (no
separate window — deliberate, §8.7 "single sheet").

Apply-without-restart matrix — verify each row, no app relaunch anywhere:

| Change | Takes effect |
|---|---|
| Caption size Aa/Aa/Aa | immediately (live feed + strip/capsule re-scale) |
| Click-through (Strip/Capsule) | immediately (same toggle as the chrome button) |
| Engine segmented control | next session start (start/stop captioning to see "Local (Qwen3 4B)" in the archive header / no CLI spawn) |
| Translate into | next session start (new captions translate into the new language; summary follows) |
| Plan / custom pool, reset day | gauge re-renders immediately; the ledger period+pool apply at next session / next probe |
| Auto-switch toggle | next session start (drill below) |
| Archive auto-save off | next session writes NO `(recording).md` |
| Archive folder (native picker) | next session writes there |
| Retention | swept at next session start (backdate a file: `touch -t 202401010101 ~/Documents/LiveCap/old.md`, pick "keep 90 days", start a session → file deleted) |

Checks while the sheet is open:

1. Credit gauge: before any session it fills from a host `--probe` (real
   ledger read): `$0.00 / $20.00`, "≈ 50 meeting-hours left · resets <next
   reset day>". During a live CLI session the bar/amounts tick live from
   `host://event` gauge messages (monospaced digits).
2. Plan picker: Pro $20 / Max 5x $100 / Max 20x $200 / Custom… (custom
   reveals a USD field); reset-day field clamps to 1–28 (try 99 → saved as
   28; check `settings.json`).
3. Auto-switch OFF drill: write the ledger as nearly spent (see #11 §E),
   start a session → a "switch to local" recommendation is NOT acted on;
   captions stay on the CLI. ON: switches as in #11 §E.
4. Privacy rows: "Hidden from screen sharing" shows ✓ only if the live
   `capture_excluded` readback is true (flip `set_content_protected` in a
   scratch build to see ✕); "Audio never leaves this Mac" is informational.
5. Hotkeys row matches ⌥Space / ⌥⇧Space.
6. Persistence is atomic: `cat ~/Library/Application\ Support/app.livecap.desktop/settings.json`
   after each change; kill -9 the app right after a change → file is valid
   JSON (temp+rename write).

## D. Language plumbing E2E (goal 4)

1. Settings → Translate into **English**… actually pick a non-default, e.g.
   日本語. Start a session, play English audio →
   captions translate into Japanese; the summary strip fills in Japanese.
2. Stop → archive header reads `EN → JA` and the engine line; transcript
   `>` lines are Japanese. (KO and EN are the supported minimum; the picker
   list rides arbitrary BCP-47 through the same path.)

## Known limits for the reviewer (#12)

- Engine/language/pool/auto-switch/archive changes apply from the NEXT
  session (a running meeting keeps its engine and language; switching
  engines mid-meeting remains the #7 auto-fallback path). No app restart is
  ever needed.
- System-audio permission has no public macOS status API: its "status" is a
  real tap probe, so onboarding's first probe IS what raises the TCC sheet;
  "Check again" re-probes after the System Settings toggle.
- The pool reset day is evaluated in UTC (ledger semantics, #7) — the
  Settings copy names the day, not a local-midnight promise.
- The archive header's source label stays "EN" (meeting language; replies
  and quick translate also output English) — per-sentence caption language
  remains auto-detected regardless.
- Onboarding shows the three §8.6 cards sequentially inside the Panel
  (design 06 paints them side by side as a storyboard; the Panel is one
  card wide).

---

# #10 Glass window shell (previous round — still applies)

## 1. Screen-capture exclusion (EPIC launch gate)

1. With the overlay visible, open devtools (dev build: right-click the
   glass → Inspect Element) and run in the console:
   ```js
   const { invoke } = window.__TAURI_INTERNALS__;
   await invoke("capture_excluded")          // → must be true
   await invoke("shell_diagnostics")         // → { captureExcluded: true, joinsAllSpacesAndFullscreen: true }
   ```
2. `screencapture -x /tmp/s.png && open /tmp/s.png` → overlay absent.
3. Real share: start a Zoom/Meet screen share, view from a second
   participant → overlay NOT visible on the receiving end (screenshot the
   receiver for the PR matrix). Overlay still visible locally.

## 2. Always-on-top + Spaces/fullscreen

- Put Safari (or any app) fullscreen → press ⌥Space twice (hide/show) →
  overlay floats above the fullscreen app.
- Switch Spaces (ctrl-←/→) → overlay follows to every Space.

## 3. Modes, hotkeys, persistence

- ⌥⇧Space cycles Panel (520×640) → Strip (720×88, docks bottom-center
  first time) → Capsule (420×44 pill, top-right first time).
- Menu bar → Mode submenu shows a check on the active mode; selecting one
  switches; menu "Show/Hide LiveCap" and ⌥Space toggle visibility.
- Move/resize the Panel, switch to Strip, move it, quit (menu bar → Quit
  LiveCap), relaunch → last mode AND each mode's position/size restored
  (per display; config at
  `~/Library/Application Support/app.livecap.desktop/shell-state.json`).
- Clicking the Capsule (click, not drag) opens the Panel (§8.1).

## 4. Edge snapping

- Drag the window (press and drag anywhere on the glass) slowly toward any
  screen edge/corner → it magnetically snaps ~18px out, leaving a 12px gap,
  WHILE dragging (not on release). Center-x snap works for the Strip's
  bottom-center dock.

## 5. Chrome fade (rules 1 & 4)

- Move the mouse over the window → control row fades in (150ms opacity);
  stop moving 3s → fades out. No slides/bounces anywhere.
- Pause/Stop buttons are disabled with tooltip "Captioning is not available
  yet" (they read the `capabilities` command; #11 flips `captioning`).

## 6. Click-through (Strip/Capsule)

- Switch to Strip, hover to show chrome, click the cursor-arrow button
  (click-through toggle) → clicks in the middle of the strip now reach the
  app underneath.
- Hover within ~16px of any strip edge → interactivity returns and the
  chrome fades in; click the toggle again to turn click-through off.
- The toggle is hidden in Panel mode; Panel is always interactive.

## 7. Menu bar live state

- Default: monochrome template glyph (adapts to menu bar appearance).
- In devtools: `await invoke("set_live", { live: true })` → glyph dot turns
  amber; `{ live: false }` reverts. (#11 will call this from the pipeline.)

## Known limits for the reviewer

- Display keys are Tauri monitor names ("Monitor #<id>"); if macOS
  re-enumerates IDs after dock/undock, that display starts from defaults.
- Global hotkey conflicts (e.g. another app owning ⌥Space) are logged to
  stderr at launch instead of failing startup.
- Menu item accelerator labels are display hints; the working bindings are
  the global shortcuts.

## #54 — running the app for verification (READ FIRST)
- `cargo run -p livecap-app` (debug) loads **devUrl (http://localhost:1420)** — it requires `pnpm dev` running from THE SAME checkout. A dead or different-checkout vite on 1420 = blank webview. This was #54's entire mystery.
- Headless verification: prefer the bundled app (`pnpm tauri build --debug --bundles app`, run the binary inside) — it embeds `dist/` and needs no server.
- UI render state is externally observable: `~/Library/Application Support/app.livecap.desktop/ui-heartbeat.json` (1 Hz from the webview; `bootError` carries any module-evaluation failure). `LIVECAP_UI_PROBE=1` adds a Rust-side eval probe that reports page state even if the app module never ran. `LIVECAP_CAPTURE_VISIBLE=1` disables capture exclusion (dev only) for screenshot-based checks.
