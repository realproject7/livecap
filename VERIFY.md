# Manual verification

Automated checks (`cargo clippy -D warnings`, `cargo test`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `scripts/no-stub-gate.sh`) are green. The
items below need a human at a real screen.

Launch: `source ~/.cargo/env && pnpm install && pnpm tauri dev`
(first run compiles for a few minutes; the overlay appears as a centered
glass Panel; the LiveCap glyph appears in the menu bar; no Dock icon).

---

# 0. Dev-verify loop (#108): dev-flags.json + dev-sign.sh

The old loop (inject `LSEnvironment` into Info.plist with PlistBuddy →
`codesign --force --deep --sign -` → `lsregister -f`) is retired: ad-hoc
re-signing changed the cdhash every build, which reset ALL TCC grants and
cost one operator SecurityAgent click per iteration. The new loop:

## Dev flags — no plist edit, no re-sign

Debug builds (`#[cfg(debug_assertions)]` — `pnpm tauri dev` or
`pnpm tauri build --debug`) also read
`~/Library/Application Support/app.livecap.desktop/dev-flags.json`:

```json
{ "captureVisible": true, "autostart": true }
```

- `captureVisible` — overlay stays visible to screen capture (both the Tauri
  content-protection layer and the NSWindow sharingType exclusion are
  skipped), so screenshot-based checks can see it.
- `autostart` — a captioning session starts at launch, no UI click.
- Both fields optional; missing or malformed file = all flags off.
- The env vars still win when set: `LIVECAP_CAPTURE_VISIBLE` /
  `LIVECAP_AUTOSTART` override the file (`1` = on, anything else = off);
  only an UNSET env var falls through to the file.
- Release builds compile the file-reading code out entirely
  (`src-tauri/src/dev_flags.rs`) — the file is ignored there by
  construction.

Write the file once, then plain `open .../LiveCap.app` picks the flags up on
every launch. Delete the file (or the field) to restore production behavior.

## Stable signing — TCC grants persist across rebuilds

Sign each debug bundle with the stable self-signed "LiveCap Dev" identity
instead of ad-hoc:

```sh
scripts/dev-sign.sh   # default: target/debug/bundle/macos/LiveCap.app
```

First run creates the identity in the login keychain (openssl self-signed
cert with the codeSigning EKU + `security import` + `security
add-trusted-cert`; expect ONE GUI password prompt for the trust step and one
"Always Allow" on first key use — both one-time; the script prints manual
Keychain Access steps if automated creation fails). Every run signs the
bundle and refreshes LaunchServices. Because the identity is stable, mic +
system-audio TCC grants survive rebuilds: grant once, then zero permission
prompts on subsequent `dev-sign.sh` + `open` iterations. Always launch via
`open` (direct-binary launch attributes TCC to the terminal).

Per-rebuild loop: `pnpm tauri build --debug` → `scripts/dev-sign.sh` →
`open target/debug/bundle/macos/LiveCap.app`.

---

# Session dashboard (#90, this round)

A dashboard browses past sessions saved in `~/Documents/LiveCap` (or the
Settings archive folder). It opens as an opaque overlay inside the Panel (like
Settings), with an overview + history list and a per-session detail view.
There are saved sessions on this Mac from prior test runs, so it renders with
real data.

## 1. Both entry points open the dashboard

1. On the idle **Start** screen, a "View past sessions" button sits under the
   "Start captioning" CTA. Click it → the dashboard overlay covers the Panel.
2. Close it (✕ top-right) → back to the Start screen.
3. Menu-bar tray → **Dashboard…** (just above "Settings…"). It surfaces the
   Panel and opens the same overlay — works even with no active session and
   from Strip/Capsule mode (it switches to Panel first).

## 2. Overview: stats + history

1. The top shows stat cards: **Sessions**, **Captioned time**, **Avg talk
   ratio**, **Avg Smooth Score**, **Total cost**. Values are non-empty and
   finite (no `NaN`); cost shows "—" if no cost was recorded.
