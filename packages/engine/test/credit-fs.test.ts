// #148 (N-6): the credit ledger records spend/usage and must be owner-only
// (0o600), not world/group-readable on a shared machine. Exercises the REAL
// nodeLedgerFs against a temp directory. (The accountant writes a temp file then
// atomically renames it into place; nodeLedgerFs.writeFile is that create step.)
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeLedgerFs } from "../src/credit-fs";

const run = process.platform === "win32" ? describe.skip : describe;

run("nodeLedgerFs permissions (#148)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "livecap-ledger-perms-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the ledger file 0o600", () => {
    const fs = nodeLedgerFs();
    const path = join(root, "nested", "credit-ledger.json.tmp");
    fs.writeFile(path, JSON.stringify({ version: 1 }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
