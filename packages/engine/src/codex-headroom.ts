// Codex quota → #205 headroom seam (#204).
//
// Codex exposes no USD cost anywhere (verified: zero cost fields across the
// generated v2 schema). What it does expose is `account/rateLimits/read`, a
// percentage-of-allowance figure — which is exactly what the #205 seam was
// built to consume, so this adapter needs no token→USD rate card and ships
// none.
//
// Shapes below were measured against the real `codex-cli 0.146.0`, not inferred
// from the schema:
//
//   rateLimits: {
//     primary:   { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1786449404 },
//     secondary: null,
//     planType: "prolite", ...
//   }
//
// Two measured facts drive the code below:
//   1. `secondary` is NULL on at least one real plan — a second window is not
//      guaranteed, so this handles 1..N windows rather than assuming two.
//   2. `resetsAt` is epoch SECONDS here, while the #205 seam documents epoch
//      MILLISECONDS. Converting is this adapter's job; without it the seam's
//      "resets in …" line renders a date in 1970.
//
// Security (#204): nothing in this file reads, stores, or logs a credential or
// token — auth lives entirely inside the user's own `codex` login. Only numeric
// percentages and window durations cross into the seam; `planType`, account
// ids, and any other identifying field on the response are deliberately dropped.

import type { HeadroomReading, HeadroomSource, HeadroomWindow } from "./headroom";

/** One window as `account/rateLimits/read` reports it. All fields optional —
 *  this is an experimental, unversioned-in-practice surface. */
export interface CodexRateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  /** Epoch SECONDS (measured), not milliseconds. */
  resetsAt?: number | null;
}

/** The subset of `account/rateLimits/read` this adapter consumes. Everything
 *  else on the response — including `planType` and any account identifier — is
 *  intentionally not modelled, so it cannot leak into a gauge event. */
export interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

/** Reads the rate limits from a running app-server. Resolves `null` when the
 *  call is unavailable or failed — the source turns that into an explicit
 *  unknown rather than guessing. */
export type CodexRateLimitsReader = () => Promise<CodexRateLimits | null>;

const MINS_PER_HOUR = 60;
const MINS_PER_DAY = 1440;
const MINS_PER_WEEK = 10_080;

/** Human label for a window, used only in the seam's display string. */
export function windowLabel(durationMins: number | null | undefined): string {
  if (typeof durationMins !== "number" || !Number.isFinite(durationMins) || durationMins <= 0) {
    return "quota";
  }
  if (durationMins === MINS_PER_WEEK) return "weekly";
  if (durationMins === MINS_PER_DAY) return "daily";
  if (durationMins % MINS_PER_DAY === 0) return `${durationMins / MINS_PER_DAY}d`;
  if (durationMins % MINS_PER_HOUR === 0) return `${durationMins / MINS_PER_HOUR}h`;
  return `${durationMins}m`;
}

/** Epoch SECONDS (what Codex reports) → epoch MILLISECONDS (what the seam
 *  documents). Anything non-finite becomes null so the display line simply
 *  omits the reset rather than rendering a bogus date. */
export function resetsAtMs(resetsAtSeconds: number | null | undefined): number | null {
  if (typeof resetsAtSeconds !== "number" || !Number.isFinite(resetsAtSeconds)) return null;
  return Math.round(resetsAtSeconds * 1000);
}

/** Convert one reported window, or null when it carries no usable percentage. */
export function toHeadroomWindow(
  window: CodexRateLimitWindow | null | undefined,
): HeadroomWindow | null {
  if (!window) return null;
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return null;
  }
  return {
    label: windowLabel(window.windowDurationMins),
    usedPercent,
    resetsAt: resetsAtMs(window.resetsAt),
    windowDurationMins: window.windowDurationMins ?? null,
  };
}

/**
 * Turn a rate-limits response into a {@link HeadroomReading}.
 *
 * Handles **1..N windows**: a plan may report only `primary` (measured on a
 * real `prolite` account, where `secondary` is null), both, or neither. The
 * seam takes the minimum across whatever it is given, so the caller does not
 * need to know which windows exist.
 */
export function readingFromRateLimits(limits: CodexRateLimits | null): HeadroomReading {
  if (!limits) return { known: false, reason: "unreadable" };
  const windows = [toHeadroomWindow(limits.primary), toHeadroomWindow(limits.secondary)].filter(
    (w): w is HeadroomWindow => w !== null,
  );
  if (windows.length === 0) return { known: false, reason: "no-windows" };
  return { known: true, windows };
}

/**
 * `HeadroomSource` backed by `account/rateLimits/read`.
 *
 * A reader that rejects is treated as unreadable rather than allowed to
 * escape — the #205 contract is that a headroom failure never takes down the
 * caption stream, and unknown headroom does not auto-switch.
 */
export class CodexHeadroomSource implements HeadroomSource {
  readonly kind = "codex-quota";

  constructor(private readonly reader: CodexRateLimitsReader) {}

  async read(): Promise<HeadroomReading> {
    try {
      return readingFromRateLimits(await this.reader());
    } catch {
      return { known: false, reason: "unreadable" };
    }
  }
}
