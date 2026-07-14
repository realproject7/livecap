#!/bin/bash
# No-stub gate (EPIC #1 engineering policy): application code must not contain
# deferred-functionality markers or mock/placeholder logic. Test code is exempt.
set -euo pipefail

# Deferred-functionality / placeholder markers (#176 extends the original 5 to
# cover the gate's own namesake and its cousins). `\bmock`/`\bstub`/`\bdummy` use
# a LEADING word boundary only, so camelCase (`stubTranslateBatch`) is caught;
# `not[[:space:]]+implemented` is whitespace-tolerant; the whole scan is
# case-insensitive (grep -i below).
PATTERN='TODO|FIXME|HACK|placeholder|\bmock|\bstub|\bdummy|unimplemented|not[[:space:]]+implemented|\bXXX\b'

# Narrow carve-out (#176): "not implemented FOR <platform/target>" is a shipped
# capability statement in an error description (e.g. crates/livecap-core/src/
# error.rs — "System-audio capture is not implemented for the current platform"),
# NOT a deferred stub. Only this precise phrasing is exempted; a bare "not
# implemented" / "not implemented yet" still fires.
ALLOW='not[[:space:]]+implemented[[:space:]]+for[[:space:]]'

# Self-test (#176): a fixture with one banned marker per line proves the gate can
# still FIRE. If a future edit weakens PATTERN so it stops matching a known-bad
# marker, fail loudly HERE rather than silently letting stubs reach a release. A
# MISSING fixture is a hard failure — the gate must never run without its own
# regression proof.
SELFTEST="scripts/fixtures/no-stub-selftest.txt"
if [ ! -f "$SELFTEST" ]; then
  echo "no-stub gate FAILED — self-test fixture missing ($SELFTEST)."
  echo "The gate must not run without its regression proof; restore the fixture."
  exit 1
fi
EXPECTED=$(grep -cvE '^[[:space:]]*(#|$)' "$SELFTEST")
MATCHED=$(grep -vE '^[[:space:]]*(#|$)' "$SELFTEST" | grep -icE "$PATTERN" || true)
if [ "$MATCHED" -ne "$EXPECTED" ]; then
  echo "no-stub gate SELF-TEST FAILED — PATTERN matched $MATCHED of $EXPECTED marker lines in $SELFTEST."
  echo "The gate is weakened (it would miss real stubs); restore the missing marker(s)."
  exit 1
fi

# Application source roots (extend as the workspace grows):
ROOTS=(src src-tauri/src crates packages/*/src)
HITS=$(grep -rinE "$PATTERN" "${ROOTS[@]}" 2>/dev/null \
  | grep -viE '(^|/)(test|tests|__tests__|fixtures)/' \
  | grep -viE "$ALLOW" || true)
if [ -n "$HITS" ]; then
  echo "no-stub gate FAILED — banned markers in application code:"
  echo "$HITS"
  exit 1
fi
echo "no-stub gate passed (self-test: $EXPECTED markers fire)"
