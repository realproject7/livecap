#!/bin/bash
# No-stub gate (EPIC #1 engineering policy): application code must not contain
# deferred-functionality markers or mock/placeholder logic. Test code is exempt.
set -euo pipefail

# Deferred-functionality / placeholder markers (#176 extends the original 5 to
# cover the gate's own namesake and its cousins). `\bmock`/`\bstub`/`\bdummy` use
# a LEADING word boundary only, so camelCase (`stubTranslateBatch`) is caught; the
# whole scan is case-insensitive (grep -i below). The Rust `unimplemented!()`
# marker is matched; the free-form phrase "not implemented" is deliberately NOT —
# it legitimately describes shipped platform-unsupported errors (e.g.
# error.rs), and `unimplemented` already covers the deferred-code case.
PATTERN='TODO|FIXME|HACK|placeholder|\bmock|\bstub|\bdummy|unimplemented|\bXXX\b'

# Self-test (#176): a fixture with one banned marker per line proves the gate can
# still FIRE. If a future edit weakens PATTERN so it stops matching a known-bad
# marker, fail loudly HERE rather than silently letting stubs reach a release.
SELFTEST="scripts/fixtures/no-stub-selftest.txt"
if [ -f "$SELFTEST" ]; then
  EXPECTED=$(grep -cvE '^[[:space:]]*(#|$)' "$SELFTEST")
  MATCHED=$(grep -vE '^[[:space:]]*(#|$)' "$SELFTEST" | grep -icE "$PATTERN" || true)
  if [ "$MATCHED" -ne "$EXPECTED" ]; then
    echo "no-stub gate SELF-TEST FAILED — PATTERN matched $MATCHED of $EXPECTED marker lines in $SELFTEST."
    echo "The gate is weakened (it would miss real stubs); restore the missing marker(s)."
    exit 1
  fi
else
  echo "::warning::no-stub-gate self-test fixture missing ($SELFTEST) — gate ran without its own regression check."
  EXPECTED=0
fi

# Application source roots (extend as the workspace grows):
ROOTS=(src src-tauri/src crates packages/*/src)
HITS=$(grep -rinE "$PATTERN" "${ROOTS[@]}" 2>/dev/null | grep -viE '(^|/)(test|tests|__tests__|fixtures)/' || true)
if [ -n "$HITS" ]; then
  echo "no-stub gate FAILED — banned markers in application code:"
  echo "$HITS"
  exit 1
fi
echo "no-stub gate passed (self-test: $EXPECTED markers fire)"
