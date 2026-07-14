// Shared inline-SVG glyph strings. Extracted so the same ✕ renders identically
// across the inline feed cards (main.ts), the review surface (review.ts), and the
// dashboard (dashboard.ts) — adjusting the stroke/path in one place now updates
// all three instead of leaving two surfaces with a visually different close icon.

/** Close/dismiss ✕ glyph. */
export const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
