// LiveCap overlay shell UI (#10): glass surface + auto-hiding chrome row.
// The caption feed itself lands with #11 — until then the feed area is empty
// and captioning controls are disabled via the `capabilities` flags.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Mode = "panel" | "strip" | "capsule";

interface Capabilities {
  captioning: boolean;
  settings: boolean;
}

interface ShellState {
  mode: Mode;
  clickThrough: boolean;
  live: boolean;
}

interface ChromePayload {
  interactive: boolean;
}

const CHROME_HIDE_MS = 3000;

const ICONS = {
  pause:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2" width="2.6" height="8" rx="1"/><rect x="6.9" y="2" width="2.6" height="8" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5"/></svg>',
  clickThrough:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 1l8 6.2-3.6.5L8.2 11l-1.6.7-1.7-3.2L2 11.2z"/></svg>',
  mode: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="1" y="1.5" width="10" height="3.2" rx="1.4"/><rect x="2.5" y="6.2" width="7" height="2.2" rx="1.1"/><rect x="4" y="9.8" width="4" height="1.6" rx="0.8"/></svg>',
  close:
    '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};

const state: ShellState = { mode: "panel", clickThrough: false, live: false };
let capabilities: Capabilities = { captioning: false, settings: false };

document.body.innerHTML = `
  <div id="glass">
    <div id="chrome">
      <button id="btn-pause" class="btn" aria-label="Pause captions">${ICONS.pause}</button>
      <button id="btn-stop" class="btn" aria-label="Stop captioning">${ICONS.stop}</button>
      <span class="spacer"></span>
      <button id="btn-clickthrough" class="btn" aria-label="Toggle click-through">${ICONS.clickThrough}</button>
      <button id="btn-mode" class="btn" aria-label="Cycle window mode">${ICONS.mode}</button>
      <button id="btn-close" class="btn" aria-label="Hide LiveCap">${ICONS.close}</button>
    </div>
    <div id="feed"></div>
  </div>
`;

const glass = document.getElementById("glass") as HTMLDivElement;
const chrome = document.getElementById("chrome") as HTMLDivElement;
const btnPause = document.getElementById("btn-pause") as HTMLButtonElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const btnClickThrough = document.getElementById("btn-clickthrough") as HTMLButtonElement;
const btnMode = document.getElementById("btn-mode") as HTMLButtonElement;
const btnClose = document.getElementById("btn-close") as HTMLButtonElement;

function render(): void {
  document.body.dataset.mode = state.mode;

  // Disabled state comes from real capability flags — #11 flips
  // `captioning` and these enable without UI changes.
  btnPause.disabled = !capabilities.captioning;
  btnStop.disabled = !capabilities.captioning;
  btnPause.title = capabilities.captioning
    ? "Pause captions"
    : "Captioning is not available yet";
  btnStop.title = capabilities.captioning
    ? "Stop captioning"
    : "Captioning is not available yet";

  const clickThroughAvailable = state.mode !== "panel";
  btnClickThrough.style.display = clickThroughAvailable ? "" : "none";
  btnClickThrough.setAttribute("aria-pressed", String(state.clickThrough));
  btnClickThrough.title = state.clickThrough
    ? "Click-through is on — clicks pass through; hover a window edge for controls"
    : "Turn on click-through (Strip/Capsule)";

  btnMode.title = `Mode: ${state.mode} — click to cycle (⌥⇧Space)`;
  btnClose.title = "Hide LiveCap (⌥Space shows it again)";
}

/* ---- chrome visibility: show on pointer activity, fade after 3s ---- */
let chromeTimer: ReturnType<typeof setTimeout> | undefined;

function showChrome(): void {
  chrome.classList.add("visible");
  if (chromeTimer !== undefined) clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => chrome.classList.remove("visible"), CHROME_HIDE_MS);
}

document.addEventListener("pointermove", showChrome);
document.addEventListener("pointerdown", showChrome);

/* ---- dragging: Rust follows the cursor and applies magnetic snapping ---- */
let dragStart: { x: number; y: number; t: number } | null = null;

glass.addEventListener("pointerdown", (e: PointerEvent) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button")) return;
  glass.setPointerCapture(e.pointerId);
  dragStart = { x: e.screenX, y: e.screenY, t: Date.now() };
  void invoke("begin_drag");
});

function finishDrag(e: PointerEvent): void {
  if (!dragStart) return;
  void invoke("end_drag");
  const moved = Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y);
  const quick = Date.now() - dragStart.t < 300;
  dragStart = null;
  // §8.1: a click (not a drag) on the Capsule opens the Panel.
  if (state.mode === "capsule" && moved < 4 && quick) {
    void invoke("set_mode", { mode: "panel" });
  }
}

glass.addEventListener("pointerup", finishDrag);
glass.addEventListener("pointercancel", finishDrag);

/* ---- controls ---- */
btnClickThrough.addEventListener("click", () => {
  void invoke("set_click_through", { enabled: !state.clickThrough });
});
btnMode.addEventListener("click", () => {
  void invoke("cycle_mode");
});
btnClose.addEventListener("click", () => {
  void invoke("hide_overlay");
});

/* ---- shell events from Rust ---- */
void listen<ShellState>("shell://mode", (event) => {
  Object.assign(state, event.payload);
  render();
});

void listen<ChromePayload>("shell://chrome", (event) => {
  // Click-through edge zone regained interactivity: surface the controls.
  if (event.payload.interactive) showChrome();
});

/* ---- initial state ---- */
void (async () => {
  const [shellState, caps] = await Promise.all([
    invoke<ShellState>("get_shell_state"),
    invoke<Capabilities>("capabilities"),
  ]);
  Object.assign(state, shellState);
  capabilities = caps;
  render();
})();
