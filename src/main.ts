// LiveCap overlay UI: glass shell (#10) + the live caption feed, summary
// strip, reply chips, quick translate, and session lifecycle (#11).
// Design: design/screens/02-panel-live.png; the five caption-block states in
// design/system/design-system.png are normative.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";

import {
  applyCaptionSize,
  nextSettingsForSessionLanguage,
  nextSettingsForSessionSourceLanguage,
  type AppSettings,
} from "./app-settings";
import { bootstrap } from "./bootstrap";
import { LANGUAGES, SOURCE_AUTO_CODE, SOURCE_LANGUAGES, languageByCode } from "./languages";
import { FeedState, type CaptionBlock } from "./feed-state";
import {
  buildReview,
  type CoachingCard,
  type ReviewCallbacks,
  type ReviewSurface,
} from "./review";
import { startOnboarding } from "./onboarding";
import type {
  BoardWire,
  Capabilities,
  CaptionBridgeEvent,
  HostInbound,
  HostOutbound,
  ReplyIntentWire,
  SessionChannels,
  SessionStatus,
  ShellState,
} from "./protocol";
import { createSettingsSheet } from "./settings-sheet";
import { summaryStripContent } from "./summary-strip";
import { startUiHeartbeat } from "./ui-heartbeat";

interface ChromePayload {
  interactive: boolean;
}

const CHROME_HIDE_MS = 3000;
const TOAST_MS = 4000;
/** TTS voice language for the coaching playback (#82). The meeting language is
 *  English (src/host/start-config.ts MEETING_LANGUAGE); the rewrite is in that
 *  language, so the voice is English. */
const MEETING_VOICE_LANG = "en-US";

