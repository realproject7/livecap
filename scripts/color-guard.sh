#!/bin/bash
# Raw-color guard (#116): src CSS must reference colors through design tokens,
# not raw literals — every hex / rgb() / rgba() color belongs in the :root token
# block. A raw color anywhere else fails CI so the debt can't regrow with each
# new UI surface (the reason #116 exists).
#
# What it flags: a hex (#rgb / #rgba / #rrggbb / #rrggbbaa) or rgb()/rgba()
# literal appearing in a DECLARATION VALUE (the text after the first ':' on a
# line) in src/**/*.css, OUTSIDE the ':root { ... }' block.
#
# Why value-only (casebook #7 — color-scan false positives): hex-looking ID
# selectors such as `#feed`, `#feed-wrap`, `#feed-note` are legitimate and must
# NOT be flagged. They sit in selector position — no property ':' precedes them
# — so scanning only the value side skips them WITHOUT a brittle name allowlist.
#
# Escape hatch: prefer moving the literal into a :root token. As a last resort,
# append `/* color-guard-allow */` to the specific line to exempt it.
set -euo pipefail

# Draft pattern from the issue, refined: hex must be followed by a non-hex char
# (or line end) so `#feedcafe`-style tails don't over/under-match a color.
COLOR_RE='#[0-9a-fA-F]{3,8}([^0-9a-fA-F]|$)|rgba?\('

# bash-3.2 compatible (stock macOS bash has no `mapfile`, #126).
FILES=()
while IFS= read -r f; do
  FILES+=("$f")
done < <(find src -type f -name '*.css' 2>/dev/null | sort)
if [ ${#FILES[@]} -eq 0 ]; then
  echo "color-guard: no src CSS files found (nothing to check)"
  exit 0
fi

# awk strips the :root block and emits "<file>:<lineno>:<value-side>" for every
# other line that has a property ':' — grep then tests only that value side.
HITS=$(
  for f in "${FILES[@]}"; do
    awk '
      /^[[:space:]]*:root[[:space:]]*\{/ { inroot = 1 }
      inroot { if ($0 ~ /\}/) inroot = 0; next }
      /color-guard-allow/ { next }
      {
        i = index($0, ":")
        if (i == 0) next
        printf "%s:%d:%s\n", FILENAME, NR, substr($0, i + 1)
      }
    ' "$f"
  done | grep -E "$COLOR_RE" || true
)

if [ -n "$HITS" ]; then
  echo "color-guard FAILED — raw color literal(s) outside the :root token block:"
  echo "$HITS"
  echo
  echo "Fix: replace with a design token — e.g. var(--surface-2) — and define any"
  echo "new token in the :root block (mirror it in design/system/tokens.css)."
  exit 1
fi

echo "color-guard passed — all colors in src CSS come from :root tokens"
