// Pure mapping from the host's per-id caption meta to the FinalizedRecord[] the
// post-meeting metrics (#78/#81) consume. Extracted so it is unit-testable
// headlessly without standing up a full HostSession (which spawns real engines).

import type { FinalizedRecord } from "@livecap/engine";

import type { Channel } from "../protocol.ts";

/** The subset of per-caption meta the metrics need. */
export interface MetricsMeta {
  channel: Channel;
  text: string;
  lowConfidence: boolean;
  durationMs: number;
}

/** Map the host's caption meta onto the engine's FinalizedRecord shape: the
 *  webview channel ("me"/"them") becomes the metrics channel ("mic"/"system"),
 *  and the spoken duration carries through. Iteration order follows the input. */
export function toFinalizedRecords(metas: Iterable<MetricsMeta>): FinalizedRecord[] {
  const records: FinalizedRecord[] = [];
  for (const meta of metas) {
    records.push({
      channel: meta.channel === "me" ? "mic" : "system",
      durationMs: meta.durationMs,
      text: meta.text,
      lowConfidence: meta.lowConfidence,
    });
  }
  return records;
}
