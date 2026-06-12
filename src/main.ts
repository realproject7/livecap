// LiveCap overlay UI: glass shell (#10) + the live caption feed, summary
// strip, reply chips, quick translate, and session lifecycle (#11).
// Design: design/screens/02-panel-live.png; the five caption-block states in
// design/system/design-system.png are normative.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";

import { FeedState, type CaptionBlock } from "./feed-state";
import type {
  CaptionBridgeEvent,
  HostInbound,
  HostOutbound,
  ReplyIntentWire,
  SessionStatus,
} from "./protocol";

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
const TOAST_MS = 4000;

const ICONS = {
  play: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3.2 2.1a.8.8 0 0 1 1.2-.7l6 3.9a.8.8 0 0 1 0 1.4l-6 3.9a.8.8 0 0 1-1.2-.7z"/></svg>',
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
let phase: SessionStatus["phase"] = "idle";
let statusDetail = "";
let summaryLine = "";
let requestCounter = 0;

const feed = new FeedState();

document.body.innerHTML = `
  <div id="glass">
    <div id="chrome">
      <button id="btn-pause" class="btn" aria-label="Start, pause, or resume captions">${ICONS.play}</button>
      <button id="btn-stop" class="btn" aria-label="Stop captioning">${ICONS.stop}</button>
      <span class="spacer"></span>
      <button id="btn-clickthrough" class="btn" aria-label="Toggle click-through">${ICONS.clickThrough}</button>
      <button id="btn-mode" class="btn" aria-label="Cycle window mode">${ICONS.mode}</button>
      <button id="btn-close" class="btn" aria-label="Hide LiveCap">${ICONS.close}</button>
    </div>
    <div id="panel-body">
      <div id="summary">
        <span class="live-dot" id="summary-dot"></span>
        <div class="txt"><span class="lbl" id="summary-label">LiveCap</span><span id="summary-line"></span></div>
      </div>
      <div class="hairline"></div>
      <div id="feed-wrap">
        <div id="feed" aria-live="polite"></div>
      </div>
      <button id="live-chip" type="button">↓ live</button>
      <div id="pinned"></div>
      <div id="cards"></div>
      <div id="chips">
        <button class="chip" data-intent="suggest">✦ Suggest</button>
        <button class="chip" data-intent="agree">👍 Agree</button>
        <button class="chip" data-intent="push-back">✋ Push back</button>
        <button class="chip" data-intent="ask">? Ask</button>
      </div>
      <div id="composer">
        <div class="input-row">
          <input id="qt-input" type="text" autocomplete="off" spellcheck="false" aria-label="Quick translate" />
          <span id="qt-hint">Quick translate — type in your language…</span>
          <button id="qt-send" aria-label="Translate">↑</button>
        </div>
      </div>
    </div>
    <div id="strip-view">
      <div class="src t-original"></div>
      <div class="tr t-translation"></div>
    </div>
    <div id="capsule-view">
      <span class="live-dot on"></span>
      <span class="txt"></span>
    </div>
    <div id="toast"></div>
  </div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const glass = $<HTMLDivElement>("glass");
const chrome = $<HTMLDivElement>("chrome");
const btnPause = $<HTMLButtonElement>("btn-pause");
const btnStop = $<HTMLButtonElement>("btn-stop");
const btnClickThrough = $<HTMLButtonElement>("btn-clickthrough");
const btnMode = $<HTMLButtonElement>("btn-mode");
const btnClose = $<HTMLButtonElement>("btn-close");
const summaryDot = $<HTMLSpanElement>("summary-dot");
const summaryLabel = $<HTMLSpanElement>("summary-label");
const summaryLineEl = $<HTMLSpanElement>("summary-line");
const feedEl = $<HTMLDivElement>("feed");
const feedWrap = $<HTMLDivElement>("feed-wrap");
const liveChip = $<HTMLButtonElement>("live-chip");
const pinnedEl = $<HTMLDivElement>("pinned");
const cardsEl = $<HTMLDivElement>("cards");
const chipsEl = $<HTMLDivElement>("chips");
const qtInput = $<HTMLInputElement>("qt-input");
const qtHint = $<HTMLSpanElement>("qt-hint");
const qtSend = $<HTMLButtonElement>("qt-send");
const toastEl = $<HTMLDivElement>("toast");
const stripSrc = document.querySelector<HTMLDivElement>("#strip-view .src") as HTMLDivElement;
const stripTr = document.querySelector<HTMLDivElement>("#strip-view .tr") as HTMLDivElement;
const capsuleTxt = document.querySelector<HTMLSpanElement>("#capsule-view .txt") as HTMLSpanElement;

/* ================= session lifecycle ================= */

const sessionRunning = (): boolean => phase === "live" || phase === "paused";

async function hostRequest(message: HostInbound): Promise<void> {
  try {
    await invoke("host_request", { message });
  } catch (error) {
    showToast(String(error));
  }
}

async function sessionCommand(command: string): Promise<void> {
  try {
    await invoke(command);
  } catch (error) {
    showToast(String(error));
  }
}

btnPause.addEventListener("click", () => {
  if (phase === "idle") void sessionCommand("session_start");
  else if (phase === "live") void sessionCommand("session_pause");
  else if (phase === "paused") void sessionCommand("session_resume");
});
btnStop.addEventListener("click", () => {
  if (sessionRunning()) void sessionCommand("session_stop");
});

/* ================= rendering ================= */

function render(): void {
  document.body.dataset.mode = state.mode;
  document.body.dataset.phase = phase;

  btnPause.disabled = !capabilities.captioning || phase === "starting" || phase === "stopping";
  btnStop.disabled = !capabilities.captioning || !sessionRunning();
  btnPause.innerHTML = phase === "live" ? ICONS.pause : ICONS.play;
  btnPause.title =
    phase === "idle"
      ? "Start captioning"
      : phase === "live"
        ? "Pause captions"
        : phase === "paused"
          ? "Resume captions"
          : "Working…";
  btnStop.title = "Stop captioning and save the transcript";

  const clickThroughAvailable = state.mode !== "panel";
  btnClickThrough.style.display = clickThroughAvailable ? "" : "none";
  btnClickThrough.setAttribute("aria-pressed", String(state.clickThrough));
  btnClickThrough.title = state.clickThrough
    ? "Click-through is on — clicks pass through; hover a window edge for controls"
    : "Turn on click-through (Strip/Capsule)";
  btnMode.title = `Mode: ${state.mode} — click to cycle (⌥⇧Space)`;
  btnClose.title = "Hide LiveCap (⌥Space shows it again)";

  renderSummaryStrip();

  const interactive = phase === "live";
  for (const chip of chipsEl.querySelectorAll<HTMLButtonElement>("button")) chip.disabled = !interactive;
  qtInput.disabled = !interactive;
  qtSend.disabled = !interactive;
}

function renderSummaryStrip(): void {
  if (phase === "idle") {
    summaryLabel.textContent = "LiveCap";
    summaryLineEl.textContent = "Start captioning from the menu bar, or press ▶ above.";
    summaryDot.classList.remove("on");
  } else if (phase === "starting" || phase === "stopping") {
    summaryLabel.textContent = phase === "starting" ? "Starting" : "Saving";
    summaryLineEl.textContent = statusDetail !== "" ? statusDetail : "…";
    summaryDot.classList.remove("on");
  } else if (phase === "paused") {
    summaryLabel.textContent = "Paused";
    summaryLineEl.textContent = "Captions are paused — press ▶ to resume.";
    summaryDot.classList.remove("on");
  } else {
    summaryLabel.textContent = "Live summary";
    summaryLineEl.textContent = summaryLine !== "" ? summaryLine : "Listening…";
    summaryDot.classList.add("on");
  }
}

/* ---- caption blocks (the five states) ---- */

const blockEls = new Map<string, HTMLElement>();

function blockEl(block: CaptionBlock): HTMLElement {
  const existing = blockEls.get(block.key);
  if (existing) return existing;
  const el = document.createElement("div");
  el.className = `cap ${block.channel === "me" ? "me" : "them"}`;
  el.dataset.key = block.key;
  el.innerHTML = `
    <div class="row">
      <span class="pin-mark">📌</span>
      <span class="src"></span>
      <span class="time t-meta"></span>
      <span class="ghost">
        <button class="g g-pin" title="Pin">📌</button>
        <button class="g g-copy" title="Copy">⧉</button>
        <button class="g g-re" title="Retranslate">⟳</button>
      </span>
    </div>
    <div class="tr"></div>
  `;
  el.querySelector<HTMLButtonElement>(".g-pin")?.addEventListener("click", () => togglePin(block.key));
  el.querySelector<HTMLButtonElement>(".g-copy")?.addEventListener("click", () => copyBlock(block.key));
  el.querySelector<HTMLButtonElement>(".g-re")?.addEventListener("click", () => retranslate(block.key));
  blockEls.set(block.key, el);
  // Rule 4: new blocks fade in over 150ms in place — opacity only.
  el.classList.add("fading-in");
  requestAnimationFrame(() => el.classList.remove("fading-in"));
  return el;
}

function updateBlockEl(block: CaptionBlock): void {
  const el = blockEl(block);
  el.dataset.state = block.state;
  el.classList.toggle("low", block.lowConfidence);
  el.classList.toggle("is-pinned", block.pinned);

  const src = el.querySelector<HTMLSpanElement>(".src");
  if (src) {
    src.textContent = block.lowConfidence ? `${block.source} (?)` : block.source;
    if (block.state === "streaming") {
      const cursor = document.createElement("span");
      cursor.className = "cursor";
      src.appendChild(cursor);
    }
  }
  const time = el.querySelector<HTMLSpanElement>(".time");
  if (time) time.textContent = block.epochMs !== null ? clockLabel(block.epochMs) : "";
  const tr = el.querySelector<HTMLDivElement>(".tr");
  if (tr) {
    if (block.translation !== "") tr.textContent = block.translation;
    else if (block.state === "pending") tr.textContent = "⋯";
    else if (block.state === "failed") tr.textContent = "translation unavailable — ⟳ to retry";
    else tr.textContent = "";
  }
}

function clockLabel(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* ---- scroll: history with a "↓ live" snap-back chip ---- */

let atBottom = true;

feedWrap.addEventListener("scroll", () => {
  atBottom = feedWrap.scrollTop + feedWrap.clientHeight >= feedWrap.scrollHeight - 24;
  if (atBottom) liveChip.classList.remove("visible");
});

function snapToLive(): void {
  feedWrap.scrollTop = feedWrap.scrollHeight;
  atBottom = true;
  liveChip.classList.remove("visible");
}

liveChip.addEventListener("click", snapToLive);

function afterFeedChange(appended: boolean): void {
  if (atBottom) {
    feedWrap.scrollTop = feedWrap.scrollHeight;
  } else if (appended) {
    liveChip.classList.add("visible");
  }
  syncMiniViews();
}

/* ---- pinned dock (state 5: held above the input row until unpinned) ---- */

function renderPinned(): void {
  pinnedEl.replaceChildren();
  const pinned = feed.pinnedBlocks();
  pinnedEl.classList.toggle("has-pins", pinned.length > 0);
  for (const block of pinned) {
    const el = document.createElement("div");
    el.className = `cap pinned-copy ${block.channel === "me" ? "me" : "them"}`;
    el.innerHTML = `
      <div class="row">
        <span class="pin-mark">📌</span>
        <span class="src"></span>
        <span class="time t-meta"></span>
        <span class="ghost"><button class="g g-pin" title="Unpin">✕</button></span>
      </div>
      <div class="tr"></div>
    `;
    const src = el.querySelector<HTMLSpanElement>(".src");
    if (src) src.textContent = block.lowConfidence ? `${block.source} (?)` : block.source;
    const time = el.querySelector<HTMLSpanElement>(".time");
    if (time) time.textContent = block.epochMs !== null ? clockLabel(block.epochMs) : "";
    const tr = el.querySelector<HTMLDivElement>(".tr");
    if (tr) tr.textContent = block.translation;
    el.querySelector<HTMLButtonElement>(".g-pin")?.addEventListener("click", () => togglePin(block.key));
    pinnedEl.appendChild(el);
  }
}

/* ---- block actions (ghost: pin · copy · retranslate) ---- */

function togglePin(key: string): void {
  const block = feed.blocks.find((b) => b.key === key);
  if (!block || block.id === null) return;
  const pinned = !block.pinned;
  feed.setPinned(block.id, pinned);
  updateBlockEl(block);
  renderPinned();
  void hostRequest({ type: "pin", id: block.id, pinned });
}

function copyBlock(key: string): void {
  const block = feed.blocks.find((b) => b.key === key);
  if (!block) return;
  const text = block.translation !== "" ? `${block.source}\n${block.translation}` : block.source;
  void writeText(text).then(
    () => showToast("Copied"),
    () => showToast("Copy failed"),
  );
}

function retranslate(key: string): void {
  const block = feed.blocks.find((b) => b.key === key);
  if (!block || block.id === null || !sessionRunning()) return;
  feed.markRetranslating(block.id);
  updateBlockEl(block);
  void hostRequest({ type: "retranslate", id: block.id });
}

/* ---- strip / capsule: latest line(s) from the same stream (§8.1) ---- */

function syncMiniViews(): void {
  const latest = feed.latest();
  stripSrc.textContent = latest?.source ?? "";
  stripSrc.classList.toggle("t-partial", latest?.state === "streaming");
  stripSrc.classList.toggle("t-original", latest?.state !== "streaming");
  stripTr.textContent = latest?.translation ?? "";
  capsuleTxt.textContent = latest?.source ?? (sessionRunning() ? "Listening…" : "LiveCap");
}

/* ---- inline result cards (reply chips + quick translate, §8.5) ---- */

interface PendingCard {
  el: HTMLElement;
  body: HTMLDivElement;
}

const pendingCards = new Map<number, PendingCard>();

function registerCard(el: HTMLElement, body: HTMLDivElement): number {
  pendingCards.forEach((card, key) => {
    if (card.el === el) pendingCards.delete(key);
  });
  requestCounter += 1;
  pendingCards.set(requestCounter, { el, body });
  return requestCounter;
}

function newCard(label: string, intent?: ReplyIntentWire): number {
  const el = document.createElement("div");
  el.className = "card fading-in";
  el.innerHTML = `
    <div class="card-label t-meta"></div>
    <div class="card-body"></div>
    <div class="card-actions">
      <button class="c-copy">⧉ Copy</button>
      ${intent !== undefined ? '<button class="c-again">⟳ Another</button>' : ""}
      <button class="c-close">✕</button>
    </div>
  `;
  const labelEl = el.querySelector<HTMLDivElement>(".card-label");
  if (labelEl) labelEl.textContent = label;
  const body = el.querySelector<HTMLDivElement>(".card-body") as HTMLDivElement;
  body.textContent = "…";
  el.querySelector<HTMLButtonElement>(".c-copy")?.addEventListener("click", () => {
    void writeText(body.textContent ?? "").then(
      () => showToast("Copied"),
      () => showToast("Copy failed"),
    );
  });
  el.querySelector<HTMLButtonElement>(".c-close")?.addEventListener("click", () => {
    pendingCards.forEach((card, key) => {
      if (card.el === el) pendingCards.delete(key);
    });
    el.remove();
  });
  if (intent !== undefined) {
    el.querySelector<HTMLButtonElement>(".c-again")?.addEventListener("click", () => {
      body.textContent = "…";
      const nextId = registerCard(el, body);
      void hostRequest({ type: "reply", id: nextId, intent });
    });
  }
  cardsEl.appendChild(el);
  requestAnimationFrame(() => el.classList.remove("fading-in"));
  return registerCard(el, body);
}

const CHIP_LABELS: Record<ReplyIntentWire, string> = {
  suggest: "✦ Suggestion",
  agree: "👍 Agree",
  "push-back": "✋ Push back",
  ask: "? Ask",
};

chipsEl.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-intent]");
  if (!button || button.disabled) return;
  const intent = button.dataset.intent as ReplyIntentWire;
  const id = newCard(CHIP_LABELS[intent], intent);
  void hostRequest({ type: "reply", id, intent });
});

function sendQuickTranslate(): void {
  const text = qtInput.value.trim();
  if (text === "" || !sessionRunning()) return;
  qtInput.value = "";
  qtHint.classList.remove("hidden");
  const id = newCard("⇄ Quick translate");
  void hostRequest({ type: "quickTranslate", id, text });
}

qtSend.addEventListener("click", sendQuickTranslate);
qtInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendQuickTranslate();
});
qtInput.addEventListener("input", () => {
  qtHint.classList.toggle("hidden", qtInput.value !== "");
});

/* ---- toast (one line, meta tone) ---- */

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("visible");
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), TOAST_MS);
}

/* ================= event streams ================= */

void listen<CaptionBridgeEvent>("caption://event", (event) => {
  const block = feed.applyCaption(event.payload);
  const isNew = !blockEls.has(block.key);
  const el = blockEl(block);
  if (isNew) feedEl.appendChild(el);
  updateBlockEl(block);
  afterFeedChange(isNew);
});

void listen<HostOutbound>("host://event", (event) => {
  const message = event.payload;
  switch (message.type) {
    case "translation": {
      for (const block of feed.applyTranslation(message.items, message.done)) updateBlockEl(block);
      renderPinnedIfAffected(message.items.map((item) => item.id));
      afterFeedChange(false);
      break;
    }
    case "translationFailed": {
      for (const block of feed.applyFailed(message.ids)) updateBlockEl(block);
      afterFeedChange(false);
      break;
    }
    case "summary":
      summaryLine = message.summary[0] ?? "";
      renderSummaryStrip();
      break;
    case "engineSwitch":
      showToast(`switched to ${message.engine.toLowerCase()} — captions continue`);
      break;
    case "quickTranslateResult":
    case "replyResult": {
      const card = pendingCards.get(message.id);
      if (card) card.body.textContent = message.text;
      break;
    }
    case "extrasFailed": {
      const card = pendingCards.get(message.id);
      if (card) card.body.textContent = `unavailable (${message.detail})`;
      break;
    }
    case "silence":
      void promptSilenceStop(message.sinceMs);
      break;
    case "archived":
      showToast(`Saved — ${message.path.split("/").pop() ?? message.path}`);
      break;
    case "status":
      statusDetail = message.detail;
      if (phase === "starting" || phase === "stopping") renderSummaryStrip();
      else showToast(message.detail);
      break;
    case "hostError":
      showToast(message.detail);
      break;
    case "ready":
    case "gauge":
    case "stopped":
      break;
  }
});

function renderPinnedIfAffected(ids: number[]): void {
  if (ids.some((id) => feed.get(id)?.pinned)) renderPinned();
}

async function promptSilenceStop(sinceMs: number): Promise<void> {
  const minutes = Math.round(sinceMs / 60_000);
  const stop = await ask(
    `No speech detected for ${minutes} minutes. Stop captioning and save the transcript?`,
    { title: "LiveCap", kind: "info", okLabel: "Stop & save", cancelLabel: "Keep going" },
  );
  if (stop) void sessionCommand("session_stop");
  else void hostRequest({ type: "silenceSnooze" });
}

void listen<SessionStatus>("session://status", (event) => {
  phase = event.payload.phase;
  statusDetail = event.payload.detail ?? "";
  render();
  syncMiniViews();
});

/* ================= shell behaviors (#10) ================= */

let chromeTimer: ReturnType<typeof setTimeout> | undefined;

function showChrome(): void {
  chrome.classList.add("visible");
  if (chromeTimer !== undefined) clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => chrome.classList.remove("visible"), CHROME_HIDE_MS);
}

document.addEventListener("pointermove", showChrome);
document.addEventListener("pointerdown", showChrome);

/* dragging: Rust follows the cursor and applies magnetic snapping. In Panel
   mode the feed/cards/composer are interactive (scroll, type), so dragging
   starts only from non-interactive surfaces. */
let dragStart: { x: number; y: number; t: number } | null = null;

glass.addEventListener("pointerdown", (e: PointerEvent) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input")) return;
  if (state.mode === "panel" && target.closest("#feed-wrap, #pinned, #cards, #chips, #composer")) return;
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

btnClickThrough.addEventListener("click", () => {
  void invoke("set_click_through", { enabled: !state.clickThrough });
});
btnMode.addEventListener("click", () => {
  void invoke("cycle_mode");
});
btnClose.addEventListener("click", () => {
  void invoke("hide_overlay");
});

void listen<ShellState>("shell://mode", (event) => {
  Object.assign(state, event.payload);
  render();
  syncMiniViews();
});

void listen<ChromePayload>("shell://chrome", (event) => {
  // Click-through edge zone regained interactivity: surface the controls.
  if (event.payload.interactive) showChrome();
});

/* ================= initial state ================= */

void (async () => {
  const [shellState, caps, initialPhase] = await Promise.all([
    invoke<ShellState>("get_shell_state"),
    invoke<Capabilities>("capabilities"),
    invoke<SessionStatus["phase"]>("session_phase"),
  ]);
  Object.assign(state, shellState);
  capabilities = caps;
  phase = initialPhase;
  render();
  syncMiniViews();
})();
