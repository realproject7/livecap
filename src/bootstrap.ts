// Webview boot orchestration (#65). The blank-capsule/blank-panel bug had the
// init `await Promise.all([...session_phase...])` gate the FIRST paint on every
// backend command at once — so a session start wedged on a stalled model
// download (which held the phase query) left `body[data-mode]` unset and every
// mode-dependent view `display:none`: blank glass.
//
// This decouples boot from the backend: paint defaults immediately, then apply
// each piece of state independently as its command resolves. A stalled (or
// failed) `session_phase` can no longer block the window from rendering.
//
// DOM-free and dependency-injected so it unit-tests headlessly.

import type { AppSettings } from "./app-settings";
import type { Capabilities, SessionChannels, SessionPhase, ShellState } from "./protocol";

export interface BootstrapInvokers {
  shellState(): Promise<ShellState>;
  capabilities(): Promise<Capabilities>;
  phase(): Promise<SessionPhase>;
  settings(): Promise<AppSettings>;
  channels(): Promise<SessionChannels>;
}

export interface BootstrapSink {
  applyShellState(state: ShellState): void;
  applyCapabilities(capabilities: Capabilities): void;
  applyPhase(phase: SessionPhase): void;
  applySettings(settings: AppSettings): void;
  applyChannels(channels: SessionChannels): void;
  /** Repaint with whatever state has arrived so far. */
  render(): void;
  /** A command failed; defaults stay in place (never fatal to boot). */
  onError(label: string, error: unknown): void;
}

/**
 * Boot the UI without gating the first paint on any backend call (#65). Renders
 * defaults synchronously, then applies + repaints each state as it arrives.
 */
export function bootstrap(invokers: BootstrapInvokers, sink: BootstrapSink): void {
  // First paint with JS defaults — happens before any invoke resolves, so the
  // window is never blank while the backend is still answering (or stalled).
  sink.render();

  const settle = <T>(promise: Promise<T>, apply: (value: T) => void, label: string): void => {
    promise.then(
      (value) => {
        apply(value);
        sink.render();
      },
      (error: unknown) => sink.onError(label, error),
    );
  };

  settle(invokers.shellState(), (value) => sink.applyShellState(value), "shell-state");
  settle(invokers.capabilities(), (value) => sink.applyCapabilities(value), "capabilities");
  settle(invokers.phase(), (value) => sink.applyPhase(value), "phase");
  settle(invokers.settings(), (value) => sink.applySettings(value), "settings");
  settle(invokers.channels(), (value) => sink.applyChannels(value), "channels");
}
