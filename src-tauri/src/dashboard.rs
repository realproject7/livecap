//! Dashboard data feed (#90): list + read the saved session Markdown files from
//! the archive folder so the webview can parse them with `@livecap/archive`
//! (#98) and render the dashboard.
//!
//! The archive folder is resolved exactly like a session's writer destination
//! (`session::archive_dir`): the Settings folder pick when set, otherwise
//! `~/Documents/LiveCap` (PROPOSAL §8.9).
//!
//! Scaling (#144): opening the dashboard no longer slurps every archived file's
//! full body. `list_session_index` returns only each session's FRONT MATTER
//! (everything up to `## Transcript`) — enough for the history list + overview
//! stats — so open time is bounded regardless of transcript size. A single
//! session's full body is fetched lazily by `read_archived_session` when its
//! detail opens, and `list_archived_sessions` (full bodies) backs the complete
//! transcript-body search (#131) on demand. Only files matching the writer's
//! `"<date> <clock> — <title>.md"` grammar are listed (N-3), never arbitrary
//! `.md`.
//!
//! SECURITY.md / EPIC #1: caption content lives only inside the returned
//! payload — it is NEVER logged. Errors and any diagnostics carry file names and
//! byte LENGTHS only, never the file contents.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::session;
use crate::settings::SettingsState;

/// One saved session's full document handed to the webview: its file name plus
/// the raw Markdown to be parsed client-side with `parseSession` (#98). Used by
/// the lazy per-session detail load and the on-demand full-text search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchivedSession {
    /// File name only (e.g. "2026-06-11 1045 — Title.md"); not the full path, so
    /// nothing about the user's directory layout leaks into the webview.
    pub name: String,
    /// The file's full Markdown contents (parsed by the webview, never logged).
    pub markdown: String,
}

/// One saved session's lightweight index row (#144): its file name plus only the
/// document FRONT MATTER (up to `## Transcript`) — the H1 title, the meta line,
/// and the Summary/Board/Metrics sections. That is everything `parseSession` +
/// `aggregateSessions` need for the history list and the overview stats; the
/// transcript + coaching bodies are intentionally omitted so open time is
/// bounded regardless of archive size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionHeader {
    /// File name only (e.g. "2026-06-11 1045 — Title.md").
    pub name: String,
    /// The document front matter (parsed by the webview, never logged). Never the
    /// full body — the potentially large transcript is not read (AC (a), #144).
    pub markdown: String,
}

/// The section header that begins the (potentially large) transcript body. The
/// writer emits it verbatim on its own line (`render.ts` renderFrontMatter), so
/// the front-matter scan can stop exactly here.
const TRANSCRIPT_HEADER: &str = "## Transcript";

/// The writer's fixed date+clock filename prefix width: `"YYYY-MM-DD HHMM"`
/// (`4-1-2-1-2 space 4` = 15 ASCII bytes; see `session.ts` fileNamePrefix).
const PREFIX_LEN: usize = 15;

/// The separator between the date/clock prefix and the title in a session
/// filename: a space, U+2014 EM DASH, space (`archiveFileName`, sanitize.ts).
const NAME_SEP: &str = " — ";

