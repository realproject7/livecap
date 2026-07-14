#!/bin/bash
# Raw-color guard (#116, extended #176): colors must come from design tokens, not
# raw literals — every hex / rgb() / hsl() / modern-color-function / named color
# belongs behind a :root token (as var(...)). A raw color anywhere else fails CI
# so the #116 token debt can't regrow with each new UI surface.
#
# Two passes:
#   1) src/**/*.css — a color literal in a DECLARATION VALUE (text after the first
#      ':' on a line), OUTSIDE the ':root { ... }' block.
#   2) src/**/*.ts  — a color literal (hex / rgb() / hsl()-family) on a line that
#      SETS an inline style (`.style.`, `.setProperty(`, or a `style=` attribute in
#      a template string). Best-effort grep; the LIMITS are documented below.
#
# Why value-only for CSS (casebook #7 — color-scan false positives): hex-looking
# ID selectors (`#feed`, `#feed-wrap`) sit in SELECTOR position (no property ':'
# precedes them), so scanning only the value side skips them without a name
# allowlist.
#
# LIMITS (best-effort, #176) — NOT covered, by design:
#   - named colors in TS (bare `red`/`blue` collide with ordinary identifiers/
#     strings, so the TS pass matches only hex/rgb()/hsl()-family literals);
#   - a color built across lines or from a runtime expression / concatenation;
#   - values inside CSS/JS block comments on a value line (use the escape hatch).
#
# Escape hatch: prefer a :root token. As a last resort, append
# `/* color-guard-allow */` to the specific line to exempt it.
set -euo pipefail

# Hex (#rgb / #rgba / #rrggbb / #rrggbbaa): a trailing non-hex char (or EOL) keeps
# `#feedcafe`-style tails from over/under-matching. Modern CSS color functions
# (#176): hsl/hsla/hwb/oklch/oklab/lch/lab/color-mix/color(). A curated set of CSS
# NAMED colors (#176) — the CSS-wide keywords (transparent/currentColor/inherit/
# initial/unset/revert/none/auto) are deliberately absent, so those still pass.
HEX='#[0-9a-fA-F]{3,8}([^0-9a-fA-F]|$)'
COLOR_FUNC='rgba?\(|hsla?\(|hwb\(|oklch\(|oklab\(|lch\(|lab\(|color-mix\(|color\('
NAMED='\b(aqua|aquamarine|beige|black|blue|brown|chocolate|coral|crimson|cyan|fuchsia|gold|goldenrod|gray|grey|green|indigo|ivory|khaki|lavender|lime|magenta|maroon|navy|olive|orange|orchid|pink|plum|purple|red|salmon|sienna|silver|tan|teal|tomato|turquoise|violet|wheat|white|yellow)\b'
COLOR_RE="$HEX|$COLOR_FUNC|$NAMED"
# The TS pass omits NAMED — bare color words are too common in code/strings.
TS_COLOR_RE="$HEX|$COLOR_FUNC"

# ---- Pass 1: CSS ----------------------------------------------------------
# bash-3.2 compatible (stock macOS bash has no `mapfile`, #126).
CSS_FILES=()
while IFS= read -r f; do [ -n "$f" ] && CSS_FILES+=("$f"); done < <(find src -type f -name '*.css' 2>/dev/null | sort)

CSS_HITS=""
if [ ${#CSS_FILES[@]} -gt 0 ]; then
  # awk strips the :root block and emits "<file>:<lineno>:<value-side>" for every
  # other line that has a property ':'; grep then tests only that value side.
  CSS_HITS=$(
    for f in "${CSS_FILES[@]}"; do
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
fi

# ---- Pass 2: TS inline styles (#176) --------------------------------------
# A raw color literal on a line that sets an inline style. Value-side heuristic
# via the style-set anchor; the escape hatch and var() tokens are honored.
TS_FILES=()
while IFS= read -r f; do [ -n "$f" ] && TS_FILES+=("$f"); done < <(find src -type f -name '*.ts' 2>/dev/null | sort)

TS_HITS=""
if [ ${#TS_FILES[@]} -gt 0 ]; then
  TS_HITS=$(
    for f in "${TS_FILES[@]}"; do
      grep -nE '(\.style\.|\.setProperty\(|style=)' "$f" 2>/dev/null \
        | grep -v 'color-guard-allow' \
        | grep -E "$TS_COLOR_RE" \
        | sed "s|^|$f:|" || true
    done
  )
fi

FAILED=0
if [ -n "$CSS_HITS" ]; then
  echo "color-guard FAILED — raw color literal(s) outside the :root token block (CSS):"
  echo "$CSS_HITS"
  FAILED=1
fi
if [ -n "$TS_HITS" ]; then
  echo "color-guard FAILED — raw color literal(s) in a TS-set inline style:"
  echo "$TS_HITS"
  FAILED=1
fi
if [ "$FAILED" -ne 0 ]; then
  echo
  echo "Fix: replace with a design token — e.g. var(--surface-2) — and define any"
  echo "new token in the :root block (mirror it in design/system/tokens.css)."
  echo "Last resort: append /* color-guard-allow */ to the specific line."
  exit 1
fi

echo "color-guard passed — all colors in src CSS + TS-set inline styles come from :root tokens"
