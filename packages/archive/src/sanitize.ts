// Filename sanitization (SECURITY.md: "Archive writer: path traversal via
// LLM-generated session titles"). The title comes from model output and is
// fully untrusted. The output here is a SINGLE filename segment — never a path:
// it can contain no separators, no traversal, no control chars.

/**
 * Max UTF-8 BYTE budget for the title portion of a filename (#32). Filesystems
 * cap filenames at 255 bytes, not characters — an 80-char CJK title is 240
 * bytes and overflows once the `<prefix> — ….md` wrapper is added. 180 bytes
 * leaves headroom for the prefix, the `.md` suffix, and a collision suffix.
 */
export const MAX_TITLE_BYTES = 180;

const UTF8 = new TextEncoder();

/** Truncate to at most `maxBytes` of UTF-8, never splitting a code point. */
function truncateToByteBudget(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  // for…of iterates by Unicode code point, so a surrogate pair (emoji) is never
  // split into a lone surrogate.
  for (const ch of text) {
    const chBytes = UTF8.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    out += ch;
  }
  return out;
}

/** Fallback when a title sanitizes to nothing. */
export const FALLBACK_TITLE = "Untitled session";

/** The in-progress working-file title sentinel — a finalized archive must never
 *  reuse it as a title, or its `<prefix> — (recording).md` filename would be
 *  misread as a crashed recording by retention/adopt (#178). Defined here (not in
 *  writer.ts) so [`sanitizeTitle`] can guard against it without a circular import;
 *  re-exported from writer.ts for the retention sweep's marker. */
export const WORKING_TITLE = "(recording)";

// Characters that must never reach a filename:
// - the NUL/C0 control range and DEL
// - ASCII path separators
// - Windows-reserved characters
// - Unicode separator look-alikes (fraction/division/fullwidth slashes,
//   fullwidth backslash, big solidus pair) some tools/filesystems treat oddly
// eslint-disable-next-line no-control-regex -- intentionally matching control chars to strip them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const PATH_SEPARATORS = /[/\\]/g;
const WINDOWS_RESERVED = /[<>:"|?*]/g;
const UNICODE_SEPARATOR_LOOKALIKES = /[\u2044\u2215\uff0f\uff3c\u29f8\u29f9]/g;
// Bidi/format controls (RLO and friends, line/para separators) — a filename
// spoofing risk, not traversal, but strip them so titles cannot be reordered.
const BIDI_FORMAT_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/**
 * Sanitize an LLM-generated title into one safe filename segment.
 * Guarantees: no `/` or `\`, no control chars, not "."/"..", not empty,
 * length-capped. Whitespace is collapsed and trimmed; leading/trailing dots
 * (hidden files, Windows quirks) are stripped.
 */
export function sanitizeTitle(raw: string): string {
  let title = (raw ?? "").normalize("NFC");
  title = title.replace(CONTROL_CHARS, "");
  title = title.replace(BIDI_FORMAT_CONTROLS, "");
  title = title.replace(PATH_SEPARATORS, " ");
  title = title.replace(UNICODE_SEPARATOR_LOOKALIKES, " ");
  title = title.replace(WINDOWS_RESERVED, "");
  title = title.replace(/\s+/g, " ").trim();
  // Strip leading/trailing dots and spaces so no result is a dotfile or a
  // "." / ".." segment (handles interleaved runs like ".. .. x").
  title = title.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  // Truncate by UTF-8 bytes (not chars) at a code-point boundary (#32), then
  // re-trim any trailing space the cut may have exposed.
  title = truncateToByteBudget(title, MAX_TITLE_BYTES).replace(/[.\s]+$/, "");
  // A finalized title must never BE the in-progress sentinel (#178): otherwise the
  // finalized file `<prefix> — (recording).md` collides with the working-file
  // grammar and retention/adopt misread this real session as a crashed orphan
  // (exempt from the sweep, then re-titled from its first summary line).
  if (title === "" || title === WORKING_TITLE) return FALLBACK_TITLE;
  return title;
}

/** Build the archive filename for a sanitized title: `<prefix> — <title>.md`. */
export function archiveFileName(fileNamePrefix: string, rawTitle: string): string {
  return `${fileNamePrefix} — ${sanitizeTitle(rawTitle)}.md`;
}