const ICONS = {
  play: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3.2 2.1a.8.8 0 0 1 1.2-.7l6 3.9a.8.8 0 0 1 0 1.4l-6 3.9a.8.8 0 0 1-1.2-.7z"/></svg>',
  pause:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2" width="2.6" height="8" rx="1"/><rect x="6.9" y="2" width="2.6" height="8" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5"/></svg>',
  mic: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="4.4" y="0.8" width="3.2" height="6" rx="1.6"/><path d="M2.7 5.4a.55.55 0 0 1 1.1 0 2.2 2.2 0 0 0 4.4 0 .55.55 0 0 1 1.1 0 3.3 3.3 0 0 1-2.75 3.25v1.25h1.05a.55.55 0 0 1 0 1.1H4.4a.55.55 0 0 1 0-1.1h1.05V8.65A3.3 3.3 0 0 1 2.7 5.4z"/></svg>',
  micOff:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="currentColor" opacity="0.55"><rect x="4.4" y="0.8" width="3.2" height="6" rx="1.6"/><path d="M2.7 5.4a.55.55 0 0 1 1.1 0 2.2 2.2 0 0 0 4.4 0 .55.55 0 0 1 1.1 0 3.3 3.3 0 0 1-2.75 3.25v1.25h1.05a.55.55 0 0 1 0 1.1H4.4a.55.55 0 0 1 0-1.1h1.05V8.65A3.3 3.3 0 0 1 2.7 5.4z"/></g><path d="M1.8 1.4l8.4 9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>',
  clickThrough:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 1l8 6.2-3.6.5L8.2 11l-1.6.7-1.7-3.2L2 11.2z"/></svg>',
  pin: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M7.3.9 11.1 4.7a.7.7 0 0 1-.46 1.19l-1.83.2-1.6 1.6.36 2.2a.7.7 0 0 1-1.19.6L4.2 8.16 1.6 10.75a.6.6 0 0 1-.85-.85L3.34 7.3 1.51 5.41a.7.7 0 0 1 .6-1.19l2.2.36 1.6-1.6.2-1.83A.7.7 0 0 1 7.3.9Z"/></svg>',
  mode: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="1" y="1.5" width="10" height="3.2" rx="1.4"/><rect x="2.5" y="6.2" width="7" height="2.2" rx="1.1"/><rect x="4" y="9.8" width="4" height="1.6" rx="0.8"/></svg>',
  close:
    '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};

const state: ShellState = { mode: "panel", clickThrough: false, pinned: true, live: false };
let capabilities: Capabilities = { captioning: false, settings: false };
let phase: SessionStatus["phase"] = "idle";
// #53: desired capture channels for the running session (both-on while idle).
let channels: SessionChannels = { system: true, mic: true };
let statusDetail = "";
let summaryLine = "";
let requestCounter = 0;
// Latest full summary/board (#81) — retained so the post-meeting review screen
// can render them; the live strip only shows the first summary line.
let latestSummary: string[] = [];
let latestBoard: BoardWire = { decisions: [], actionItems: [], openQuestions: [] };
// Latest archive path for the review screen's "open saved file" action.
let latestArchivePath: string | null = null;

const feed = new FeedState();

document.body.innerHTML = `
  <div id="glass">
    <div id="chrome">
      <button id="btn-pause" class="btn" aria-label="Start, pause, or resume captions">${ICONS.play}</button>
      <button id="btn-stop" class="btn" aria-label="Stop captioning">${ICONS.stop}</button>
      <button id="btn-mic" class="btn" aria-label="Microphone capture on/off">${ICONS.mic}</button>
      <span class="spacer"></span>
      <button id="btn-pin" class="btn" aria-label="Pin LiveCap on top">${ICONS.pin}</button>
      <button id="btn-clickthrough" class="btn" aria-label="Toggle click-through">${ICONS.clickThrough}</button>
      <button id="btn-mode" class="btn" aria-label="Cycle window mode">${ICONS.mode}</button>
      <button id="btn-close" class="btn" aria-label="Hide LiveCap">${ICONS.close}</button>
    </div>
    <div id="panel-body">
      <div id="start-panel">
        <div class="sp-mark">LiveCap</div>
        <div class="sp-sub">Live captions and translation for everything you hear — private, on this Mac.</div>
        <div class="sp-guide">
          <div class="sp-guide-row"><span class="sp-guide-ico">🔊</span><span>Captions what you hear <b>and</b> what you say, in real time.</span></div>
          <div class="sp-guide-row"><span class="sp-guide-ico">🌐</span><span>Translates each line into your language, right underneath.</span></div>
          <div class="sp-guide-row"><span class="sp-guide-ico">🔒</span><span>On-device &amp; private — hidden from screen sharing.</span></div>
        </div>
        <label class="sp-lang-label" for="sp-source">Spoken language</label>
        <select id="sp-source" class="sp-lang" aria-label="Spoken (source) language for this session"></select>
        <label class="sp-lang-label" for="sp-lang">Translate into</label>
        <select id="sp-lang" class="sp-lang" aria-label="Target language for this session"></select>
        <button id="sp-start" type="button" class="sp-start">Start captioning</button>
        <div class="sp-hint t-meta">Nothing is captured until you start.</div>
      </div>
      <div id="summary">
        <span class="live-dot" id="summary-dot"></span>
        <div class="txt"><span class="lbl" id="summary-label">LiveCap</span><span id="summary-line"></span></div>
      </div>
      <div class="hairline"></div>
      <div id="feed-wrap">
        <div id="feed" aria-live="polite"><div id="feed-note" class="t-meta">older captions are in the archive</div></div>
      </div>
      <button id="live-chip" type="button">↓ live</button>
      <div id="pinned"></div>
      <div id="cards"></div>
      <div id="review-mount"></div>
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
    <div id="settings-sheet"></div>
    <div id="onboarding"></div>
    <div id="toast"></div>
  </div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const glass = $<HTMLDivElement>("glass");
const chrome = $<HTMLDivElement>("chrome");
const btnPause = $<HTMLButtonElement>("btn-pause");
const btnStop = $<HTMLButtonElement>("btn-stop");
const btnMic = $<HTMLButtonElement>("btn-mic");
const btnPin = $<HTMLButtonElement>("btn-pin");
const btnClickThrough = $<HTMLButtonElement>("btn-clickthrough");
const btnMode = $<HTMLButtonElement>("btn-mode");
const btnClose = $<HTMLButtonElement>("btn-close");
const summaryDot = $<HTMLSpanElement>("summary-dot");
const summaryLabel = $<HTMLSpanElement>("summary-label");
const summaryLineEl = $<HTMLSpanElement>("summary-line");
const feedEl = $<HTMLDivElement>("feed");
const feedNote = $<HTMLDivElement>("feed-note");
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
const onboardingEl = $<HTMLDivElement>("onboarding");
const startPanel = $<HTMLDivElement>("start-panel");
const startSourceSelect = $<HTMLSelectElement>("sp-source");
const startLangSelect = $<HTMLSelectElement>("sp-lang");
const startBtn = $<HTMLButtonElement>("sp-start");

/* ================= settings (#12) ================= */

let appSettings: AppSettings = {
  onboardingComplete: true, // assume done until get_settings says otherwise
  engine: "cli",
  targetLanguage: "ko",
  sourceLanguage: "auto", // #94: per-utterance auto-detect until the user picks
  poolUsd: 20,
  resetDay: 1,
  autoSwitch: true,
  captionSize: "m",
  capsuleContent: "translation",
  archiveAutoSave: true,
  archiveFolder: null,
  archiveRetentionDays: 0,
  captureSystem: true,
  captureMic: true,
};

async function persistSettings(next: AppSettings): Promise<AppSettings> {
  const saved = await invoke<AppSettings>("set_settings", { settings: next });
  appSettings = saved;
  applyCaptionSize(saved.captionSize);
  return saved;
}

const settingsSheet = createSettingsSheet({
  host: $<HTMLDivElement>("settings-sheet"),
  getSettings: () => appSettings,
  applySettings: persistSettings,
  getClickThrough: () => state.clickThrough,
  setClickThrough: (enabled) => void invoke("set_click_through", { enabled }),
});

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

/** Populate the start-panel pickers and select the remembered defaults. */
function renderStartPanel(): void {
  // Spoken (source) language picker (#94): "Auto" first, then the same
  // curated languages as the target picker.
  if (startSourceSelect.options.length === 0) {
    startSourceSelect.innerHTML = SOURCE_LANGUAGES.map(
      (l) => `<option value="${l.code}">${l.native}</option>`,
    ).join("");
  }
  if (startLangSelect.options.length === 0) {
    startLangSelect.innerHTML = LANGUAGES.map(
      (l) => `<option value="${l.code}">${l.native}</option>`,
    ).join("");
  }
  // The last-used target (persisted) is the default for the next session (#2);
  // a tag outside the curated list still resolves, so seed it as an option.
  const current = languageByCode(appSettings.targetLanguage);
  if (!LANGUAGES.some((l) => l.code === current.code)) {
    const opt = document.createElement("option");
    opt.value = current.code;
    opt.textContent = current.native;
    startLangSelect.appendChild(opt);
  }
  startLangSelect.value = current.code;

  // The last-used spoken language (#94); "auto" or any curated code resolves,
  // an arbitrary persisted tag is seeded so it stays selectable.
  const source = languageByCode(appSettings.sourceLanguage);
  if (!SOURCE_LANGUAGES.some((l) => l.code === source.code)) {
    const opt = document.createElement("option");
    opt.value = source.code;
    opt.textContent = source.native;
    startSourceSelect.appendChild(opt);
  }
  startSourceSelect.value = SOURCE_LANGUAGES.some((l) => l.code === appSettings.sourceLanguage)
    ? appSettings.sourceLanguage
    : source.code;
}

/** Start a session with the language chosen in the start panel (#1/#2). The
 *  pick is persisted FIRST so (a) it becomes the next session's default and
 *  (b) start_inner — which reads settings fresh — honors it. */
async function startSession(): Promise<void> {
  // Fold both per-session picks (target #2 + spoken source #94) into one write
  // so the next session defaults to them and start_inner (which reads settings
  // fresh) honors the forced source language.
  let next = nextSettingsForSessionLanguage(appSettings, startLangSelect.value);
  const sourcePick = startSourceSelect.value || SOURCE_AUTO_CODE;
  const withSource = nextSettingsForSessionSourceLanguage(next ?? appSettings, sourcePick);
  next = withSource ?? next;
  if (next) {
    try {
      await persistSettings(next);
    } catch (error) {
      showToast(String(error));
      return;
    }
  }
  await sessionCommand("session_start");
}

startBtn.addEventListener("click", () => void startSession());

btnPause.addEventListener("click", () => {
  if (phase === "idle") void startSession();
  else if (phase === "live") void sessionCommand("session_pause");
  else if (phase === "paused") void sessionCommand("session_resume");
});
btnStop.addEventListener("click", () => {
  if (sessionRunning()) void sessionCommand("session_stop");
});
btnMic.addEventListener("click", () => {
  // #53: mid-session pause/resume of just the mic; the resulting
  // session://channels event updates the button (and the tray mirror).
  if (!sessionRunning()) return;
  void invoke("session_set_mic", { enabled: !channels.mic }).catch((error: unknown) =>
    showToast(String(error)),
  );
});

/* ================= rendering ================= */

function render(): void {
  document.body.dataset.mode = state.mode;
  document.body.dataset.phase = phase;

  // #1: while idle, the Panel shows the Start/home screen — brand, a short
  // guide, the per-session language pick and the "Start captioning" CTA. It
  // never auto-runs; the session begins only when the user presses Start. The
  // screen hides while onboarding or the post-meeting review owns the Panel.
  const showStart =
    phase === "idle" &&
    capabilities.captioning &&
    !onboardingEl.classList.contains("active") &&
    !review.isOpen();
  startPanel.classList.toggle("visible", showStart);
  if (showStart) renderStartPanel();
  startBtn.disabled = !capabilities.captioning;

  btnPause.disabled = !capabilities.captioning || phase === "starting" || phase === "stopping";
  btnStop.disabled = !capabilities.captioning || !sessionRunning();
  btnMic.disabled = !capabilities.captioning || !sessionRunning();
  btnMic.innerHTML = channels.mic ? ICONS.mic : ICONS.micOff;
  btnMic.setAttribute("aria-pressed", String(channels.mic));
  btnMic.title = !sessionRunning()
    ? "Microphone on/off (during a session)"
    : channels.mic
      ? "Mic is on — click to stop capturing your voice"
      : "Mic is off — click to capture your voice again";
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

  btnPin.setAttribute("aria-pressed", String(state.pinned));
  btnPin.title = state.pinned
    ? "Pinned on top — floats over every Space; click to unpin"
    : "Unpinned — behaves like a normal window; click to pin on top";

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
  const { label, line, live } = summaryStripContent(phase, statusDetail, summaryLine);
  summaryLabel.textContent = label;
  summaryLineEl.textContent = line;
  summaryDot.classList.toggle("on", live);
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
        <button class="g g-analyze" title="Analyze + suggest a reply">✦</button>
        <button class="g g-pin" title="Pin">📌</button>
        <button class="g g-copy" title="Copy">⧉</button>
        <button class="g g-re" title="Retranslate">⟳</button>
      </span>
    </div>
    <div class="tr"></div>
  `;
  el.querySelector<HTMLButtonElement>(".g-analyze")?.addEventListener("click", () => analyzeBlock(block.key));
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

/* ---- #80 targeted analysis: click a caption → strategy + suggested reply ---- */

function analyzeBlock(key: string): void {
  const block = feed.blocks.find((b) => b.key === key);
  if (!block || block.id === null || !sessionRunning()) return;
  const captionId = block.id;
  const card = newAnalysisCard(block.source, () => requestAnalysis(captionId, card.id));
  requestAnalysis(captionId, card.id);
}

function requestAnalysis(captionId: number, cardId: number): void {
  void hostRequest({ type: "analyze", cardId, captionId });
}

/* ---- strip / capsule: latest line(s) from the same stream (§8.1) ---- */

function syncMiniViews(): void {
  const latest = feed.latest();

  // #6 Strip (TV-subtitle style, design/screens/03-strip-mode.png): the latest
  // finalized line as SOURCE (caption) on top + TRANSLATION underneath, both
  // filling the strip width. A still-streaming partial shows in the partial tone
  // with no translation yet.
  const streaming = latest?.state === "streaming";
  stripSrc.textContent = latest?.source ?? (sessionRunning() ? "Listening…" : "LiveCap");
  stripSrc.classList.toggle("t-partial", streaming);
  stripSrc.classList.toggle("t-original", !streaming);
  const stripTranslation = latest?.translation ?? "";
  stripTr.textContent = stripTranslation;
  stripTr.classList.toggle("empty", stripTranslation === "");

  // #7 Capsule (one-line 44px pill, design/screens/04-capsule-mode.png): what it
  // shows is operator-configurable (#97) — caption (source), translation, or both.
  // Translation is the default (the value the user can't otherwise understand);
  // each mode falls back to the source when no translation exists yet (streaming,
  // pending, failed). The source rides along as a native tooltip.
  const capsuleLine = ((): string => {
    if (latest === null) return sessionRunning() ? "Listening…" : "LiveCap";
    const tr = latest.translation;
    switch (appSettings.capsuleContent) {
      case "caption":
        return latest.source;
      case "both":
        return tr !== "" ? `${latest.source} — ${tr}` : latest.source;
      case "translation":
      default:
        return tr !== "" ? tr : latest.source;
    }
  })();
  capsuleTxt.textContent = capsuleLine;
  capsuleTxt.title = latest?.source ?? "";
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
    <button class="card-x" title="Close" aria-label="Close">${ICONS.close}</button>
    <div class="card-label t-meta"></div>
    <div class="card-body"></div>
    <div class="card-actions">
      <button class="c-copy" title="Copy">⧉ Copy</button>
      ${intent !== undefined ? '<button class="c-again" title="Generate another">⟳ Another</button>' : ""}
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
  el.querySelector<HTMLButtonElement>(".card-x")?.addEventListener("click", () => {
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

/* ---- #80 analysis card: two sections (strategy + reply), copy/regenerate/dismiss ---- */

interface AnalysisCard {
  id: number;
  setPending: () => void;
  fill: (analysis: string, reply: string) => void;
  fail: (detail: string) => void;
}

const analysisCards = new Map<number, AnalysisCard>();

/** Build an inline analysis card (#80) under the feed: a strategy read +
 *  suggested reply, with copy (the reply), regenerate, and dismiss. Mirrors the
 *  reply-card chrome but renders two labelled sections. `onRegenerate` re-fires
 *  the analyze request for the same caption. */
function newAnalysisCard(targetSource: string, onRegenerate: () => void): AnalysisCard {
  requestCounter += 1;
  const id = requestCounter;
  const el = document.createElement("div");
  el.className = "card analysis-card fading-in";
  el.innerHTML = `
    <button class="card-x" title="Close" aria-label="Close">${ICONS.close}</button>
    <div class="card-label t-meta">✦ Analysis</div>
    <div class="card-target t-meta"></div>
    <div class="analysis-section">
      <div class="analysis-head t-meta">Strategy</div>
      <div class="analysis-strategy card-body"></div>
    </div>
    <div class="analysis-section">
      <div class="analysis-head t-meta">Suggested reply</div>
      <div class="analysis-reply card-body"></div>
    </div>
    <div class="card-actions">
      <button class="c-copy" title="Copy reply">⧉ Copy reply</button>
      <button class="c-again" title="Regenerate analysis">⟳ Regenerate</button>
    </div>
  `;
  const targetEl = el.querySelector<HTMLDivElement>(".card-target");
  if (targetEl) targetEl.textContent = targetSource;
  const strategyEl = el.querySelector<HTMLDivElement>(".analysis-strategy") as HTMLDivElement;
  const replyEl = el.querySelector<HTMLDivElement>(".analysis-reply") as HTMLDivElement;

  const card: AnalysisCard = {
    id,
    setPending: () => {
      strategyEl.textContent = "…";
      replyEl.textContent = "…";
    },
    fill: (analysis, reply) => {
      strategyEl.textContent = analysis !== "" ? analysis : "—";
      replyEl.textContent = reply !== "" ? reply : "—";
    },
    fail: (detail) => {
      strategyEl.textContent = `unavailable (${detail})`;
      replyEl.textContent = "";
    },
  };
  card.setPending();

  el.querySelector<HTMLButtonElement>(".c-copy")?.addEventListener("click", () => {
    void writeText(replyEl.textContent ?? "").then(
      () => showToast("Copied"),
      () => showToast("Copy failed"),
    );
  });
  el.querySelector<HTMLButtonElement>(".c-again")?.addEventListener("click", () => {
    card.setPending();
    onRegenerate();
  });
  el.querySelector<HTMLButtonElement>(".card-x")?.addEventListener("click", () => {
    analysisCards.delete(id);
    el.remove();
  });

  cardsEl.appendChild(el);
  requestAnimationFrame(() => el.classList.remove("fading-in"));
  analysisCards.set(id, card);
  return card;
}

/* ---- #81 review screen + #82 coaching tab (src/review.ts) ---- */

const reviewCallbacks: ReviewCallbacks = {
  requestCoaching: (ids) => {
    requestCounter += 1;
    const cardId = requestCounter;
    // Route a SYNCHRONOUS forward failure (e.g. the host request is rejected) to
    // the coaching card so it shows an error + retry instead of spinning forever
    // (#5). A successful forward resolves later via a "coaching"/"extrasFailed"
    // host event, which the host://event handler routes to the same card.
    void invoke("host_request", { message: { type: "coach", cardId, captionIds: ids } }).catch(
      (error: unknown) => {
        coachingCards.get(cardId)?.fail(String(error));
      },
    );
    return cardId;
  },
  copy: (text) =>
    void writeText(text).then(
      () => showToast("Copied"),
      () => showToast("Copy failed"),
    ),
  speak: speakBetter,
  close: () => {
    review.hide();
    // Closing the review returns the idle Panel to the Start screen (#1).
    render();
  },
};

const review: ReviewSurface = buildReview(reviewCallbacks);
$<HTMLDivElement>("review-mount").appendChild(review.el);

/** Route a coaching result/failure to its card (owned by the review surface). */
const coachingCards = {
  get: (id: number): CoachingCard | undefined => review.coachingCard(id),
};

/** Speak the rewrite aloud via the webview Web Speech API (#82). The meeting
 *  language is English (src/host/start-config.ts), so the voice is en-* — no
 *  macOS `say`, no Rust command. Silently no-ops where speech synthesis is
 *  unavailable. */
function speakBetter(text: string): void {
  if (text === "" || typeof window.speechSynthesis === "undefined") return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = MEETING_VOICE_LANG;
  const voice = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang.toLowerCase().startsWith("en"));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// Metrics arrive (HostOutbound "metrics") just before the archive path
// ("archived"); retain them so the review opens once the session has stopped.
let pendingMetrics: { talkRatioMic: number; smoothScore: number; micMs: number; systemMs: number } | null =
  null;

/** Open the post-meeting review screen (#81) with the retained summary/board +
 *  metrics + the session's own (mic) utterances. Called on session end. */
function openReview(talkRatioMic: number, smoothScore: number, micMs: number, systemMs: number): void {
  const utterances = feed.micUtterances().map((block) => ({
    id: block.id,
    source: block.source,
    time: block.epochMs !== null ? clockLabel(block.epochMs) : "",
  }));
  review.show({
    summary: latestSummary,
    board: latestBoard,
    talkRatioMic,
    smoothScore,
    micMs,
    systemMs,
    utterances,
    archivePath: latestArchivePath,
  });
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

// #54: 1 Hz render-state heartbeat at module top level — beats even if the
// async init below hangs or rejects, so a missing beat means the module
// itself never evaluated.
startUiHeartbeat(() => {
  const latest = feed.latest();
  return {
    mode: state.mode,
    feedBlocks: feed.blocks.length,
    domBlocks: feedEl.querySelectorAll(".cap").length,
    latestSource: latest?.source ?? "",
    latestTranslation: latest?.translation ?? "",
    capsuleText: capsuleTxt.textContent ?? "",
  };
});

void listen<CaptionBridgeEvent>("caption://event", (event) => {
  // #62: a suppressed mic utterance clears its orphaned streaming block instead
  // of finalizing — drop its DOM node and stop (it never entered translation).
  if (event.payload.type === "cleared") {
    const gone = feed.clearPartial(event.payload.channel);
    if (gone) {
      blockEls.get(gone.key)?.remove();
      blockEls.delete(gone.key);
      afterFeedChange(false);
    }
    return;
  }
  const block = feed.applyCaption(event.payload);
  const isNew = !blockEls.has(block.key);
  const el = blockEl(block);
  if (isNew) feedEl.appendChild(el);
  updateBlockEl(block);
  // #57: keep the DOM windowed — evicted blocks leave the feed (they remain
  // in the archive); scrolling above the window meets the history notice.
  for (const gone of feed.evictOverflow()) {
    blockEls.get(gone.key)?.remove();
    blockEls.delete(gone.key);
  }
  feedNote.classList.toggle("visible", feed.evictedCount > 0);
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
      latestSummary = message.summary;
      latestBoard = message.board;
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
    case "analysis": {
      analysisCards.get(message.cardId)?.fill(message.analysis, message.reply);
      break;
    }
    case "metrics":
      pendingMetrics = {
        talkRatioMic: message.talkRatioMic,
        smoothScore: message.smoothScore,
        micMs: message.micMs,
        systemMs: message.systemMs,
      };
      break;
    case "coaching": {
      coachingCards.get(message.cardId)?.fill(message.items);
      break;
    }
    case "extrasFailed": {
      // The id namespace is shared (requestCounter) across all on-demand cards,
      // so route the failure to whichever card kind owns it.
      const card = pendingCards.get(message.id);
      if (card) card.body.textContent = `unavailable (${message.detail})`;
      analysisCards.get(message.id)?.fail(message.detail);
      coachingCards.get(message.id)?.fail(message.detail);
      break;
    }
    case "silence":
      void promptSilenceStop(message.sinceMs);
      break;
    case "archived":
      latestArchivePath = message.path;
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
    case "gauge":
      settingsSheet.updateGauge(message.gauge);
      break;
    case "stopped":
      // Session end (#81): show the review screen with the retained summary/board,
      // the metrics that just arrived, and the session's own (mic) utterances.
      if (pendingMetrics) {
        openReview(
          pendingMetrics.talkRatioMic,
          pendingMetrics.smoothScore,
          pendingMetrics.micMs,
          pendingMetrics.systemMs,
        );
        pendingMetrics = null;
      }
      break;
    case "ready":
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
  // A new session is starting — dismiss the previous review screen so it never
  // overlaps the live feed.
  if ((phase === "starting" || phase === "live") && review.isOpen()) review.hide();
  render();
  syncMiniViews();
});

/* #53: channel config — seeded at session start, flipped by the mic toggle
   (panel button or tray); the button mirrors it either way. */
void listen<SessionChannels>("session://channels", (event) => {
  channels = event.payload;
  render();
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

/* dragging (#3): Rust follows the cursor and applies magnetic snapping. The
   drag must start ONLY from non-interactive "title region" surfaces and must
   never fight a control. The earlier guard only excluded `button, input`, so a
   native `<select>` (the Start/Settings language picker) started a drag and the
   `setPointerCapture` below stole the pointer stream from the OS — the native
   popup then closed/glitched the moment the cursor moved (the #3 root cause).
   Every form control + interactive container is excluded now, and the capture
   is taken only once a real drag is confirmed (never on a plain control click). */

/** Any native form control / editable / interactive container: never a drag
 *  origin (so its own pointer + native popup behavior is left untouched). */
const INTERACTIVE_SELECTOR =
  "button, input, select, textarea, option, a, [contenteditable], " +
  "#feed-wrap, #pinned, #cards, #chips, #composer, " +
  "#settings-sheet, #onboarding, #start-panel, #review-mount";

let dragStart: { x: number; y: number; t: number; pointerId: number; captured: boolean } | null = null;

glass.addEventListener("pointerdown", (e: PointerEvent) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  // Controls/interactive containers are interactive in EVERY mode — a native
  // popup (e.g. <select>) must keep the OS pointer stream, so never capture.
  if (target.closest(INTERACTIVE_SELECTOR)) return;
  dragStart = { x: e.screenX, y: e.screenY, t: Date.now(), pointerId: e.pointerId, captured: false };
});

// Capture + begin the Rust drag only once the pointer actually moves past a
// small threshold — a plain click on a non-control surface never captures, so
// it can't swallow events meant for anything that opened underneath.
const DRAG_THRESHOLD = 4;
glass.addEventListener("pointermove", (e: PointerEvent) => {
  if (!dragStart || dragStart.captured || e.pointerId !== dragStart.pointerId) return;
  if (Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y) < DRAG_THRESHOLD) return;
  dragStart.captured = true;
  glass.setPointerCapture(dragStart.pointerId);
  void invoke("begin_drag");
});

function finishDrag(e: PointerEvent): void {
  if (!dragStart) return;
  const { x, y, t, pointerId, captured } = dragStart;
  dragStart = null;
  if (captured) {
    if (glass.hasPointerCapture(pointerId)) glass.releasePointerCapture(pointerId);
    void invoke("end_drag");
  }
  const moved = Math.hypot(e.screenX - x, e.screenY - y);
  const quick = Date.now() - t < 300;
  // §8.1: a click (not a drag) on the Capsule opens the Panel.
  if (state.mode === "capsule" && moved < DRAG_THRESHOLD && quick) {
    void invoke("set_mode", { mode: "panel" });
  }
}

glass.addEventListener("pointerup", finishDrag);
glass.addEventListener("pointercancel", finishDrag);

btnPin.addEventListener("click", () => {
  void invoke("set_pinned", { pinned: !state.pinned });
});
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
  settingsSheet.syncShell();
});

/* tray "Settings…" → the sheet opens inside the Panel (#12) */
void listen("shell://settings", () => {
  if (!onboardingEl.classList.contains("active")) settingsSheet.open();
});

/* settings changed elsewhere (sanitized echo): keep the cache + feed live */
void listen<AppSettings>("settings://changed", (event) => {
  appSettings = event.payload;
  applyCaptionSize(appSettings.captionSize);
});

void listen<ChromePayload>("shell://chrome", (event) => {
  // Click-through edge zone regained interactivity: surface the controls.
  if (event.payload.interactive) showChrome();
});

/* ================= initial state ================= */

// Boot WITHOUT gating the first paint on any backend command (#65): the window
// renders defaults immediately, then each piece of state is applied as its
// invoke resolves. A session start wedged on a stalled model download (which
// once held the `session_phase` query) can no longer leave the window blank.
let bootCapabilities: Capabilities | null = null;
let bootSettings: AppSettings | null = null;
let onboardingDecided = false;

// First run (§8.6): the three onboarding cards, then straight into a session.
// Needs BOTH capabilities and settings, so it runs once both have arrived.
function maybeStartOnboarding(): void {
  if (onboardingDecided || bootCapabilities === null || bootSettings === null) return;
  onboardingDecided = true;
  if (bootCapabilities.settings && !bootSettings.onboardingComplete) {
    startOnboarding({
      host: onboardingEl,
      settings: appSettings,
      onDone: ({ targetLanguage, engine }) => {
        // #1: onboarding seeds the first language default (#2) and lands on the
        // idle Start screen — it no longer auto-starts a session. The user
        // presses Start (here or the tray) when ready.
        // The app boots unpinned during onboarding so the overlay can't cover
        // the macOS permission sheets; now that setup is done, restore the saved
        // pin preference.
        void invoke("reapply_pin").catch(() => undefined);
        void persistSettings({
          ...appSettings,
          targetLanguage,
          engine,
          onboardingComplete: true,
        }).then(
          () => render(),
          (error: unknown) => showToast(String(error)),
        );
      },
    });
  }
}

bootstrap(
  {
    shellState: () => invoke<ShellState>("get_shell_state"),
    capabilities: () => invoke<Capabilities>("capabilities"),
    phase: () => invoke<SessionStatus["phase"]>("session_phase"),
    settings: () => invoke<AppSettings>("get_settings"),
    channels: () => invoke<SessionChannels>("session_channels"),
  },
  {
    applyShellState: (shellState) => Object.assign(state, shellState),
    applyCapabilities: (caps) => {
      capabilities = caps;
      bootCapabilities = caps;
      maybeStartOnboarding();
    },
    applyPhase: (initialPhase) => {
      phase = initialPhase;
    },
    applySettings: (settings) => {
      appSettings = settings;
      bootSettings = settings;
      applyCaptionSize(settings.captionSize);
      maybeStartOnboarding();
    },
    applyChannels: (initialChannels) => {
      channels = initialChannels;
    },
    render: () => {
      render();
      syncMiniViews();
    },
    onError: () => {
      // A command failed to answer — keep the already-painted defaults; the live
      // event streams (session://status, etc.) will correct state as it changes.
    },
  },
);
