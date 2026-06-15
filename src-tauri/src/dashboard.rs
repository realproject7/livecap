//! Dashboard data feed (#90): list + read the saved session Markdown files from
//! the archive folder so the webview can parse them with `@livecap/archive`
//! (#98) and render the dashboard.
//!
//! The archive folder is resolved exactly like a session's writer destination
//! (`session::archive_dir`): the Settings folder pick when set, otherwise
//! `~/Documents/LiveCap` (PROPOSAL §8.9).
//!
//! SECURITY.md / EPIC #1: caption content lives only inside the returned
//! payload — it is NEVER logged. Errors and any diagnostics carry file names and
//! byte LENGTHS only, never the file contents.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::session;
use crate::settings::SettingsState;

/// One saved session handed to the webview: its file name plus the raw Markdown
/// to be parsed client-side with `parseSession` (#98).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchivedSession {
    /// File name only (e.g. "2026-06-11 1045 — Title.md"); not the full path, so
    /// nothing about the user's directory layout leaks into the webview.
    pub name: String,
    /// The file's full Markdown contents (parsed by the webview, never logged).
    pub markdown: String,
}

/// Whether a directory entry is a saved session document the dashboard reads:
/// a regular file whose name ends in `.md` (case-insensitive), excluding dot
/// files. Pure so it is unit-testable without a filesystem.
fn is_session_file(name: &str, is_file: bool) -> bool {
    is_file && !name.starts_with('.') && {
        let lower = name.to_ascii_lowercase();
        lower.ends_with(".md")
    }
}

/// Read every saved session `.md` file from `dir`, newest file name first.
///
/// A missing directory (no session has ever been saved) is NOT an error — it
/// yields an empty list so the dashboard shows its empty state. An unreadable
/// individual file is skipped rather than failing the whole listing.
fn read_archive_dir(dir: &Path) -> Result<Vec<ArchivedSession>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // No archive folder yet → empty dashboard, not an error.
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read the archive folder: {e}")),
    };

    let mut sessions: Vec<ArchivedSession> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_session_file(&name, is_file) {
            continue;
        }
        // Skip an unreadable file rather than failing the whole dashboard; the
        // error string is intentionally dropped (it could echo a path).
        if let Ok(markdown) = fs::read_to_string(entry.path()) {
            sessions.push(ArchivedSession { name, markdown });
        }
    }

    // The writer names files "<date> <clock> — <title>.md", so a plain reverse
    // lexicographic sort puts the newest session first.
    sessions.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(sessions)
}

/// List + read the saved session files from the archive folder for the
/// dashboard (#90). Returns each session's file name + raw Markdown; the
/// webview parses them with `@livecap/archive` (#98).
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
    fn only_markdown_regular_files_are_session_documents() {
        assert!(is_session_file("2026-06-11 1045 — Title.md", true));
        assert!(is_session_file("UPPER.MD", true)); // case-insensitive extension
        assert!(!is_session_file("notes.txt", true)); // wrong extension
        assert!(!is_session_file("session.md", false)); // a directory named *.md
        assert!(!is_session_file(".hidden.md", true)); // dot file
        assert!(!is_session_file("", true));
    }

    #[test]
    fn missing_archive_folder_is_an_empty_list_not_an_error() {
        let dir = std::env::temp_dir().join("livecap-dashboard-does-not-exist-xyz");
        let _ = fs::remove_dir_all(&dir);
        let result = read_archive_dir(&dir).expect("missing dir is not an error");
        assert!(result.is_empty());
    }

    #[test]
    fn reads_markdown_files_newest_first_and_skips_non_markdown() {
        let dir = std::env::temp_dir().join(format!(
            "livecap-dashboard-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");

        fs::write(dir.join("2026-06-10 0900 — A.md"), "# A\n> body a").unwrap();
        fs::write(dir.join("2026-06-11 1000 — B.md"), "# B\n> body b").unwrap();
        fs::write(dir.join("README.txt"), "ignored").unwrap();
        fs::create_dir(dir.join("subdir.md")).unwrap(); // a directory must be ignored

        let sessions = read_archive_dir(&dir).expect("read archive dir");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(sessions.len(), 2, "only the two .md files");
        // Newest file name first.
        assert_eq!(sessions[0].name, "2026-06-11 1000 — B.md");
        assert_eq!(sessions[0].markdown, "# B\n> body b");
        assert_eq!(sessions[1].name, "2026-06-10 0900 — A.md");
    }
}
