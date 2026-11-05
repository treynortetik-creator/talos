# Claude Code fixtures

`permission-requests.json`: `notifications/claude/channel/permission_request` params, one per documented rule of the
channels reference ("Permission request fields", fetched 2026-10-29): the 5-letter id alphabet (a-z without `l`), the
`Run shell command` constant, the counted `⋯ N code points elided ⋯` marker, `(value unserializable)`, `[REDACTED]`,
the pre-2.1.211 200-unit cut with a trailing ellipsis, and a repeated id. Each case lists the hidden reasons the
protocol must find and whether the card may show Allow.

These are shaped by the docs, not recorded. The first real request seen during the Mac smoke run (docs/CLAUDE-CODE.md
C10, C11) is added here as `recorded-*.json`, with nothing personal in it.
