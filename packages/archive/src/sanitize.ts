// Filename sanitization (SECURITY.md: "Archive writer: path traversal via
// LLM-generated session titles"). The title comes from model output and is
// fully untrusted. The output here is a SINGLE filename segment — never a path:
// it can contain no separators, no traversal, no control chars.

/** Max length of the title portion of a filename (chars, before ".md"). */
export const MAX_TITLE_LENGTH = 80;

/** Fallback when a title sanitizes to nothing. */
export const FALLBACK_TITLE = "Untitled session";

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
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH).trim();
  }
  return title === "" ? FALLBACK_TITLE : title;
}

/** Build the archive filename for a sanitized title: `<prefix> — <title>.md`. */
export function archiveFileName(fileNamePrefix: string, rawTitle: string): string {
  return `${fileNamePrefix} — ${sanitizeTitle(rawTitle)}.md`;
}
