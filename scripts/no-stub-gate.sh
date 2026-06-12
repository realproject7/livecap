#!/bin/bash
# No-stub gate (EPIC #1 engineering policy): application code must not contain
# deferred-functionality markers or mock/placeholder logic. Test code is exempt.
set -euo pipefail
PATTERN='TODO|FIXME|HACK|placeholder|\bmock'
# Application source roots (extend as the workspace grows):
ROOTS=(src src-tauri/src crates packages/*/src)
HITS=$(grep -rinE "$PATTERN" "${ROOTS[@]}" 2>/dev/null | grep -viE '(^|/)(test|tests|__tests__|fixtures)/' || true)
if [ -n "$HITS" ]; then
  echo "no-stub gate FAILED — banned markers in application code:"
  echo "$HITS"
  exit 1
fi
echo "no-stub gate passed"
