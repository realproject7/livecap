# Contributing to LiveCap

Thanks for your interest! LiveCap is pre-MVP; the workflow below is enforced from day one.

## Workflow

1. Pick or file an issue. Work happens against issues — no drive-by PRs for non-trivial changes.
2. Branch from `main`: `task/<issue-number>-<short-slug>` (e.g. `task/42-archive-writer`).
3. Open a PR with `Fixes #<issue>` in the body. Commit messages: `[#<issue>] Short description`.
4. CI must pass (lint, build, tests, no-stub gate). Direct pushes to `main` are blocked.

## Engineering policy (binding)

- **No mock/temp/stub code in application code.** Every PR ships the production implementation of its scope. Mocks and fixtures live only in test code. If a scope can't be completed for real, stop and comment on the issue — a smaller fully-working scope beats a full-width stubbed one. The full policy is in the [MVP epic](../../issues/1).
- **Acceptance criteria are executable.** Every AC maps to a test or a reproducible command documented in the PR description.
- **Simple beats clever.** This is a small app a user stares at during real meetings; prefer the boring, readable implementation.

## Security & privacy rules

- Never commit credentials, API keys, tokens, signing assets, transcripts, or model weights. `.gitignore` covers the known shapes; treat any new secret-shaped file as gitignored by default.
- Never log caption/transcript content at any log level in production code paths.
- The app must function with zero network access when the local engine is selected — don't add network calls outside the engine layer.

## Testing expectations

- Pure logic (engine adapters, stream parser, archive writer, credit accounting): unit tests with fixtures, runnable headless on Linux CI.
- App behavior (audio capture, overlay windows, screen-capture exclusion): verified on a real macOS machine — PRs touching these must include the manual verification steps and results in the description.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please don't open public issues for vulnerabilities.