/// Whether `prefix` is exactly the writer's `"YYYY-MM-DD HHMM"` date+clock stem
/// (all-ASCII, so byte indexing is code-point aligned).
fn is_date_clock_prefix(prefix: &str) -> bool {
    let b = prefix.as_bytes();
    if b.len() != PREFIX_LEN {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    digit(0)
        && digit(1)
        && digit(2)
        && digit(3)
        && b[4] == b'-'
        && digit(5)
        && digit(6)
        && b[7] == b'-'
        && digit(8)
        && digit(9)
        && b[10] == b' '
        && digit(11)
        && digit(12)
        && digit(13)
        && digit(14)
}

/// Whether a directory entry is a saved session document the dashboard reads:
/// a regular, non-dotfile whose name matches the writer's
/// `"<date> <clock> — <title>.md"` grammar (N-3, #144) — NOT arbitrary `.md`.
/// Rejects any name carrying a path separator so it doubles as a traversal guard
/// for the untrusted `read_archived_session` argument. Pure so it is
/// unit-testable without a filesystem.
fn is_session_file(name: &str, is_file: bool) -> bool {
    if !is_file || name.starts_with('.') {
        return false;
    }
    // A session filename is a single path component — never a path.
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    // Split on the first `" — "`; the date/clock prefix contains none, so the
    // first occurrence is always the real separator even if the title has one.
    let Some(sep_at) = name.find(NAME_SEP) else {
        return false;
    };
    if !is_date_clock_prefix(&name[..sep_at]) {
        return false;
    }
    // The title (everything after the separator, before `.md`) must be non-empty.
    let title_with_ext = &name[sep_at + NAME_SEP.len()..];
    let lower = title_with_ext.to_ascii_lowercase();
    let Some(title) = lower.strip_suffix(".md") else {
        return false;
    };
    !title.is_empty()
}

/// Read only a session's FRONT MATTER: every line UP TO the `## Transcript`
/// header. The transcript + coaching bodies (the only parts that grow without
/// bound) are never read, so this is bounded I/O regardless of file size — the
/// core of AC (a) (#144). The slice still carries the H1 title, the meta line,
/// and the Summary/Board/Metrics sections, which is all `parseSession` needs for
/// the index and the overview stats.
///
/// Returns `None` on an I/O error so the caller skips the file rather than
/// failing the whole listing (mirrors the full-read path). Reconstructs with
/// `\n`; the webview parser splits on `/\r?\n/`, so a `\r\n` source round-trips.
fn read_session_header(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut header = String::new();
    for line in reader.lines() {
        let line = line.ok()?;
        if line == TRANSCRIPT_HEADER {
            break;
        }
        header.push_str(&line);
        header.push('\n');
    }
    Some(header)
}

/// Iterate the session `.md` files in `dir` (writer grammar only), newest file
/// name first, applying `read` to each entry's path. A missing directory (no
/// session ever saved) is NOT an error — it yields an empty list. An entry whose
/// `read` returns `None` (unreadable) is skipped rather than failing the listing.
fn collect_sessions<T>(
    dir: &Path,
    mut read: impl FnMut(&str, &Path) -> Option<T>,
    name_of: impl Fn(&T) -> &str,
) -> Result<Vec<T>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // No archive folder yet → empty dashboard, not an error.
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read the archive folder: {e}")),
    };

    let mut sessions: Vec<T> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_session_file(&name, is_file) {
            continue;
        }
        if let Some(item) = read(&name, &entry.path()) {
            sessions.push(item);
        }
    }

    // The writer names files "<date> <clock> — <title>.md", so a plain reverse
    // lexicographic sort puts the newest session first.
    sessions.sort_by(|a, b| name_of(b).cmp(name_of(a)));
    Ok(sessions)
}

/// Read the lightweight session index from `dir`: file name + front matter only,
/// newest first. Bounded per file (front matter, not the body) — no full-archive
/// slurp (#144).
fn read_index_dir(dir: &Path) -> Result<Vec<SessionHeader>, String> {
    collect_sessions(
        dir,
        |name, path| {
            read_session_header(path).map(|markdown| SessionHeader {
                name: name.to_owned(),
                markdown,
            })
        },
        |s| &s.name,
    )
}

/// Read every saved session `.md` file's FULL body from `dir`, newest first.
/// Backs the on-demand full-text search (#131); an unreadable file is skipped.
fn read_archive_dir(dir: &Path) -> Result<Vec<ArchivedSession>, String> {
    collect_sessions(
        dir,
        |name, path| {
            // Skip an unreadable file rather than failing the whole dashboard; the
            // error string is intentionally dropped (it could echo a path).
            fs::read_to_string(path).ok().map(|markdown| ArchivedSession {
                name: name.to_owned(),
                markdown,
            })
        },
        |s| &s.name,
    )
}

