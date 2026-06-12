# LiveCap Design Package

> Produced 2026-06-12 via Open Design media pipeline (icons) + HTML/CSS mockups (screens).
> Source of truth for visual decisions: `~/Projects/docs/PROPOSAL-live-caption-translator.md` §7 (Glass concept) and §8 (wireframes).
> Open Design project: `livecap-design-4a7b21c9` (regeneration/i2i anchors live there).

## How this package was made

- **Icons** — generated with Open Design (Gemini `gemini-3.1-flash-image-preview` for exploration, i2i refinement, then one `gpt-image-2` final pass). Per the media manual, anything with real text is NOT AI-generated.
- **Screens** — hand-built HTML/CSS on the Glass tokens (`system/tokens.css`), screenshotted at 2× via headless Chrome. Edit the HTML in `screens/src/` and re-screenshot to iterate; do not edit the PNGs.

## Contents

### `system/` — design system
| File | What it is | Proposal ref |
|---|---|---|
| `tokens.css` | Canonical Glass tokens: colors, type scale, glass material, atoms (live dot, chips, caption blocks) | §7.2 |
| `design-system.png` | One-sheet: five rules, color tokens, type scale, 5 caption-block states, atoms | §7.1–7.2, §8.3 |

### `icons/`
| File | What it is | Proposal ref |
|---|---|---|
| `app-icon-final.png` | Final app icon (gpt-image-2, 1024²): frosted-glass squircle, luminous caption bar over dim bar, amber live dot | §7.2 |
| `menubar-glyph.svg` | Menu bar template glyph (vector, production asset; black = template image, macOS recolors) | §8.8 |
| `explorations/` | Gemini exploration rounds (01–04 icons, 2 glyph candidates). `app-icon-04-refined.jpg` is the i2i anchor for the final | — |

### `screens/` — hi-fi mockups (PNG @2×, sources in `src/`)
| File | Screen | Proposal ref |
|---|---|---|
| `02-panel-live.png` | Panel mode (main): chrome row, live summary strip, them/me caption feed, pinned block, streaming partial, reply chips, quick translate | §8.2 |
| `03-strip-mode.png` | Strip mode: TV-subtitle bar, bottom-center dock | §8.1 |
| `04-capsule-mode.png` | Capsule mode: one-line pill, top-right | §8.1 |
| `05-summary-board.png` | Summary + Board tabs | §8.4 |
| `06-onboarding.png` | First-run, 3 steps: audio → language → engine detection | §8.6 |
| `07-settings.png` | Settings sheet incl. engine segmented control, credit gauge, Archive group, privacy rows | §8.7, §8.9 |
| `08-menubar.png` | Menu bar glyph (live state) + dropdown with pool gauge | §8.8 |

## Ticket mapping hints

- Panel/Strip/Capsule window shell ticket → `02`–`04` + §7.3 behavior table
- Caption rendering ticket → `system/design-system.png` (5 states) + `02`
- Onboarding ticket → `06`; Settings ticket → `07`; Menu bar ticket → `08` + `icons/menubar-glyph.svg`
- App packaging ticket → `icons/app-icon-final.png` (needs .icns derivation at 16–1024)

## Known gaps (not yet designed)

- Light-mode variant (deliberately deferred — overlay is dark-glass by concept)
- Engine-fallback toast, error/edge states, archive folder picker dialog
- Windows variants
