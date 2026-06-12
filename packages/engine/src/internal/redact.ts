// Content-free diagnostics for engine error/health surfaces (#23). Child stderr
// and model output may echo prompt/caption content; SECURITY.md forbids that
// content reaching logs/crash reports. These surfaces therefore carry only
// non-reversible metadata (byte count + a short hash of the retained tail).

import { createHash } from "node:crypto";

/** A content-free summary of captured child stderr. */
export function stderrDigest(byteCount: number, tail: string): string {
  if (byteCount === 0) return "no stderr";
  const hash = createHash("sha256").update(tail).digest("hex").slice(0, 8);
  return `stderr ${byteCount} bytes (tail sha256:${hash})`;
}
