import { describe, it, expect } from "vitest";

import type { AppSettings } from "../src/app-settings";
import { bootstrap, type BootstrapInvokers, type BootstrapSink } from "../src/bootstrap";
import type { Capabilities, SessionChannels, SessionPhase, ShellState } from "../src/protocol";

const SHELL: ShellState = { mode: "capsule", clickThrough: false, pinned: true, live: true };
const CAPS: Capabilities = { captioning: true, settings: true };
const CHANNELS: SessionChannels = { system: true, mic: true };
const SETTINGS = { onboardingComplete: true } as unknown as AppSettings;

function recordingSink(applied: string[], renders: { n: number }): BootstrapSink {
  return {
    applyShellState: () => applied.push("shell"),
    applyCapabilities: () => applied.push("capabilities"),
    applyPhase: () => applied.push("phase"),
    applySettings: () => applied.push("settings"),
    applyChannels: () => applied.push("channels"),
    render: () => {
      renders.n += 1;
    },
    onError: (label) => applied.push(`error:${label}`),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("bootstrap (#65 — first paint not gated on the backend)", () => {
  it("renders defaults synchronously, before any command resolves", () => {
    const applied: string[] = [];
    const renders = { n: 0 };
    const invokers: BootstrapInvokers = {
      shellState: () => Promise.resolve(SHELL),
      capabilities: () => Promise.resolve(CAPS),
      phase: () => Promise.resolve("idle"),
      settings: () => Promise.resolve(SETTINGS),
      channels: () => Promise.resolve(CHANNELS),
    };
    bootstrap(invokers, recordingSink(applied, renders));
    // The first paint happened synchronously; no state has been applied yet.
    expect(renders.n).toBe(1);
    expect(applied).toEqual([]);
  });

  it("a stalled session_phase never blocks the shell mode (the blank-screen fix)", async () => {
    const applied: string[] = [];
    const renders = { n: 0 };
    const wedged = new Promise<SessionPhase>(() => {}); // session_phase never answers
    const invokers: BootstrapInvokers = {
      shellState: () => Promise.resolve(SHELL),
      capabilities: () => Promise.resolve(CAPS),
      phase: () => wedged,
      settings: () => Promise.resolve(SETTINGS),
      channels: () => Promise.resolve(CHANNELS),
    };
    bootstrap(invokers, recordingSink(applied, renders));

    await tick();
    // Shell mode, capabilities, settings, channels all applied + repainted...
    expect(applied).toContain("shell");
    expect(applied).toContain("capabilities");
    expect(applied).toContain("settings");
    expect(applied).toContain("channels");
    // ...while the wedged phase is never applied, and the window still repainted.
    expect(applied).not.toContain("phase");
    expect(renders.n).toBeGreaterThan(1);
  });

  it("surfaces a failed command via onError without aborting the rest of boot", async () => {
    const applied: string[] = [];
    const renders = { n: 0 };
    const invokers: BootstrapInvokers = {
      shellState: () => Promise.resolve(SHELL),
      capabilities: () => Promise.reject(new Error("capabilities failed")),
      phase: () => Promise.resolve("live"),
      settings: () => Promise.resolve(SETTINGS),
      channels: () => Promise.resolve(CHANNELS),
    };
    bootstrap(invokers, recordingSink(applied, renders));

    await tick();
    expect(applied).toContain("error:capabilities");
    expect(applied).toContain("shell"); // the rest still applied
    expect(applied).toContain("phase");
  });
});
