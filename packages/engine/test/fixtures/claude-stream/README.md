# claude-stream fixtures

Real recordings of `claude -p --output-format stream-json --verbose` sessions,
captured by `scripts/poc/translate-poc.mjs` (issue #3) on 2026-06-12 with
claude CLI on macOS, model `haiku`, subscription auth. Content is EN→KO
translation of a public-domain FOMC press-conference transcript. Sanitized:
no account/org identifiers (`apiKeySource:"none"`), cwd is a temp dir.

| File | What it captures |
|---|---|
| `session-with-partials.jsonl` | 20-turn session WITH `--include-partial-messages` (stream_event deltas, message_start/stop, cumulative-cost result events, system/thinking_tokens noise, rate_limit_event) |
| `session-without-partials.jsonl` | Same workload WITHOUT the flag (text arrives only in assistant wrappers — the older-CLI path #5 must support) |
| `error-invalid-model.jsonl` | Real error path: `result` with `is_error:true`, `api_error_status:404`, synthetic assistant message |

Gotchas these encode (do not hand-edit; re-record via the PoC script):
- `result.total_cost_usd` is CUMULATIVE within a session
- prompt caching starts mid-session (~turn 10) once history >4k tokens
- `system/thinking_tokens` and `system/post_turn_summary` events appear even with thinking disabled-by-budget
