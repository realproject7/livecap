// Node-backed LedgerFs for production use (issue #7). The credit accountant
// takes an injected LedgerFs; this wires it to node:fs with atomic writes.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LedgerFs } from "./credit-ledger";

export function nodeLedgerFs(): LedgerFs {
  return {
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      // The ledger records spend/usage — owner-only, not world/group-readable on
      // a shared machine (#148, N-6). `mode` only takes effect on create, so also
      // chmod: the accountant writes a `.tmp` (which a crash can leave stale)
      // before atomically renaming it into place.
      writeFileSync(path, data, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    },
    rename: (from, to) => renameSync(from, to),
  };
}