2. Below, a **History** list: one row per saved session, newest first, each
   with the title and a "date · duration · EN → KO" subtitle. The in-progress
   "(recording)" working file is excluded.

## 3. Detail: transcript + review + coaching

1. Click a history row → the header swaps to the session title with a back (‹)
   button. Click back → returns to the overview.
2. The detail shows: a meta line; **Talk ratio / Smooth Score** metrics + bar
   (only if that session recorded metrics); **Summary** bullets; **Board**
   (Decisions / Action items / Open questions, or "—"); **Coaching** — the
   list of your own ("Me") utterances; and the full **Transcript** (every line:
   speaker + time + source, with the translation underneath, "(?)" on
   low-confidence lines).
3. Pick a long session → the body scrolls; the header stays fixed.

## 4. Empty state

If you point the archive folder (Settings) at an empty directory and reopen the
dashboard, it shows "No sessions yet" instead of stats/list.

---

# Pin-on-top toggle (this round)

The overlay is no longer hardwired always-on-top. A 📌 pin button in the chrome
row (and a "Pin on top" tray check item) toggles it live; the choice persists.
Default is **ON** (pinned), matching the historical behavior.

## 1. The pin button is discoverable

1. Hover the glass → the chrome row fades in (auto-hides ~3 s after the cursor
   stops). Buttons are the enlarged 26 px size with a hover fill and a `title`
   tooltip on each (pin, click-through, mode, hide ✕).
2. The 📌 pin button sits just left of the click-through/mode/✕ cluster. Default
   state is **pressed/amber** (tinted fill + amber glyph), tooltip "Pinned on
   top — floats over every Space; click to unpin". The ✕ (hide) button is in the
   same row — no traffic-lights (frameless by design, unchanged).

## 2. Pinned (default ON) — floats over everything

1. Confirm the pin button is amber/pressed. Put Safari (or any app) fullscreen →
   the overlay floats above it. Switch Spaces (ctrl-←/→) → the overlay follows
   to every Space.
2. Devtools console (dev build: right-click glass → Inspect Element):
   ```js
   const { invoke } = window.__TAURI_INTERNALS__;
   await invoke("get_shell_state")     // → { ..., pinned: true }
   await invoke("shell_diagnostics")   // → { ..., joinsAllSpacesAndFullscreen: true, pinned: true }
   ```

## 3. Unpinned — normal window

1. Click the 📌 button (or tray → uncheck "Pin on top"). It dims to the normal
   (un-pressed) state; tooltip becomes "Unpinned — behaves like a normal
   window…". **No relaunch.**
2. Click another app (e.g. Finder) so it comes forward → the overlay now goes
   **behind** it (it did not before). Switch to another Space → the overlay does
   **not** follow (single-Space).
3. Console:
   ```js
   await invoke("get_shell_state")     // → { ..., pinned: false }
   await invoke("shell_diagnostics")   // → { ..., joinsAllSpacesAndFullscreen: false, pinned: false }
   ```
4. It is still frameless glass, still movable by dragging the body, still
   hideable (✕ / ⌥Space).

## 4. Live toggle both ways + tray mirror

- Toggle pin from the 📌 button → the tray "Pin on top" check mark updates to
  match (and vice-versa: toggling from the tray updates the button). Each flip
  takes effect immediately, no relaunch.

## 5. Persistence across restart

- Unpin, quit (menu bar → Quit LiveCap), relaunch → the overlay comes back
  **unpinned** (normal window, not on all Spaces; button un-pressed; tray
  unchecked). Re-pin, restart → comes back pinned. State lives in
  `~/Library/Application Support/app.livecap.desktop/shell-state.json`
  (`"pinned": true|false`); a state file written before this field existed
  defaults to pinned.

## 6. No regressions

- Capture exclusion is independent of pin: `await invoke("capture_excluded")`
  stays `true` in both pin states (prod). `LIVECAP_CAPTURE_VISIBLE=1` is still
  the only dev escape hatch.
