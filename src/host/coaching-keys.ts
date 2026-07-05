// Map coached caption ids to the archive's coaching amend keys (#114). The
// #113 archive keys a coached utterance by `(timestamp, occurrence)`, where
// `occurrence` is the 1-based position among `speaker: "me"` entries sharing
// that timestamp — computed over the archived entry order (render.ts /
// writer.amendCoaching use the exact same walk). Pure and headless so the
// keying can be unit-tested without standing up a HostSession.

import type { Speaker } from "@livecap/archive";

/** The subset of an archived entry the keying needs, paired with the caption
 *  id the host tracks it by (the writer itself never sees caption ids). */
export interface KeyedEntry {
  id: number;
  speaker: Speaker;
  timestamp: string;
}

/** An `amendCoaching` target key (#113): `(timestamp, occurrence)`. */
export interface CoachingAmendKey {
  timestamp: string;
  occurrence: number;
}

/**
 * Compute the `(timestamp, occurrence)` amend key for each requested caption
 * id. `entries` MUST be in archived (appended) order — the same order the
 * writer renders — or the occurrence indices drift from the file's. Ids that
 * are not a `me` entry (or not present at all) get no key: they were never
 * archived as the user's own utterances, so there is nothing to amend.
 */
export function coachingAmendKeys(
  entries: Iterable<KeyedEntry>,
  ids: readonly number[],
): Map<number, CoachingAmendKey> {
  const wanted = new Set(ids);
  const occurrenceByTimestamp = new Map<string, number>();
  const keys = new Map<number, CoachingAmendKey>();
  for (const entry of entries) {
    if (entry.speaker !== "me") continue;
    const occurrence = (occurrenceByTimestamp.get(entry.timestamp) ?? 0) + 1;
    occurrenceByTimestamp.set(entry.timestamp, occurrence);
    if (wanted.has(entry.id)) {
      keys.set(entry.id, { timestamp: entry.timestamp, occurrence });
    }
  }
  return keys;
}
