// Settings sheet (#12, PROPOSAL §8.7, design/screens/07-settings.png):
// rendered as a sheet INSIDE the Panel window over the same glass — no
// separate window. Every change persists immediately (set_settings → atomic
// settings.json) and applies live where the running surface allows it.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import {
  applyCaptionSize,
  CLAUDE_MODELS,
  sanitizedTranslationMode,
  TRANSLATION_MODES,
  claudeModelLabel,
  gaugeAmountLabel,
  nextResetLabel,
  POOL_PRESETS,
  sanitizedClaudeModel,
  sanitizedSttModel,
  STT_MODELS,
  type AppSettings,
  type CaptionSize,
  type CapsuleContent,
  type EnginePref,
} from "./app-settings";
import { LANGUAGES, SOURCE_LANGUAGES, languageByCode } from "./languages";
import type { GaugeWire, ProbeResult } from "./protocol";

export interface SettingsSheetOptions {
  host: HTMLElement;
  getSettings: () => AppSettings;
  /** Persist via set_settings and update main's cached copy. */
  applySettings: (settings: AppSettings) => Promise<AppSettings>;
  getClickThrough: () => boolean;
  setClickThrough: (enabled: boolean) => void;
}

export interface SettingsSheet {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** Push a live gauge update (host://event) into the sheet. */
  updateGauge: (gauge: GaugeWire) => void;
  /** Re-sync rows that mirror shell state (click-through). */
  syncShell: () => void;
}

function el<T extends HTMLElement>(root: ParentNode, selector: string): T {
  return root.querySelector(selector) as T;
}

export function createSettingsSheet(options: SettingsSheetOptions): SettingsSheet {
  const { host } = options;
  let lastGauge: GaugeWire | null = null;

  const languageChoices = LANGUAGES.map((l) => `<option value="${l.code}">${l.native}</option>`).join("");
  const sourceChoices = SOURCE_LANGUAGES.map(
    (l) => `<option value="${l.code}">${l.native}</option>`,
  ).join("");
  const presetChoices =
    POOL_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("") +
    '<option value="custom">Custom…</option>';
  // #110: whisper model picker — same segmented control as the engine picker.
  const sttChoices = STT_MODELS.map(
    (m) =>
      `<button class="sh-seg-btn" data-stt="${m.value}">${m.label} · ${m.size}${
        m.note ? ` · ${m.note}` : ""
      }</button>`,
  ).join("");
  // #195: translation cadence. The note carries the MEASURED cost per speech
  // condition — the multiplier genuinely depends on how the speaker talks, so a
  // single number would be wrong in one direction or the other.
  const cadenceChoices = TRANSLATION_MODES.map(
    (m) => `<button class="sh-seg-btn" data-cadence="${m.value}">${m.label} · ${m.note}</button>`,
  ).join("");
  // #203: Claude model picker — same segmented control as the engine and STT
  // pickers. Nothing downloads; the note carries the plan-budget trade-off.
  const claudeChoices = CLAUDE_MODELS.map(
    (m) => `<button class="sh-seg-btn" data-claude="${m.value}">${m.label} · ${m.note}</button>`,
  ).join("");

  host.innerHTML = `
    <div class="sh-head">
      <span class="sh-title">SETTINGS</span>
      <button class="sh-close" id="sh-close" aria-label="Close settings">✕</button>
    </div>
    <div class="sh-scroll">
      <div class="sh-section">Engine</div>
      <div class="sh-seg" role="radiogroup" aria-label="Translation engine">
        <!-- #203: the model half of this label is set in renderControls from the
             actual pick (it used to hard-code "Haiku"). -->
        <button class="sh-seg-btn" data-engine="cli" id="sh-engine-cli">Claude CLI</button>
        <!-- #204: hidden entirely unless a codex binary is present. -->
        <button class="sh-seg-btn" data-engine="codex" id="sh-engine-codex" hidden>Codex</button>
        <button class="sh-seg-btn" data-engine="local">Local · Qwen 4B</button>
      </div>
      <!-- #204: the quota cost is stated in the picker itself, not a tooltip.
           The hours figure is measured, and deliberately not rounded up. -->
      <div class="sh-engine-note t-meta" id="sh-codex-note" hidden>
        Codex runs on your own Codex/ChatGPT account and spends that plan's
        quota — measured at roughly 4–7 hours of captioning per week on the plan
        we tested, less on a smaller one. LiveCap never sees your Codex login.
        When the quota runs low it falls back to the free local model.
      </div>
      <div class="sh-seg" role="radiogroup" aria-label="Claude model">${claudeChoices}</div>
      <div class="sh-engine-note t-meta">
        Claude CLI usage is currently covered by your Claude subscription. If
        Anthropic's policy changes so it draws on Agent SDK credits, LiveCap
        falls back to the free local model automatically. A heavier model spends
        that budget faster — nothing extra is downloaded, and the fall-back
        switch below still applies. Applies at the next session start.
      </div>
      <div class="sh-section">Translation speed</div>
      <div class="sh-seg" role="radiogroup" aria-label="Translation speed">${cadenceChoices}</div>
      <div class="sh-engine-note t-meta">
        A faster step sends more translation requests, so it reaches the
        fall-back threshold sooner — the "fall back to Local" switch below still
        catches it. Applies at the next session start.
      </div>
      <div class="sh-gauge">
        <span class="sh-gauge-label t-meta">Usage this month</span>
        <div class="sh-gauge-bar"><div class="sh-gauge-fill" id="sh-gauge-fill"></div></div>
        <span class="sh-gauge-amount" id="sh-gauge-amount">—</span>
      </div>
      <div class="sh-gauge-meta t-meta" id="sh-gauge-meta"></div>
      <label class="sh-check"><input type="checkbox" id="sh-autoswitch" /> Fall back to Local if credits ever start to apply</label>
      <div class="sh-row">
        <span class="sh-row-label">Plan</span>
        <select class="sh-select" id="sh-plan" aria-label="Credit pool size">${presetChoices}</select>
        <input class="sh-num" id="sh-pool" type="number" min="1" step="1" aria-label="Custom pool (USD)" hidden />
        <span class="sh-row-label sh-right">resets day</span>
        <input class="sh-num" id="sh-resetday" type="number" min="1" max="28" step="1" aria-label="Billing reset day" />
      </div>

      <div class="sh-section">Language</div>
      <div class="sh-row">
        <span class="sh-row-label">Spoken</span>
        <select class="sh-select" id="sh-source" aria-label="Spoken (source) language">${sourceChoices}</select>
      </div>
      <div class="sh-row">
        <span class="sh-row-label">Translate into</span>
        <select class="sh-select" id="sh-lang" aria-label="Target language">${languageChoices}</select>
      </div>

      <div class="sh-section">Transcription</div>
      <div class="sh-seg" role="radiogroup" aria-label="Transcription model">${sttChoices}</div>
      <div class="sh-channels-note t-meta">
        Small is the default; Large v3 Turbo has the best accuracy (provisional).
        Applies at the next session start — first use downloads the model, and a
        failed download falls back to Small.
      </div>

      <div class="sh-section">Captions</div>
      <div class="sh-row">
        <span class="sh-row-label">Size</span>
        <span class="sh-sizes">
          <button class="sh-size" data-size="s" style="font-size:11px">Aa</button>
          <button class="sh-size" data-size="m" style="font-size:13px">Aa</button>
          <button class="sh-size" data-size="l" style="font-size:15px">Aa</button>
        </span>
        <label class="sh-check sh-right"><input type="checkbox" id="sh-clickthrough" /> Click-through (Strip/Capsule)</label>
      </div>
      <div class="sh-row">
        <span class="sh-row-label">Capsule shows</span>
        <span class="sh-sizes">
          <button class="sh-capsule" data-capsule="caption">Caption</button>
          <button class="sh-capsule" data-capsule="translation">Translation</button>
          <button class="sh-capsule" data-capsule="both">Both</button>
        </span>
      </div>

      <div class="sh-section">Channels</div>
      <label class="sh-check"><input type="checkbox" id="sh-cap-system" /> Capture system audio (them)</label>
      <label class="sh-check"><input type="checkbox" id="sh-cap-mic" /> Capture microphone (me)</label>
      <div class="sh-channels-note t-meta">Applies at the next session start — at least one channel stays on.</div>

      <div class="sh-section">Archive</div>
      <label class="sh-check"><input type="checkbox" id="sh-autosave" /> Auto-save transcripts</label>
      <div class="sh-row">
        <span class="sh-row-label">Folder</span>
        <button class="sh-folder" id="sh-folder"></button>
        <select class="sh-select sh-right" id="sh-retention" aria-label="Retention">
          <option value="0">keep forever</option>
          <option value="90">keep 90 days</option>
          <option value="30">keep 30 days</option>
        </select>
      </div>

      <div class="sh-section">Privacy</div>
      <div class="sh-priv" id="sh-priv-capture"><span class="sh-priv-mark">✓</span> Hidden from screen sharing</div>
      <div class="sh-priv"><span class="sh-priv-mark">✓</span> Audio never leaves this Mac</div>

      <div class="sh-section">Hotkeys</div>
      <div class="sh-row sh-hotkeys">
        <span>Show / hide <kbd>⌥ Space</kbd></span>
        <span class="sh-right">Mode <kbd>⌥⇧ Space</kbd></span>
      </div>
    </div>
  `;

  const segButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sh-seg-btn[data-engine]"));
  const sttButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sh-seg-btn[data-stt]"));
  const claudeButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sh-seg-btn[data-claude]"));
  const engineCliBtn = el<HTMLButtonElement>(host, "#sh-engine-cli");
  const engineCodexBtn = el<HTMLButtonElement>(host, "#sh-engine-codex");
  const codexNote = el<HTMLDivElement>(host, "#sh-codex-note");
  const cadenceButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sh-seg-btn[data-cadence]"));
  const sizeButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sh-size"));
  const capsuleButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sh-capsule"));
  const gaugeFill = el<HTMLDivElement>(host, "#sh-gauge-fill");
  const gaugeAmount = el<HTMLSpanElement>(host, "#sh-gauge-amount");
  const gaugeMeta = el<HTMLDivElement>(host, "#sh-gauge-meta");
  const autoSwitch = el<HTMLInputElement>(host, "#sh-autoswitch");
  const planSelect = el<HTMLSelectElement>(host, "#sh-plan");
  const poolInput = el<HTMLInputElement>(host, "#sh-pool");
  const resetDayInput = el<HTMLInputElement>(host, "#sh-resetday");
  const langSelect = el<HTMLSelectElement>(host, "#sh-lang");
  const sourceSelect = el<HTMLSelectElement>(host, "#sh-source");
  const clickThrough = el<HTMLInputElement>(host, "#sh-clickthrough");
  const captureSystem = el<HTMLInputElement>(host, "#sh-cap-system");
  const captureMic = el<HTMLInputElement>(host, "#sh-cap-mic");
  const autoSave = el<HTMLInputElement>(host, "#sh-autosave");
  const folderBtn = el<HTMLButtonElement>(host, "#sh-folder");
  const retentionSelect = el<HTMLSelectElement>(host, "#sh-retention");
  const privCapture = el<HTMLDivElement>(host, "#sh-priv-capture");

  /* ---- rendering ---- */

  function presetIdFor(poolUsd: number): string {
    return POOL_PRESETS.find((p) => p.usd === poolUsd)?.id ?? "custom";
  }

  function renderControls(): void {
    const s = options.getSettings();
    for (const btn of segButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.engine === s.engine));
    }
    autoSwitch.checked = s.autoSwitch;
    const preset = presetIdFor(s.poolUsd);
    planSelect.value = preset;
    poolInput.hidden = preset !== "custom";
    poolInput.value = String(s.poolUsd);
    resetDayInput.value = String(s.resetDay);
    const lang = languageByCode(s.targetLanguage);
    if (LANGUAGES.some((l) => l.code === lang.code)) langSelect.value = lang.code;
    // #94: spoken/source language ("auto" or a curated code).
    if (SOURCE_LANGUAGES.some((l) => l.code === s.sourceLanguage)) {
      sourceSelect.value = s.sourceLanguage;
    }
    // #110: whisper model pick; absent/unknown (old settings.json) shows Small.
    const sttModel = sanitizedSttModel(s.sttModel);
    for (const btn of sttButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.stt === sttModel));
    }
    // #203: the engine button names the model actually selected, and the picker
    // marks it pressed. textContent, not markup — the value came off disk.
    const claudeModel = sanitizedClaudeModel(s.claudeModel);
    engineCliBtn.textContent = `Claude CLI · ${claudeModelLabel(claudeModel)}`;
    for (const btn of claudeButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.claude === claudeModel));
    }
    // #195: cadence; an unknown persisted value shows Relaxed, matching the clamp.
    const cadence = sanitizedTranslationMode(s.translationMode);
    for (const btn of cadenceButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.cadence === cadence));
    }
    for (const btn of sizeButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.size === s.captionSize));
    }
    for (const btn of capsuleButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.capsule === s.capsuleContent));
    }
    clickThrough.checked = options.getClickThrough();
    // #53: the last enabled channel locks so a session always has one.
    captureSystem.checked = s.captureSystem;
    captureMic.checked = s.captureMic;
    captureSystem.disabled = s.captureSystem && !s.captureMic;
    captureMic.disabled = s.captureMic && !s.captureSystem;
    autoSave.checked = s.archiveAutoSave;
    folderBtn.textContent = s.archiveFolder ?? "~/Documents/LiveCap";
    retentionSelect.value = String(s.archiveRetentionDays);
    renderGauge();
  }

  function renderGauge(): void {
    const s = options.getSettings();
    const spent = lastGauge?.spentUsd ?? 0;
    const pool = lastGauge?.poolUsd ?? s.poolUsd;
    // #204: prefer the engine-tagged detail over the USD figures. On a
    // quota-metered tier the dollars are structurally meaningless — not merely
    // zero — so rendering "$0.00 / $20.00" with an empty bar would tell the
    // user their budget is untouched for an entire session while the real
    // constraint sits in nativeDetail. The USD string is itself the Claude
    // tier's nativeDetail, so both tiers go through one path.
    const detail = lastGauge?.nativeDetail;
    gaugeAmount.textContent = detail ?? gaugeAmountLabel(spent, pool);
    // Unknown headroom shows no fill rather than an empty bar implying a full
    // allowance; the amount line already says "usage unknown".
    const fraction =
      lastGauge?.headroomKnown === false
        ? 0
        : (lastGauge?.fractionUsed ?? (pool > 0 ? Math.min(1, spent / pool) : 1));
    gaugeFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    // #4: the gauge is an OPTIONAL usage indicator that is only meaningful IF
    // Agent SDK credits ever start applying — it is not a live charge meter
    // today, so don't lead with cost/"hours left". State the conditional plainly.
    gaugeMeta.textContent = `Tracked in case credits ever apply · would reset ${nextResetLabel(
      s.resetDay,
      new Date(),
    )}`;
  }

  /* ---- persistence ---- */

  function save(update: Partial<AppSettings>): void {
    const next = { ...options.getSettings(), ...update };
    void options.applySettings(next).then(renderControls, renderControls);
  }

  /* ---- wiring ---- */

  for (const btn of segButtons) {
    btn.addEventListener("click", () => save({ engine: btn.dataset.engine as EnginePref }));
  }
  autoSwitch.addEventListener("change", () => save({ autoSwitch: autoSwitch.checked }));
  planSelect.addEventListener("change", () => {
    const preset = POOL_PRESETS.find((p) => p.id === planSelect.value);
    if (preset) {
      save({ poolUsd: preset.usd });
    } else {
      poolInput.hidden = false;
      poolInput.focus();
    }
  });
  poolInput.addEventListener("change", () => {
    const usd = Number(poolInput.value);
    if (Number.isFinite(usd) && usd > 0) save({ poolUsd: usd });
  });
  resetDayInput.addEventListener("change", () => {
    const day = Number(resetDayInput.value);
    if (Number.isFinite(day)) save({ resetDay: Math.min(28, Math.max(1, Math.floor(day))) });
  });
  langSelect.addEventListener("change", () => save({ targetLanguage: langSelect.value }));
  // #94: spoken/source language; applies at the next session start.
  sourceSelect.addEventListener("change", () => save({ sourceLanguage: sourceSelect.value }));
  // #110: whisper model; downloads (with progress) at the next session start.
  for (const btn of sttButtons) {
    btn.addEventListener("click", () => save({ sttModel: btn.dataset.stt as string }));
  }
  // #195: translation cadence; applies at the next session start.
  for (const btn of cadenceButtons) {
    btn.addEventListener("click", () => save({ translationMode: btn.dataset.cadence as string }));
  }
  // #203: Claude model; reaches `--model` at the next session start.
  for (const btn of claudeButtons) {
    btn.addEventListener("click", () => save({ claudeModel: btn.dataset.claude as string }));
  }
  for (const btn of sizeButtons) {
    btn.addEventListener("click", () => {
      const size = btn.dataset.size as CaptionSize;
      applyCaptionSize(size); // applies to the live feed immediately
      save({ captionSize: size });
    });
  }
  for (const btn of capsuleButtons) {
    btn.addEventListener("click", () => {
      save({ capsuleContent: btn.dataset.capsule as CapsuleContent });
    });
  }
  clickThrough.addEventListener("change", () => options.setClickThrough(clickThrough.checked));
  captureSystem.addEventListener("change", () => {
    // Belt-and-braces with the disabled lock: never persist both-off.
    if (!captureSystem.checked && !options.getSettings().captureMic) {
      captureSystem.checked = true;
      return;
    }
    save({ captureSystem: captureSystem.checked });
  });
  captureMic.addEventListener("change", () => {
    if (!captureMic.checked && !options.getSettings().captureSystem) {
      captureMic.checked = true;
      return;
    }
    save({ captureMic: captureMic.checked });
  });
  autoSave.addEventListener("change", () => save({ archiveAutoSave: autoSave.checked }));
  folderBtn.addEventListener("click", () => {
    void openDialog({ directory: true, title: "Archive folder" }).then((picked) => {
      if (typeof picked === "string" && picked !== "") save({ archiveFolder: picked });
    });
  });
  retentionSelect.addEventListener("change", () =>
    save({ archiveRetentionDays: Number(retentionSelect.value) }),
  );
  el<HTMLButtonElement>(host, "#sh-close").addEventListener("click", close);

  /* ---- gauge sources ---- */

  function refreshGauge(): void {
    // Cached live gauge first; before any session, fall back to a host probe
    // (real ledger read) so the sheet is never empty.
    void invoke<GaugeWire | null>("gauge_state").then((gauge) => {
      if (gauge) {
        lastGauge = gauge;
        renderGauge();
      } else {
        void invoke<ProbeResult>("host_probe").then(
          (probe) => {
            lastGauge = probe.gauge;
            renderGauge();
          },
          () => renderGauge(),
        );
      }
    }, () => renderGauge());
  }

  /** #204: reveal the Codex option only when a `codex` binary is present.
   *  Hidden entirely otherwise — not shown disabled — so a user without Codex
   *  never sees an option they cannot use. Detection is binary presence only;
   *  no credential or login state is read. */
  function refreshEngines(): void {
    void invoke<ProbeResult>("host_probe").then(
      (probe) => {
        const available = probe.codex != null;
        engineCodexBtn.hidden = !available;
        codexNote.hidden = !available;
        // A stale settings.json can select Codex on a machine that no longer
        // has the binary; fall back rather than leaving a hidden tier selected.
        if (!available && options.getSettings().engine === "codex") {
          save({ engine: "cli" });
        }
      },
      () => {
        engineCodexBtn.hidden = true;
        codexNote.hidden = true;
      },
    );
  }

  function refreshPrivacy(): void {
    // Live check (EPIC launch gate): read the actual NSWindow sharing state.
    void invoke<boolean>("capture_excluded").then(
      (excluded) => {
        el<HTMLSpanElement>(privCapture, ".sh-priv-mark").textContent = excluded ? "✓" : "✕";
        privCapture.classList.toggle("warn", !excluded);
      },
      () => undefined,
    );
  }

  /* ---- open/close ---- */

  function open(): void {
    host.classList.add("open");
    renderControls();
    refreshGauge();
    refreshEngines();
    refreshPrivacy();
  }

  function close(): void {
    host.classList.remove("open");
  }

  return {
    open,
    close,
    isOpen: () => host.classList.contains("open"),
    updateGauge: (gauge) => {
      lastGauge = gauge;
      if (host.classList.contains("open")) renderGauge();
    },
    syncShell: () => {
      if (host.classList.contains("open")) clickThrough.checked = options.getClickThrough();
    },
  };
}