- Click-through, modes, edge snapping, drag threshold, and per-session language
  are unchanged by toggling pin.

### Headless self-check (no live rig)

```
pnpm build && pnpm tauri build --debug --bundles app
rm -f ~/Library/Application\ Support/app.livecap.desktop/{ui-heartbeat.json,shell-state.json}
LIVECAP_CAPTURE_VISIBLE=1 ./target/debug/bundle/macos/LiveCap.app/Contents/MacOS/livecap-app &
sleep 5; cat ~/Library/Application\ Support/app.livecap.desktop/ui-heartbeat.json   # bootError:null, mode:panel
pkill -TERM -f livecap-app; sleep 2
grep pinned ~/Library/Application\ Support/app.livecap.desktop/shell-state.json     # → "pinned": true
```
The pin/unpin window behavior itself (floats-over vs. goes-behind, all-Spaces vs.
single-Space) needs the **live rig** — sections 2–4 above.

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

## 2. Always-on-top + Spaces/fullscreen (now pin-gated)

This behavior is now controlled by the pin toggle (see "Pin-on-top toggle"
above) and applies **while pinned** (the default):
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

# #53 Per-channel capture toggles + mic on/off

Automated coverage (green): settings sanitization keeps at least one channel
(`cargo test -p livecap-app` — settings.rs), channel-note plumbing
(`pnpm test:app` — start-config.test.ts), header rendering
(`pnpm -r test` — archive writer.golden.test.ts).

1. Settings → **Channels**: uncheck "Capture microphone" → the system-audio
   toggle locks (the last enabled channel can never be unchecked); persisted
   immediately (`captureMic: false` in
   `~/Library/Application Support/app.livecap.desktop/settings.json`).
2. Start a session with mic off → status line "microphone is off —
   captioning system audio only"; speaking into the mic produces NO right-
   aligned (me) captions while a playing video still captions (them).
3. Stop the session → the archive header meta line ends with
   `· system audio only`. With both channels on, no note is appended.
4. Mic toggle mid-session (both channels on): hover the panel chrome → the
   mic button (between ⏹ and the spacer) shows the mic icon. Click it →
   icon gains a slash, tray "Microphone" check mark clears, and speech into
   the mic no longer captions; system audio continues uninterrupted. Click
   again → mic captions resume on the SAME session/archive.
5. Tray mirror: menu bar → "Microphone" toggles the same state (enabled only
   while a session is running); the panel button stays in sync both ways.
