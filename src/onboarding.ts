// First-run onboarding (#12, PROPOSAL §8.6, design/screens/06-onboarding.png):
// two cards, under a minute — audio access (real TCC prompts) and engine.
// Target language is NOT chosen here: it's a per-session pick on the idle Start
// screen (#2), so onboarding no longer duplicates it. Shown when
// settings.onboardingComplete is false; ends by persisting the engine choice
// and landing on the idle Start screen (#1 — the user presses Start when ready;
// onboarding never auto-starts a session). Never a dead end: every step can
// continue regardless of what was granted/detected.

import { invoke } from "@tauri-apps/api/core";

import type { AppSettings, EnginePref } from "./app-settings";
import { DEFAULT_LANGUAGE_CODE } from "./languages";
import type { ProbeResult } from "./protocol";

// #168 tri-state: system audio is "granted" only on a positive signal (real
// audio off the tap). "unknown" means granted-vs-quiet could not be told apart,
// "denied" that no tap exists at all — both need remediation, and a denial is
// never rendered as granted.
type SystemAudioStatus = "granted" | "denied" | "unknown";

interface AudioAccess {
  mic: string;
  systemAudio: SystemAudioStatus;
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
  // Language is picked per-session on the Start screen (#2); onboarding just
  // carries the existing default through untouched.
  const targetLanguage = settings.targetLanguage || DEFAULT_LANGUAGE_CODE;
  let engine: EnginePref = "cli";
  let cliFound = false;

  host.innerHTML = `
    <div class="ob-card" data-step="1">
      <div class="ob-step">1 · AUDIO</div>
      <h2 class="ob-title">LiveCap hears two things</h2>
      <div class="ob-row"><span class="ob-ico">🔊</span> What you hear — system audio <span class="ob-status" id="ob-sys-status"></span></div>
      <div class="ob-row"><span class="ob-ico">🎤</span> What you say — microphone <span class="ob-status" id="ob-mic-status"></span></div>
      <p class="ob-note" id="ob-sys-hint" hidden></p>
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
      <div class="ob-step">2 · ENGINE</div>
      <h2 class="ob-title" id="ob-engine-title">Checking for the Claude CLI…</h2>
      <p class="ob-note" id="ob-engine-body"></p>
      <p class="ob-note ob-alt" id="ob-engine-alt"></p>
      <div class="ob-actions">
        <button class="ob-primary" id="ob-start" disabled>Finish setup</button>
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
  const sysHint = el<HTMLParagraphElement>(host, "#ob-sys-hint");

  let systemStatus: SystemAudioStatus | null = null;

  function renderMic(status: string): void {
    micStatus.textContent =
      status === "granted" ? "✓" : status === "denied" || status === "restricted" ? "✕ no access" : "";
    micStatus.classList.toggle("ok", status === "granted");
    if (status === "denied" || status === "restricted") openSys.hidden = false;
  }

  // Called only with a probed verdict. Anything but "granted" — including the
  // ambiguous "unknown" — shows the remediation path (#168): before, a denial
  // rendered as ✓ and this branch was unreachable.
  function renderSystem(status: SystemAudioStatus): void {
    systemStatus = status;
    const granted = status === "granted";
    sysStatus.textContent = granted ? "✓" : status === "denied" ? "✕ no access" : "⚠ not confirmed";
    sysStatus.classList.toggle("ok", granted);
    sysHint.hidden = granted;
    sysHint.textContent = granted
      ? ""
      : status === "denied"
        ? "No system audio. Turn on “System Audio Recording” for LiveCap in System Settings, then check again."
        : "Couldn’t confirm system audio — the tap heard only silence, which looks the same as no access. Play some audio and check again, or turn on “System Audio Recording” for LiveCap.";
    if (granted) {
      recheck.hidden = true;
    } else {
      openSys.hidden = false;
      recheck.hidden = false;
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
        renderSystem(access.systemAudio);
        if (access.mic === "undetermined") pollMic(); // TCC sheet still up
        grantBtn.textContent = "Grant audio access";
        grantBtn.disabled = access.mic === "granted" && access.systemAudio === "granted";
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
    const section = systemStatus === "granted" ? "microphone" : "system-audio";
    void invoke("open_privacy_settings", { section });
    recheck.hidden = false;
  });

  recheck.addEventListener("click", () => {
    void invoke<SystemAudioStatus>("probe_system_audio").then(renderSystem, () => undefined);
    void invoke<string>("mic_permission_status").then(renderMic, () => undefined);
  });

  next1.addEventListener("click", () => {
    show(2);
    void probeEngine();
  });

  /* ---- step 2: engine (real CLI detection — never a dead end) ---- */

  const engineTitle = el<HTMLHeadingElement>(host, "#ob-engine-title");
  const engineBody = el<HTMLParagraphElement>(host, "#ob-engine-body");
  const engineAlt = el<HTMLParagraphElement>(host, "#ob-engine-alt");
  const engineToggle = el<HTMLButtonElement>(host, "#ob-engine-toggle");
  const startBtn = el<HTMLButtonElement>(host, "#ob-start");

  function renderEngine(): void {
    if (cliFound && engine === "cli") {
      engineTitle.textContent = "✓ Claude CLI found";
      // #4: no "uses your plan's SDK credits / N hrs" — in real use the
      // subscription covers CLI usage today; LiveCap only watches for a policy
      // change and falls back to the free local model if usage ever starts to
      // draw on Agent SDK credits.
      engineBody.textContent =
        "Signed in on your plan — covered by your Claude subscription. If Anthropic's policy changes, LiveCap falls back to the free local model automatically.";
      engineAlt.textContent = "";
      engineToggle.hidden = false;
      engineToggle.textContent = "Use the local model instead — free, 2.4 GB download";
    } else if (cliFound) {
      engineTitle.textContent = "Use the local model";
      engineBody.textContent = "Local model (Qwen3 4B, 2.4 GB) — free, downloads on first use. Everything stays on this Mac.";
      engineAlt.textContent = "";
      engineToggle.hidden = false;
      engineToggle.textContent = "Use the Claude CLI instead — covered by your plan";
    } else {
      engineTitle.textContent = "Use the local model";
      engineBody.textContent = "Local model (Qwen3 4B, 2.4 GB) — free, downloads on first use. Everything stays on this Mac.";
      engineAlt.textContent = "No Claude CLI found — install and sign in to `claude` to translate with your Claude plan instead.";
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
