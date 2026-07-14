// Wall-clock HH:MM label for a caption timestamp. Dependency-free shared module
// (like protocol.ts) so the live feed (main.ts) and the host's archive/coaching
// timestamps (session.ts) format the SAME string — the (timestamp, occurrence)
// coaching-amend keys in coaching-keys.ts depend on this exact format, so the two
// sides must never drift.

/** Local-time "HH:MM" for an epoch-ms timestamp, zero-padded. */
export function clockLabel(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
