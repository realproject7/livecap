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

- Languages are fixed this round (EN captions → KO translations; extras in
  English) — the language pickers land with Settings (#12).
- The session host needs a system Node.js in dev and in the bundled app
  (resolved from PATH/`LIVECAP_NODE`/Homebrew paths); bundling a runtime is
  a packaging follow-up.
- A webview reload mid-session (dev hot-reload) clears the on-screen feed;
  the session, translations, and archive continue unaffected.

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
