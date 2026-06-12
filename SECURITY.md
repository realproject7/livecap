# Security Policy

LiveCap processes live meeting audio and transcripts — privacy is the product. We treat security reports accordingly.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](../../security/advisories/new) (Security tab → "Report a vulnerability"). Do **not** open a public issue for security problems.

You can expect an acknowledgment within 72 hours.

## Scope of special interest

- Any path by which audio, captions, or transcripts could leave the machine unintentionally (network calls outside the selected engine, logs, crash reports)
- Screen-capture exclusion failures (the overlay appearing in shared/recorded screens)
- The CLI engine adapter: command injection via transcript content, environment leakage into spawned processes
- Archive writer: path traversal via LLM-generated session titles

## Out of scope

- Vulnerabilities in the user's own Claude/Codex CLI installation or their chosen local model weights
- Issues requiring an already-compromised local machine

## Supported versions

Pre-1.0: only the latest release is supported.
