# Manual verification — #10 Glass window shell

Automated checks (`cargo clippy -D warnings`, `cargo test`, `pnpm lint`,
`tsc --noEmit`, `pnpm test`, `scripts/no-stub-gate.sh`) are green. The items
below need a human at a real screen.

Launch: `source ~/.cargo/env && pnpm install && pnpm tauri dev`
(first run compiles for a few minutes; the overlay appears as a centered
glass Panel; the LiveCap glyph appears in the menu bar; no Dock icon).

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
