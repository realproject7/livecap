// Status-strip content for the current session phase (#65). Pure (DOM-free) so
// the failure-surfacing logic unit-tests headlessly.

import type { SessionPhase } from "./protocol";

export interface SummaryStripContent {
  label: string;
  line: string;
  /** Whether the live dot is lit. */
  live: boolean;
}

/**
 * Compute the summary strip's label + line for a phase. When idle WITH a
 * `statusDetail`, that detail is a terminal failure (#65 — e.g. the engine never
 * became ready and the session was torn down to idle): it is shown DURABLY in
 * the strip, not flashed as a transient toast, so a failed start stays visible
 * until the next start clears it.
 */
export function summaryStripContent(
  phase: SessionPhase,
  statusDetail: string,
  summaryLine: string,
): SummaryStripContent {
  switch (phase) {
    case "idle":
      return statusDetail !== ""
        ? { label: "Couldn't start", line: statusDetail, live: false }
        : {
            label: "LiveCap",
            line: "Start captioning from the menu bar, or press ▶ above.",
            live: false,
          };
    case "starting":
      return { label: "Starting", line: statusDetail !== "" ? statusDetail : "…", live: false };
    case "stopping":
      return { label: "Saving", line: statusDetail !== "" ? statusDetail : "…", live: false };
    case "paused":
      return { label: "Paused", line: "Captions are paused — press ▶ to resume.", live: false };
    case "live":
      return {
        label: "Live summary",
        line: summaryLine !== "" ? summaryLine : "Listening…",
        live: true,
      };
  }
}