6. Mic-only guard: with system audio off in Settings and a session running,
   the mic toggle refuses ("the microphone is the only active channel —
   pause the session instead") — a session always keeps one channel.
7. The toggle is capture-level (pause/resume of the mic stream): trailing
   speech finalizes when muting (VAD flush), nothing is recorded while off.

# #57 Feed windowing (DOM cap)

Automated coverage (green): eviction order, pin immunity, cap under 1000
synthetic captions (`pnpm test:app` — feed-state.test.ts, FEED_WINDOW=200).

1. Long session (or feed many short sentences): once more than 200 caption
   blocks have arrived, the DOM stays capped — check
   `~/Library/Application Support/app.livecap.desktop/ui-heartbeat.json`:
   `domBlocks` ≤ 200 (+ pinned overflow) while `feedBlocks` tracks the same
   windowed model; the archive keeps every line regardless.
2. Scroll to the very top of the feed after eviction started → a one-line
   meta notice "older captions are in the archive" sits above the oldest
   rendered block.
3. Pinned blocks are never evicted: pin an early block, let 200+ more
   arrive → the pinned block is still rendered (and in the pinned dock).
4. Memory: RSS growth from caption DOM flattens (#57's Rust-side
   heap-profiling half remains open — RSS may still grow from audio/whisper
   buffers; that is not this fix's scope).

## Known limits for the reviewer (#53/#57)

- The archive header note reflects the channel config AT SESSION START; a
  mid-session mic toggle does not rewrite the header (the transcript itself
  shows the absence of "Me" lines).
- The panel mic button and tray item act on the running session only; while
  idle, channel choice lives in Settings → Channels.
- `feedBlocks` in the heartbeat now reports the windowed model size (it can
  no longer exceed the window + pinned overflow); `domBlocks` is the
  DOM-level count used for cap verification.

## #54 — running the app for verification (READ FIRST)
- `cargo run -p livecap-app` (debug) loads **devUrl (http://localhost:1420)** — it requires `pnpm dev` running from THE SAME checkout. A dead or different-checkout vite on 1420 = blank webview. This was #54's entire mystery.
- Headless verification: prefer the bundled app (`pnpm tauri build --debug --bundles app`, run the binary inside) — it embeds `dist/` and needs no server.
- UI render state is externally observable: `~/Library/Application Support/app.livecap.desktop/ui-heartbeat.json` (from the webview; `bootError` carries any module-evaluation failure). The persisted file carries only liveness/wedge fields — `ts`, `mode`, `feedBlocks`, `domBlocks`, `capsuleActive` (a content-free bool: is the capsule showing a line), `bootError` — and **deliberately omits ALL caption text** (`latestSource`, `latestTranslation`, and the capsule line itself, #147): caption content is never persisted outside the user's archive. Caption text (including the capsule line) remains only in the in-memory beat served by `ui_snapshot`. Cadence is ~1 Hz while the webview is visible and throttles to ~4 s while hidden — note the 5-second disk-mirror gate means the file on disk updates only ~every 20 s while hidden, so an external staleness watchdog should use a threshold above that (hidden is a normal state — the close button hides, not quits). `LIVECAP_UI_PROBE=1` adds a Rust-side eval probe that reports page state even if the app module never ran. `LIVECAP_CAPTURE_VISIBLE=1` disables capture exclusion (dev only) for screenshot-based checks.

---

# v1.1 Meeting intelligence UI (#80 targeted analysis · #81 review screen · #82 coaching)

Automated coverage (already green, run from this checkout):
- Rust bridge duration plumbing — `cargo test -p livecap-app bridge`
  (durationMs = end_ms − start_ms, saturating on an inverted span; carried on
  both the `caption://event` finalized variant and the host `caption` message).
- Host → metrics record mapping — `pnpm exec vitest run test/metrics-records`
  ("me"→"mic"/"them"→"system", durationMs/text/lowConfidence carried; fed
  through `computeMeetingMetrics` so the talk ratio reflects the mic/system
  split).
- Mic-utterance list — `pnpm exec vitest run test/feed-state` (the
  `micUtterances (#82)` block: only finalized "me" blocks, oldest first; never
  "them" lines; live partials excluded).
- Archive metrics rendering — `pnpm --filter @livecap/archive test`
  (golden file now carries the `## Metrics` section: Talk ratio + Smooth Score).

Headless smoke (no audio): build + run the bundled app and confirm the webview
module evaluated with all the new top-level wiring (review surface, analysis
cards, host-event routing):
```sh
pnpm build && pnpm tauri build --debug --bundles app
rm -f ~/Library/Application\ Support/app.livecap.desktop/ui-heartbeat.json
LIVECAP_UI_PROBE=1 ./target/debug/bundle/macos/LiveCap.app/Contents/MacOS/livecap-app &
sleep 3; cat ~/Library/Application\ Support/app.livecap.desktop/ui-heartbeat.json
```
Expect a ticking heartbeat with `"bootError": null` (a parse/eval error in any of
src/main.ts, src/review.ts would surface here). Then `pkill -f livecap-app`.

The live E2E below needs a real video with audio and the operator's mic.

## #80 — targeted analysis (click a caption → strategy + reply)

1. Start a session; play a video where someone asks a question. Wait for that
   caption to finalize in the feed.
2. Hover the caption block → a **✦** ghost button appears beside the existing
   📌 / ⧉ / ⟳ actions (mic-side `Me` blocks too). Click it.
3. An inline card appears under the feed: the clicked line (italic), a
   **Strategy** section (in your target language, e.g. Korean) and a
   **Suggested reply** section (in the meeting language, English), each "…"
   until the model responds (~1–3 s).
4. **⧉ Copy reply** copies only the reply text; **⟳ Regenerate** re-fires for
   the same caption; **✕** dismisses the card.
5. No auto-fire: watch the credit gauge (`invoke("gauge_state")`) — it stays
   flat until you click ✦, then moves once per analysis. The reply is never
   auto-sent anywhere (copy-to-clipboard only).

## #81 — post-meeting review screen (+ metrics)

1. Run a session where BOTH sides speak (you on the mic, the video as system),
   long enough for at least one summary to generate (~60 s). Stop (⏹) — or let
   the 10-min silence dialog finalize it (same trigger).
2. On stop the Panel shows the **review surface** (over the live feed): a
   **Review** tab with two big numbers — **Talk ratio (me)** (a %) and
   **Smooth Score** (0–100) — plus a talk-ratio bar, the **Summary** list and
   the **Board** (Decisions / Action items / Open questions) already generated
   live. The talk ratio should match the actual mic-vs-system speaking split.
3. **⧉ Copy summary** copies the summary lines; **Open saved file** copies the
   archive path (open it in Finder/editor).
4. Confirm the saved `.md` carries the same metrics: it now has a `## Metrics`
   section with `**Talk ratio (me)** — N%` and `**Smooth Score** — N` between
   the Board and the Transcript:
   `cat ~/Documents/LiveCap/"<YYYY-MM-DD HHMM> — <title>.md"`.
5. Starting a new session dismisses the review surface (back to the live feed).

## #82 — speech-coaching tab (+ TTS)

1. After the session above (where YOU spoke), the review surface's **Coaching**
   tab lists your OWN utterances only — each row a clock time + the line. The
   count reads "N of your utterances" (or "You didn't speak in this session").
   Verify NO system ("them") lines ever appear here (privacy + correctness).
2. Click one disfluent row (e.g. one with "um"/restarts) → a coaching card
   appears: the original (struck through), a **Better** native rewrite with the
   changed spans highlighted green, and an explanation in your target language.
3. **▶** on the card speaks the `better` sentence aloud via the webview Web
   Speech API (English voice, by meeting language) — no macOS `say`, no audio
   files. (If no English voice is installed the call no-ops silently.)
4. **Review all** coaches every listed utterance in one batch (progress line
   "Coaching N utterances…", then all items); the gauge moves once for the
   batch. Degenerate one-word lines (e.g. "Yeah") return unchanged with no
   model spend (engine #79 short-circuit).
5. On-demand only: the gauge stays flat until you click a row or Review all.

## Known limits for the reviewer (#80/#81/#82)
- The coaching list and the analysis target are sourced from the live windowed
  feed (#57, newest ~200 blocks). Utterances evicted from the window during a
  very long meeting are not individually clickable for analysis/coaching,
  though they remain in the archive. The metrics (#81) are computed by the host
  over the FULL session (all finalized captions), not the windowed feed.
- TTS uses whatever WKWebView/system voices are installed for the meeting
  language; an unavailable voice degrades to the default voice or no-ops.

---

# v1.1.x UX fixes (explicit start · per-session language · windowing · credit copy)

Automated coverage (already green, run from this checkout):
- Session lifecycle state machine — `cargo test -p livecap-app session`
  (`the_default_lifecycle_phase_is_idle`, `explicit_start_gate_only_admits_an_idle_session`,
  `stop_gate_only_admits_a_running_session`, plus the existing `try_begin_live`
  / phase round-trip tests).
- Per-session language persistence — `pnpm exec vitest run test/session-language`
  (`nextSettingsForSessionLanguage`: a new pick is persisted as the next
  default, an unchanged pick is a no-op, tags are normalized like the Rust
  sanitizer, empty picks are ignored, arbitrary BCP-47 rides through).
- Settings round-trip incl. `targetLanguage` — `cargo test -p livecap-app settings`.

Headless smoke (no audio), confirms idle-on-launch + clean module eval:
```sh
pnpm build && pnpm tauri build --debug --bundles app
rm -f ~/Library/Application\ Support/app.livecap.desktop/ui-heartbeat.json
LIVECAP_CAPTURE_VISIBLE=1 ./target/debug/bundle/macos/LiveCap.app/Contents/MacOS/livecap-app &
sleep 4
cat ~/Library/Application\ Support/app.livecap.desktop/ui-heartbeat.json   # bootError:null, mode:panel
pgrep -f dist-host/main.mjs || echo "idle: NO session host spawned"        # must print the idle line
pkill -f livecap-app
```
Expect a ticking heartbeat with `"bootError": null` AND **no** session host
process — i.e. the app launched idle and did not auto-start a session.

The live items below need the real rig (screen, mouse, mic).

## 1. Explicit session start (no auto-start)

1. Launch (onboarding already done) → the Panel opens on the **Start screen**:
   a `LiveCap` mark, a "Translate into" picker, a prominent amber **Start
   captioning** button, and "Nothing is captured until you start." The live
   feed / chips / composer are NOT shown; the menu-bar glyph is monochrome (not
   amber); the tray item reads **Start Captioning**.
2. Confirm NO captions and NO mic/system prompts appear before you press Start
   (and the headless check above shows no session host running).
3. Press **Start captioning** (or the tray **Start Captioning**, or ▶ in the
   chrome) → the session starts exactly as before (status walks
   "preparing…" → "starting…" → live; glyph turns amber; tray flips to **Stop
   Captioning**).
4. **Stop** (⏹ / tray) → returns to the Start screen (idle), glyph reverts.
   The post-meeting review still appears first; closing it lands on the Start
   screen.
5. Dev aid only: `LIVECAP_AUTOSTART=1 pnpm tauri dev` still auto-starts (it is
   the headless-E2E shortcut, never the normal path).

## 2. Per-session target language

1. On the Start screen the picker defaults to the **last-used** target (the one
   onboarding seeded on first run; afterwards, whatever you last started with).
2. Change it (e.g. 한국어 → 日本語) and press Start → the session translates into
   the new language (captions + summary); the archive header reads e.g.
   `EN → JA`. You did NOT open Settings to do this.
3. Stop, then start again → the picker now defaults to **日本語** (the last pick
   was remembered). Confirm `settings.json` `targetLanguage` updated to `ja`.
4. Settings → "Translate into" still exposes a default and stays in sync, but
   the per-session picker at Start is the authoritative choice for that session
   (it is not a global the session ignores).

## 3. Windowing: native dropdowns, moving, hiding

1. **Dropdown on mouse-move (the regression):** on the Start screen click the
   "Translate into" picker → the native macOS popup opens. **Move the cursor
   over the options and to a different option** → the popup stays open and
   tracks the cursor normally; pick one → it commits. Repeat inside Settings →
   the "Translate into" / Plan / Retention selects all behave the same. (Before:
   the popup closed/glitched the instant the cursor moved.)
2. **Move:** press-drag from a non-control area (the top chrome/title region, or
   the summary strip while live) → the window follows the cursor and still
   magnet-snaps at edges. A press-drag that *starts* on a button/select/input/
   feed never moves the window (those controls work normally); a plain click on
   a control never begins a drag.
3. **Hide/show:** ⌥Space hides the overlay and ⌥Space shows it again; the ✕
   chrome button hides it too. No glitching, and capture exclusion is unchanged.
4. **Always-on-top intact:** with the overlay visible,
   `await invoke("shell_diagnostics")` → `{ captureExcluded: true,
   joinsAllSpacesAndFullscreen: true }` (production, i.e. WITHOUT
   `LIVECAP_CAPTURE_VISIBLE=1`); the overlay still floats over a fullscreen app
   and follows across Spaces (#10 §2 still passes). `LIVECAP_CAPTURE_VISIBLE=1`
   remains dev-only and disables exclusion for screenshot checks.

Root cause (for the reviewer): the drag handler started a Rust drag + took
`setPointerCapture` on `pointerdown` for any target not matching
`button, input` — which **excluded `<select>`**. Clicking the language picker
therefore captured the OS pointer stream and ran the cursor-following drag loop,
so the native popup (a separate NSWindow) lost its pointer events and closed the
moment the cursor moved. Fix: the drag now excludes every form control +
interactive container and only captures the pointer *after* movement passes a
threshold (a plain control click never captures). `NSStatusWindowLevel` (25) is
below `NSPopUpMenuWindowLevel`, so popups already render above the overlay — the
level was not the cause and is unchanged.

## 4. Calmer credit messaging

1. Onboarding card 3 with `claude` on PATH now reads "✓ Claude CLI found ·
   Signed in on your plan — covered by your Claude subscription. If Anthropic's
   policy changes, LiveCap falls back to the free local model automatically." —
   NO "uses your plan's SDK credits / ~N hrs/month".
2. Settings → Engine: a calm note ("…currently covered by your Claude
   subscription…fall back to the free local model automatically"), the gauge is
   labeled **Usage this month** with meta "Tracked in case credits ever apply ·
   would reset <day>" (not "≈ N meeting-hours left"), and the auto-switch
   checkbox reads "Fall back to Local if credits ever start to apply".
3. The local-fallback safety message is retained throughout; README + PROPOSAL
   §4/§6/§8.7 carry the same reframing (factual policy note kept, app no longer
   presents active charging).

## Known limits for the reviewer (UX fixes)
- The Start screen owns the Panel only while idle; in Strip/Capsule modes the
  idle status line ("Start captioning from the menu bar, or press ▶ above.")
  carries the same explicit-start cue.
- The per-session picker writes the chosen language to `settings.json` before
  starting, so it doubles as the persisted default; a session already running
  keeps its language (engine/language changes apply from the next start, per #12).

---

# #114 Persisted coaching (save on generate + Dashboard rendering)

Automated coverage (already green, run from this checkout):
- Caption id → `(timestamp · occurrence)` amend-key mapping —
  `pnpm exec vitest run test/coaching-keys` (duplicate clock labels, interleaved
  "them" entries, partial batches).
- Review tab save-failure status — `pnpm exec vitest run test/review-coaching`
  (`a save failure (#114) still renders the rewrites, plus a one-line status`).
- Dashboard rendering of persisted rewrites — `pnpm exec vitest run
  test/dashboard-coaching` (coached entry → before/better/highlight/explanation;
  coaching-free session → before-only rows).

## A. Save on generate → Dashboard renders the rewrite (AC)

1. Run a short session where YOU speak a few disfluent lines (e.g. "I goed to
   the store", "so um I think we should ship"), then stop it.
2. In the review's **Coaching** tab, coach one row (or Review all). The cards
   render as before; no new status line appears.
3. Open the saved session file (Review → "Open saved file" copies the path):
   it now ends with a `## Coaching` section — one `### (HH:MM · k) — <line>`
   block per coached utterance with **Better** / **Changes** / **Explanation**.
   Every other section is byte-identical to before the amend.
4. Menu bar → Dashboard → open that session: the Coaching section shows the
   coached utterance as before (struck through) → **Better** with the changed
   spans highlighted green + the explanation — same look as the review tab, no
   ▶ play button. Utterances you did NOT coach stay plain before-only rows.
5. Re-coach the SAME utterance in the review tab (click its row again): the
   file's block for that `(HH:MM · k)` key is overwritten (last write wins),
   not duplicated.

## B. Save-failure path (AC, review-pass amendment)

1. Run a session as above, stop it, but BEFORE generating coaching make the
   saved file read-only: `chmod 444 ~/Documents/LiveCap/<the new file>.md`
   (or whatever archive folder Settings points at).
2. Coach a row: the rewrites still render normally on the card, and the card's
   status line reads exactly "couldn't save coaching to the session file".
   No retry happens (single attempt), the app does not crash.
3. Console/host stderr: the failure log is content-free (an fs error class +
   message only — no caption or rewrite text).
4. `chmod 644` the file, coach another row → this one saves; the Dashboard
   shows the second utterance coached, the first still before-only.

## C. Backward compatibility

1. Open the Dashboard on sessions saved before this change (no `## Coaching`
   section): the Coaching section renders exactly as today (before-only rows),
   and the file on disk is untouched by merely viewing it.
2. Sessions with archive auto-save OFF: coaching in the review tab works and
   shows NO save-status line (there is no file; nothing to save is not a
   failure).

## Known limits for the reviewer (#114)
- Coaching persists only for utterances that made it into the archive (an
  utterance whose archive append failed mid-session has no entry to amend and
  is silently skipped — the card still shows its rewrite).
- Retroactive coaching from the Dashboard stays out of scope (review-tab-only,
  per the ticket).

---

# #110 Whisper model selection (small / medium / large-v3-turbo)

Automated coverage (already green, run from this checkout):
- Rust setting: serde default / camelCase round-trip / sanitize —
  `cargo test -p livecap-app settings` (missing `sttModel` → "small"; unknown
  or non-curated values clamp back to "small").
- TS mirror default handling — `pnpm exec vitest run test/stt-model`.
- Pipeline plumbing + floor families — `cargo test -p livecap-core with_model`
  and `cargo test -p livecap-core model_family` (medium and large-v3-turbo map
  to their #109 floor families; turbo shares large-v3).
- Repo-URL override knob — `cargo test -p livecap-core base_url_override`.

## A. Switch model → next session transcribes with it (AC)

1. Settings → **Transcription**: pick **Medium · ~1.5 GB** (three-option
   segmented control below Language; Small carries the "default" copy,
   Large v3 Turbo the "best accuracy (provisional)" copy).
2. Start a session: the status line shows
   `downloading the "medium" caption model N%…` counting up (first start
   after a switch only; ~1.5 GB, so give it a minute).
3. The session goes Live and transcribes. `ggml-medium.bin` plus its
   `.sha256` marker now sit in
   `~/Library/Application Support/app.livecap.desktop/models/` next to
   `ggml-small.bin`, and `ui-heartbeat.json` shows the live session.
4. Stop; start again: no download status this time (model cached).
5. Repeat with **Large v3 Turbo · ~1.6 GB** if bandwidth allows.

## B. Download failure → fallback, never a dead session (AC)

1. In Settings pick a model that is NOT yet downloaded (e.g. Large v3 Turbo).
2. Relaunch with downloads pointed at an unreachable host:
   `LIVECAP_MODEL_BASE_URL=http://127.0.0.1:1 pnpm tauri dev`
3. Start a session: a status appears — `couldn't download the
   "large-v3-turbo" caption model — using "small" for this session` — and the
   session still goes LIVE, captioning with small. The note survives into the
   Live status detail (joined with any capture note).
4. stderr shows one content-free warning (model name + network error only —
   never caption content).
5. Relaunch WITHOUT the env var: the next start downloads the selected model
   normally (the fallback never overwrites the persisted pick).

## C. Persistence + old settings files (AC)

1. The pick survives an app restart: Settings reopens with the same button
   pressed and `settings.json` contains `"sttModel": "medium"`.
2. Hand-delete the `sttModel` key from `settings.json` → relaunch: Settings
   shows Small (the serde default), no crash, next session runs small.

## Known limits for the reviewer (#110)
- The fallback target is the DEFAULT model (small), not the literal previous
  pick — the ticket allows "previous/default" and settings store only the
  current pick.
- No cancel button on the download; quitting mid-download leaves a
  `.bin.partial` file that is simply re-downloaded next time.
- "Best accuracy (provisional)" copy stands until the calibration ticket
  (#111) produces measured per-model floors.
