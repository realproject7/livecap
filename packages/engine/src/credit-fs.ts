// Node-backed LedgerFs for production use (issue #7). The credit accountant
// takes an injected LedgerFs; this wires it to node:fs with atomic writes.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LedgerFs } from "./credit-ledger";

export function nodeLedgerFs(): LedgerFs {
  return {
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, "utf8");
    },
    rename: (from, to) => renameSync(from, to),
  };
}
