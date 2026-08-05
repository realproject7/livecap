// Engine-agnostic headroom seam (#205).
//
// The auto-fallback decision was never really denominated in dollars:
// `CreditAccountant.isBelowThreshold()` compares ESTIMATED MEETING-HOURS
// REMAINING against a threshold. USD is only how the Claude tier derives that
// number (`remainingUsd / dollarsPerHour`). Every paid engine answers the same
// user-facing question — "how long can I run before this stops being free?" —
// so this module keeps hours as the cross-engine primitive and makes only the
// DERIVATION pluggable. There is deliberately no token→USD rate card here.
//
// Signatures are async-first even though today's implementations are local: a
// future source is a network read, and a sync seam would guarantee a repo-wide
// refactor later. The async boundary is the SOURCE; `CreditAccountant` keeps a
// last-known snapshot so its read path stays synchronous (`startOnFallback`
// wiring and the #37 rollover-resilience contract both depend on that).
//
// Security (#205): a source must never surface credentials, tokens, plan
// identifiers, or account ids. `HeadroomUnknown.reason` is therefore a closed
// set of literals rather than free text — a source cannot smuggle an account
// id into an event or a log line through this type.

/** One allowance window as a source reports it (e.g. a 5-hour rolling window
 *  and a weekly window). `usedPercent` is 0–100. */
export interface HeadroomWindow {
  /** Short label used only in the display string, e.g. "5h" or "weekly". */
  label: string;
  /** Percent of this window's allowance consumed (0–100). */
  usedPercent: number;
  /** Epoch ms at which this window resets. DISPLAY ONLY (#205 scope 7): it must
   *  not influence threshold logic here. A soon-resetting window arguably means
   *  "wait" rather than "fall back", but that is a separate product decision. */
  resetsAt?: number | null;
  /** Window length in minutes. Display only. */
  windowDurationMins?: number | null;
}

/** Why headroom could not be determined. A closed set on purpose — see the
 *  security note above. */
export type HeadroomUnknownReason = "unreadable" | "no-windows" | "invalid";

export type HeadroomReading =
  | { known: true; windows: HeadroomWindow[] }
  | { known: false; reason: HeadroomUnknownReason };

/** An async-first source of allowance information. */
export interface HeadroomSource {
  /** Engine tag carried into the gauge's native detail, e.g. "usd" | "quota". */
  readonly kind: string;
  /** Never rejects for an expected failure — an unreadable source resolves to
   *  `{known: false}`. (A thrown error is still handled by the caller, which
   *  treats it as `"unreadable"` rather than letting it escape.) */
  read(): Promise<HeadroomReading>;
}

/**
 * Estimated hours remaining, or an explicit unknown.
 *
 * `hoursRemaining` is NEVER `Infinity`. Reporting infinite headroom for an
 * unreadable source would silently disable the safety net — the failure mode
 * this seam exists to prevent (#205 scope 5) — so unknown is represented
 * structurally and the decision path refuses to switch on it.
 */
export type Headroom =
  | {
      known: true;
      hoursRemaining: number;
      /** 0–1 of the BINDING window's allowance consumed (#204). The gauge bar
       *  needs a fraction, and on a non-USD tier the ledger's `fractionUsed` is
       *  computed from dollars that do not exist — a permanently empty bar that
       *  reads as "budget untouched". This is the real one. */
      fractionUsed: number;
      nativeDetail: string;
    }
  | { known: false; reason: HeadroomUnknownReason; nativeDetail: string };

/**
 * The shared primitive both derivations reduce to: units of allowance left,
 * divided by units consumed per metered meeting-hour.
 *
 * This is exactly the arithmetic the USD path has always used
 * (`remaining / dollarsPerHour`, zero when the rate is unknown), lifted so the
 * quota path cannot drift from it. Units cancel, which is the whole point —
 * dollars and percent both produce hours.
 */
export function hoursFromRate(unitsRemaining: number, unitsPerHour: number): number {
  if (!Number.isFinite(unitsRemaining) || !Number.isFinite(unitsPerHour)) return 0;
  return unitsPerHour > 0 ? Math.max(0, unitsRemaining) / unitsPerHour : 0;
}

/**
 * Rolling consumption rate, measured the way `dollarsPerHour` always has been:
 * total consumed / metered meeting-hours, falling back to a default until
 * enough real usage has accrued to be meaningful.
 */
export function ratePerHour(consumed: number, meteredHours: number, fallback: number): number {
  return meteredHours > 0 && consumed > 0 ? consumed / meteredHours : fallback;
}

/** Percent-per-hour assumed before any metered time exists. Mirrors the USD
 *  path's `defaultDollarsPerHour` in role: a deliberately conservative guess so
 *  the safety net is armed from the first minute rather than silent. */
export const DEFAULT_PERCENT_PER_HOUR = 20;

function formatResetsIn(resetsAt: number | null | undefined, nowMs: number): string {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return "";
  const ms = resetsAt - nowMs;
  if (ms <= 0) return ", resets now";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return `, resets in ${hours}h`;
  return `, resets in ${mins}m`;
}

/**
 * Derive headroom from a quota-style reading.
 *
 * **Two windows (#205 scope 4):** when a source exposes more than one window,
 * headroom is the MINIMUM across them — whichever wall is hit first is the real
 * constraint, so a nearly-exhausted weekly window governs even while the
 * rolling window looks healthy.
 */
export function quotaHeadroom(
  reading: HeadroomReading,
  meteredHours: number,
  nowMs: number,
  defaultPercentPerHour: number = DEFAULT_PERCENT_PER_HOUR,
): Headroom {
  if (!reading.known) {
    return { known: false, reason: reading.reason, nativeDetail: "usage unknown" };
  }
  const usable = reading.windows.filter(
    (w) => Number.isFinite(w.usedPercent) && w.usedPercent >= 0,
  );
  if (usable.length === 0) {
    return { known: false, reason: "no-windows", nativeDetail: "usage unknown" };
  }

  let binding: { window: HeadroomWindow; hours: number } | null = null;
  for (const window of usable) {
    const used = Math.min(100, window.usedPercent);
    const remainingPercent = Math.max(0, 100 - used);
    const hours = hoursFromRate(
      remainingPercent,
      ratePerHour(used, meteredHours, defaultPercentPerHour),
    );
    if (binding === null || hours < binding.hours) binding = { window, hours };
  }
  // `usable` is non-empty, so the loop always assigns.
  const { window, hours } = binding as { window: HeadroomWindow; hours: number };
  const used = Math.round(Math.min(100, window.usedPercent));
  // Name the binding window ONLY when there is more than one (#204): with two
  // windows "90% used" is ambiguous about which wall is being hit, and the whole
  // point of the minimum is that the answer is not obvious. With a single window
  // — the shape a real `prolite` plan reports — the label adds nothing but
  // noise, so it is omitted. This is the field's reader: `label` is consumed
  // here, not merely populated.
  const prefix = usable.length > 1 ? `${window.label}: ` : "";
  return {
    known: true,
    hoursRemaining: hours,
    fractionUsed: Math.min(1, Math.max(0, used / 100)),
    nativeDetail: `${prefix}${used}% used${formatResetsIn(window.resetsAt, nowMs)}`,
  };
}

/** Native detail for the USD (Claude) derivation — the same figures the gauge
 *  has always carried, formatted for display only. */
export function usdNativeDetail(spentUsd: number, poolUsd: number): string {
  return `$${spentUsd.toFixed(2)} of $${poolUsd.toFixed(2)}`;
}
