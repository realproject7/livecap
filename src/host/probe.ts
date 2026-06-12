// Sessionless probe (#12): real CLI detection + a read-only credit-gauge
// snapshot, reusing the exact production code paths (detect-cli, the
// CreditAccountant ledger). Onboarding screen 3 and the Settings sheet call
// this through the Rust `host_probe` command before any session is live.

import { join } from "node:path";

import { CreditAccountant, nodeLedgerFs } from "@livecap/engine";

import type { ProbeRequest, ProbeResult } from "../protocol.ts";
import { detectClaudeCli } from "./detect-cli.ts";

export async function runProbe(request: ProbeRequest): Promise<ProbeResult> {
  const cli = await detectClaudeCli(process.env.PATH);
  // Constructing the accountant loads (and, on a period rollover, rewrites)
  // the same ledger a session uses — the gauge here is the live one.
  const accountant = new CreditAccountant({
    fs: nodeLedgerFs(),
    ledgerPath: join(request.appDataDir, "credit-ledger.json"),
    poolUsd: request.poolUsd,
    resetDay: request.resetDay,
    now: Date.now,
  });
  return {
    type: "probe",
    cli: cli ? { bin: cli.bin, version: cli.version } : null,
    gauge: accountant.gauge(),
  };
}
