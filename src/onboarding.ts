// First-run onboarding (#12, PROPOSAL §8.6, design/screens/06-onboarding.png):
// three cards, under a minute — audio access (real TCC prompts), target
// language, engine. Shown when settings.onboardingComplete is false; ends by
// persisting the choices and starting a session. Never a dead end: every step
// can continue regardless of what was granted or detected.

import { invoke } from "@tauri-apps/api/core";

import { estimatedHoursPerMonth, type AppSettings, type EnginePref } from "./app-settings";
import { DEFAULT_LANGUAGE_CODE, LANGUAGES } from "./languages";
import type { ProbeResult } from "./protocol";

interface AudioAccess {
  mic: string;
  systemAudio: boolean;
}

export interface OnboardingOptions {
  host: HTMLElement;
  settings: AppSettings;
  /** Persist + start captioning. */
  onDone: (choices: { targetLanguage: string; engine: EnginePref }) => void;
}

const MIC_POLL_MS = 1000;
const MIC_POLL_LIMIT = 30;

function el<T extends HTMLElement>(root: ParentNode, selector: string): T {
  return root.querySelector(selector) as T;
}

export function startOnboarding(options: OnboardingOptions): void {
  const { host, settings } = options;
  let targetLanguage = settings.targetLanguage || DEFAULT_LANGUAGE_CODE;
  let engine: EnginePref = "cli";
  let cliFound = false;

  const languageChoices = LANGUAGES.map(
    (l) => `<option value="${l.code}"${l.code === targetLanguage ? " selected" : ""}>${l.native}</option>`,
  ).join("");

  host.innerHTML = `
    <div class="ob-card" data-step="1">
      <div class="ob-step">1 · AUDIO</div>
      <h2 class="ob-title">LiveCap hears two things</h2>
      <div class="ob-row"><span class="ob-ico">🔊</span> What you hear — system audio <span class="ob-status" id="ob-sys-status"></span></div>
      <div class="ob-row"><span class="ob-ico">🎤</span> What you say — microphone <span class="ob-status" id="ob-mic-status"></span></div>
      <p class="ob-note">Both stay on this Mac. Nothing is uploaded.</p>
      <div class="ob-links">
        <button class="ob-link" id="ob-open-sys" hidden>Open System Settings</button>
        <button class="ob-link" id="ob-recheck" hidden>Check again</button>
      </div>
      <div class="ob-actions">
        <button class="ob-primary" id="ob-grant">Grant audio access</button>
        <button class="ob-secondary" id="ob-next1" hidden>Continue</button>
      </div>
    </div>
    <div class="ob-card" data-step="2" hidden>
      <div class="ob-step">2 · LANGUAGE</div>
      <h2 class="ob-title">Translate into…</h2>
      <select class="ob-select" id="ob-lang">${languageChoices}</select>
      <p class="ob-note">Spoken language is detected automatically — there is no source language to pick.</p>
      <div class="ob-actions">
        <button class="ob-primary" id="ob-next2">Continue</button>
      </div>
    </div>
    <div class="ob-card" data-step="3" hidden>
      <div class="ob-step">3 · ENGINE</div>
      <h2 class="ob-title" id="ob-engine-title">Checking for the Claude CLI…</h2>
      <p class="ob-note" id="ob-engine-body"></p>
      <p class="ob-note ob-alt" id="ob-engine-alt"></p>
      <div class="ob-actions">
        <button class="ob-primary" id="ob-start" disabled>Start captioning</button>
        <button class="ob-link" id="ob-engine-toggle" hidden></button>
      </div>
    </div>
  `;
  host.classList.add("active");

  const cards = Array.from(host.querySelectorAll<HTMLElement>(".ob-card"));
  const show = (step: number): void => {
    for (const card of cards) card.hidden = card.dataset.step !== String(step);
  };

  /* ---- step 1: audio (real TCC prompts via transient captures) ---- */

  const micStatus = el<HTMLSpanElement>(host, "#ob-mic-status");
  const sysStatus = el<HTMLSpanElement>(host, "#ob-sys-status");
  const grantBtn = el<HTMLButtonElement>(host, "#ob-grant");
  const next1 = el<HTMLButtonElement>(host, "#ob-next1");
  const openSys = el<HTMLButtonElement>(host, "#ob-open-sys");
  const recheck = el<HTMLButtonElement>(host, "#ob-recheck");

  let systemGranted = false;

  function renderMic(status: string): void {
    micStatus.textContent =
      status === "granted" ? "✓" : status === "denied" || status === "restricted" ? "✕ no access" : "";
    micStatus.classList.toggle("ok", status === "granted");
    if (status === "denied" || status === "restricted") openSys.hidden = false;
  }

  function renderSystem(granted: boolean, probed: boolean): void {
    systemGranted = granted;
    sysStatus.textContent = granted ? "✓" : probed ? "✕ no access" : "";
    sysStatus.classList.toggle("ok", granted);
    if (probed && !granted) {
      openSys.hidden = false;
      recheck.hidden = false;
    } else if (granted) {
      recheck.hidden = true;
    }
  }

  // Passive pre-check: a returning user with mic already granted sees ✓
  // before touching anything (live status where macOS allows it).
  void invoke<string>("mic_permission_status").then(renderMic, () => undefined);

  let polls = 0;
  function pollMic(): void {
    polls += 1;
    void invoke<string>("mic_permission_status").then((status) => {
      renderMic(status);
      if (status === "undetermined" && polls < MIC_POLL_LIMIT) setTimeout(pollMic, MIC_POLL_MS);
    }, () => undefined);
  }

  grantBtn.addEventListener("click", () => {
    grantBtn.disabled = true;
    grantBtn.textContent = "Requesting…";
    void invoke<AudioAccess>("request_audio_access").then(
      (access) => {
        renderMic(access.mic);
        renderSystem(access.systemAudio, true);
        if (access.mic === "undetermined") pollMic(); // TCC sheet still up
        grantBtn.textContent = "Grant audio access";
        grantBtn.disabled = access.mic === "granted" && access.systemAudio;
        next1.hidden = false; // never a dead end
      },
      () => {
        grantBtn.textContent = "Grant audio access";
        grantBtn.disabled = false;
        next1.hidden = false;
      },
    );
  });

  openSys.addEventListener("click", () => {
    const section = systemGranted ? "microphone" : "system-audio";
    void invoke("open_privacy_settings", { section });
    recheck.hidden = false;
  });

  recheck.addEventListener("click", () => {
    void invoke<boolean>("probe_system_audio").then((granted) => renderSystem(granted, true), () => undefined);
    void invoke<string>("mic_permission_status").then(renderMic, () => undefined);
  });

  next1.addEventListener("click", () => show(2));

  /* ---- step 2: target language ---- */

  const langSelect = el<HTMLSelectElement>(host, "#ob-lang");
  el<HTMLButtonElement>(host, "#ob-next2").addEventListener("click", () => {
    targetLanguage = langSelect.value;
    show(3);
    void probeEngine();
  });

  /* ---- step 3: engine (real CLI detection — never a dead end) ---- */

  const engineTitle = el<HTMLHeadingElement>(host, "#ob-engine-title");
  const engineBody = el<HTMLParagraphElement>(host, "#ob-engine-body");
  const engineAlt = el<HTMLParagraphElement>(host, "#ob-engine-alt");
  const engineToggle = el<HTMLButtonElement>(host, "#ob-engine-toggle");
  const startBtn = el<HTMLButtonElement>(host, "#ob-start");

  function renderEngine(): void {
    const hours = estimatedHoursPerMonth(settings.poolUsd);
    if (cliFound && engine === "cli") {
      engineTitle.textContent = "✓ Claude CLI found";
      engineBody.innerHTML = `Signed in on your plan. Meetings use your plan's SDK credits — about <b>${hours} hrs/month</b>.`;
      engineAlt.textContent = "";
      engineToggle.hidden = false;
      engineToggle.textContent = "Use the local model instead — free, 2.4 GB download";
    } else if (cliFound) {
      engineTitle.textContent = "Use the local model";
      engineBody.textContent = "Local model (Qwen3 4B, 2.4 GB) — free, downloads on first use. Everything stays on this Mac.";
      engineAlt.textContent = "";
      engineToggle.hidden = false;
      engineToggle.textContent = `Use the Claude CLI instead — your plan's credits, ≈ ${hours} hrs/month`;
    } else {
      engineTitle.textContent = "Use the local model";
      engineBody.textContent = "Local model (Qwen3 4B, 2.4 GB) — free, downloads on first use. Everything stays on this Mac.";
      engineAlt.textContent = "No Claude CLI found — install and sign in to `claude` to use your plan's SDK credits instead.";
      engineToggle.hidden = true;
    }
    startBtn.disabled = false;
  }

  async function probeEngine(): Promise<void> {
    try {
      const probe = await invoke<ProbeResult>("host_probe");
      cliFound = probe.cli !== null;
    } catch {
      cliFound = false;
    }
    engine = cliFound ? "cli" : "local";
    renderEngine();
  }

  engineToggle.addEventListener("click", () => {
    engine = engine === "cli" ? "local" : "cli";
    renderEngine();
  });

  startBtn.addEventListener("click", () => {
    host.classList.remove("active");
    host.replaceChildren();
    options.onDone({ targetLanguage, engine });
  });

  show(1);
}