/// The lightweight session index for the dashboard overview + history list
/// (#144): each session's file name + front matter (up to `## Transcript`),
/// newest first. Open time is bounded regardless of archive size — the webview
/// parses these small slices with `parseSession` for the stats and history rows,
/// and fetches a full body only when a detail opens (`read_archived_session`).
#[tauri::command]
pub fn list_session_index(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<Vec<SessionHeader>, String> {
    let snapshot = settings.snapshot();
    let dir = session::archive_dir(&app, &snapshot);
    read_index_dir(&dir)
}

/// Read ONE saved session's full Markdown by file name (#144, lazy detail load).
///
/// `name` is untrusted webview input, so it is accepted ONLY when it is a bare
/// session filename matching the writer grammar: `is_session_file` rejects path
/// separators, dotfiles, and non-grammar names, and the single-component check
/// rejects any `..`/path so the read can never escape the archive folder.
#[tauri::command]
pub fn read_archived_session(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    name: String,
) -> Result<String, String> {
    let single_component =
        Path::new(&name).file_name().and_then(|f| f.to_str()) == Some(name.as_str());
    if !single_component || !is_session_file(&name, true) {
        return Err("not a session file".to_string());
    }
    let snapshot = settings.snapshot();
    let dir = session::archive_dir(&app, &snapshot);
    fs::read_to_string(dir.join(&name)).map_err(|_| "could not read the session".to_string())
}

/// List + read the saved session files' FULL bodies from the archive folder.
/// Backs the dashboard's complete transcript-body search (#131), loaded on
/// demand (not on open) so the just-shipped search never regresses to
/// loaded/title-only matching (#144). Returns each session's file name + raw
/// Markdown; the webview parses them with `@livecap/archive` (#98).
#[tauri::command]
pub fn list_archived_sessions(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<Vec<ArchivedSession>, String> {
    let snapshot = settings.snapshot();
    let dir = session::archive_dir(&app, &snapshot);
    read_archive_dir(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_writer_grammar_markdown_files_are_session_documents() {
        // The writer's "<date> <clock> — <title>.md" grammar (N-3, #144).
        assert!(is_session_file("2026-06-11 1045 — Title.md", true));
        assert!(is_session_file("2026-06-11 1045 — (recording).md", true)); // in-progress working file
        assert!(is_session_file("2026-06-11 1045 — Title (2).md", true)); // collision variant
        assert!(is_session_file("2026-06-11 1045 — A — B.md", true)); // a title containing " — "
        assert!(is_session_file("2026-06-11 1045 — Title.MD", true)); // case-insensitive extension

        // Rejected: no date/clock prefix, wrong extension, empty title, dotfiles,
        // directories, and — critically — anything with a path separator (N-3 +
        // traversal guard for `read_archived_session`).
        assert!(!is_session_file("UPPER.MD", true)); // no writer prefix
        assert!(!is_session_file("notes.txt", true)); // wrong extension
        assert!(!is_session_file("my personal notes.md", true)); // arbitrary .md
        assert!(!is_session_file("README.md", true));
        assert!(!is_session_file("2026-06-11 1045 — .md", true)); // empty title
        assert!(!is_session_file("2026-6-11 1045 — Title.md", true)); // malformed date
        assert!(!is_session_file("2026-06-11 145 — Title.md", true)); // malformed clock
        assert!(!is_session_file("session.md", false)); // a directory named *.md
        assert!(!is_session_file(".hidden.md", true)); // dot file
        assert!(!is_session_file("2026-06-11 1045 — ../evil.md", true)); // traversal
        assert!(!is_session_file("2026-06-11 1045 — a/b.md", true)); // separator
        assert!(!is_session_file("", true));
    }

    #[test]
    fn missing_archive_folder_is_an_empty_list_not_an_error() {
        let dir = std::env::temp_dir().join("livecap-dashboard-does-not-exist-xyz");
        let _ = fs::remove_dir_all(&dir);
        assert!(read_index_dir(&dir)
            .expect("missing dir is not an error")
            .is_empty());
        assert!(read_archive_dir(&dir)
            .expect("missing dir is not an error")
            .is_empty());
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "livecap-dashboard-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn full_read_lists_markdown_newest_first_and_skips_non_session_files() {
        let dir = temp_dir("full");
        fs::write(dir.join("2026-06-10 0900 — A.md"), "# A\n> body a").unwrap();
        fs::write(dir.join("2026-06-11 1000 — B.md"), "# B\n> body b").unwrap();
        fs::write(dir.join("README.txt"), "ignored").unwrap();
        fs::write(dir.join("my personal notes.md"), "# Notes\nnot a session").unwrap();
        fs::create_dir(dir.join("2026-06-12 1100 — dir.md")).unwrap(); // a directory must be ignored

        let sessions = read_archive_dir(&dir).expect("read archive dir");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(sessions.len(), 2, "only the two writer-grammar .md files");
        // Newest file name first.
        assert_eq!(sessions[0].name, "2026-06-11 1000 — B.md");
        assert_eq!(sessions[0].markdown, "# B\n> body b");
        assert_eq!(sessions[1].name, "2026-06-10 0900 — A.md");
    }

    /// AC (a) (#144): the index must be bounded — it reads only the front matter,
    /// never the transcript body — regardless of archive size. Proven
    /// deterministically (not by timing): a large synthetic archive whose every
    /// transcript carries a unique sentinel yields index headers that contain the
    /// meta line but NEVER the sentinel, so the body was provably not slurped.
    #[test]
    fn index_reads_only_front_matter_never_the_transcript_body() {
        let dir = temp_dir("index-bounded");

        const SENTINEL: &str = "TRANSCRIPT_BODY_SENTINEL_ dc0ffee";
        // Many sessions, each with a huge transcript, to model a grown archive.
        for i in 0..40 {
            let name = format!("2026-06-{:02} 1000 — Session {i}.md", (i % 27) + 1);
            let mut body = String::new();
            body.push_str(&format!("# Session {i}\n"));
            body.push_str("> 2026-06-11 10:00–11:00 (60 min) · EN → KO · engine: Claude CLI ($0.42)\n");
            body.push_str("\n## Summary\n- did things\n");
            body.push_str("\n## Metrics\n**Talk ratio (me)** — 55%\n**Smooth Score** — 77\n");
            body.push_str("\n## Transcript\n");
            // A large body carrying the sentinel on many lines.
            for j in 0..5000 {
                body.push_str(&format!("**Me** (10:{j:02}) — {SENTINEL} line {j}\n> 번역\n\n"));
            }
            fs::write(dir.join(&name), body).unwrap();
        }

        let index = read_index_dir(&dir).expect("read index dir");
        let full = read_archive_dir(&dir).expect("read full dir");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(index.len(), 40, "every session is indexed");
        for header in &index {
            // Front matter is present…
            assert!(
                header.markdown.contains("## Metrics"),
                "index keeps the front matter (meta/summary/metrics)"
            );
            assert!(
                header.markdown.contains("Smooth Score"),
                "metrics survive for the overview stats"
            );
            // …but the transcript body is NOT — no full-archive slurp.
            assert!(
                !header.markdown.contains(SENTINEL),
                "the transcript body is never read into the index"
            );
            assert!(
                !header.markdown.contains(TRANSCRIPT_HEADER),
                "the scan stops at the transcript header"
            );
        }

        // The full-body command DOES carry the transcript (it backs search) —
        // confirming the index's omission is deliberate, not an empty archive.
        assert!(full.iter().all(|s| s.markdown.contains(SENTINEL)));
    }

    #[test]
    fn index_keeps_the_recording_and_the_webview_filters_it() {
        let dir = temp_dir("index-recording");
        fs::write(
            dir.join("2026-06-12 1100 — (recording).md"),
            "# (recording)\n> 2026-06-12 11:00 (0 min) · EN → KO · engine: Claude CLI ($0.00)\n\n## Transcript\n",
        )
        .unwrap();
        let index = read_index_dir(&dir).expect("read index dir");
        let _ = fs::remove_dir_all(&dir);
        // The grammar accepts it (title "(recording)"); the webview drops it via
        // parseSession isRecording. The front matter carries the working title.
        assert_eq!(index.len(), 1);
        assert!(index[0].markdown.contains("# (recording)"));
    }
}
