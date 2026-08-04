// @vitest-environment jsdom
//
// #168: system-audio permission is a TRI-STATE and onboarding must route both
// "denied" and "unknown" to the remediation path. Before this, the probe handed
// back a bare boolean that was `true` even when TCC had denied the grant (a
// denied Core Audio tap is created just the same, it only yields silence), so
// the row showed ✓ and the "Open System Settings" / "Check again" branch was
// unreachable for a real denial.
//
// Headless: `invoke` is stubbed, so nothing here touches TCC — the app's real
// grant state is per-app-bundle and cannot be observed from a test process.

import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  calls: [] as { cmd: string; args?: unknown }[],
  responses: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    tauri.calls.push({ cmd, args });
    return Promise.resolve(tauri.responses[cmd]);
  },
}));

import type { AppSettings } from "../src/app-settings";
import { startOnboarding } from "../src/onboarding";

const SETTINGS = { targetLanguage: "ko" } as unknown as AppSettings;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  startOnboarding({ host, settings: SETTINGS, onDone: () => undefined });
  return host;
}

const q = <T extends HTMLElement>(host: HTMLElement, id: string): T =>
  host.querySelector(id) as T;

/** Mount, answer the grant prompt with `systemAudio`, and settle. */
async function grantWith(systemAudio: string): Promise<HTMLElement> {
  tauri.responses = {
    mic_permission_status: "granted",
    request_audio_access: { mic: "granted", systemAudio },
  };
  const host = mount();
  q<HTMLButtonElement>(host, "#ob-grant").click();
  await flush();
  return host;
}

beforeEach(() => {
  tauri.calls = [];
  tauri.responses = {};
});

describe("#168 onboarding system-audio tri-state", () => {
  it("shows no verdict at all before the probe has run", async () => {
    tauri.responses = { mic_permission_status: "granted" };
    const host = mount();
    await flush();
    expect(q(host, "#ob-sys-status").textContent).toBe("");
    expect(q<HTMLElement>(host, "#ob-sys-hint").hidden).toBe(true);
    expect(q<HTMLButtonElement>(host, "#ob-recheck").hidden).toBe(true);
  });

  it("renders a denial as no-access and makes remediation reachable", async () => {
    const host = await grantWith("denied");
    const status = q(host, "#ob-sys-status");
    expect(status.textContent).toBe("✕ no access");
    expect(status.classList.contains("ok")).toBe(false);
    expect(q<HTMLButtonElement>(host, "#ob-open-sys").hidden).toBe(false);
    expect(q<HTMLButtonElement>(host, "#ob-recheck").hidden).toBe(false);
    expect(q<HTMLElement>(host, "#ob-sys-hint").hidden).toBe(false);
  });

  // The state the old boolean could not express: tap created, but silent — a
  // granted-but-quiet Mac looks exactly like a denied one, so we must not claim
  // either, and the user still needs the way out.
  it("renders the ambiguous state honestly and still offers remediation", async () => {
    const host = await grantWith("unknown");
    const status = q(host, "#ob-sys-status");
    expect(status.textContent).toBe("⚠ not confirmed");
    expect(status.classList.contains("ok")).toBe(false);
    expect(q<HTMLButtonElement>(host, "#ob-open-sys").hidden).toBe(false);
    expect(q<HTMLButtonElement>(host, "#ob-recheck").hidden).toBe(false);
    const hint = q<HTMLElement>(host, "#ob-sys-hint");
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("silence");
    // Never a dead end, and the grant button stays live for another attempt.
    expect(q<HTMLButtonElement>(host, "#ob-next1").hidden).toBe(false);
    expect(q<HTMLButtonElement>(host, "#ob-grant").disabled).toBe(false);
  });

  it("only a granted verdict clears the remediation path", async () => {
    const host = await grantWith("granted");
    const status = q(host, "#ob-sys-status");
    expect(status.textContent).toBe("✓");
    expect(status.classList.contains("ok")).toBe(true);
    expect(q<HTMLButtonElement>(host, "#ob-recheck").hidden).toBe(true);
    expect(q<HTMLElement>(host, "#ob-sys-hint").hidden).toBe(true);
    expect(q<HTMLButtonElement>(host, "#ob-grant").disabled).toBe(true);
  });

  it("'Check again' re-probes and upgrades unknown to granted", async () => {
    const host = await grantWith("unknown");
    tauri.responses.probe_system_audio = "granted";
    q<HTMLButtonElement>(host, "#ob-recheck").click();
    await flush();
    expect(tauri.calls.some((c) => c.cmd === "probe_system_audio")).toBe(true);
    expect(q(host, "#ob-sys-status").textContent).toBe("✓");
    expect(q<HTMLButtonElement>(host, "#ob-recheck").hidden).toBe(true);
    expect(q<HTMLElement>(host, "#ob-sys-hint").hidden).toBe(true);
  });

  it("'Check again' keeps the remediation path when the re-probe still denies", async () => {
    const host = await grantWith("unknown");
    tauri.responses.probe_system_audio = "denied";
    q<HTMLButtonElement>(host, "#ob-recheck").click();
    await flush();
    expect(q(host, "#ob-sys-status").textContent).toBe("✕ no access");
    expect(q(host, "#ob-sys-status").classList.contains("ok")).toBe(false);
    expect(q<HTMLButtonElement>(host, "#ob-recheck").hidden).toBe(false);
  });

  it("deep-links the system-audio pane while system audio is unresolved", async () => {
    const host = await grantWith("unknown");
    q<HTMLButtonElement>(host, "#ob-open-sys").click();
    await flush();
    const open = tauri.calls.filter((c) => c.cmd === "open_privacy_settings").pop();
    expect(open?.args).toEqual({ section: "system-audio" });
  });
});
