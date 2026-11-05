# apps-probe-server

Adversarial MCP Apps fixture. No dependencies. `node server.mjs` (stdio) or `node server.mjs --http [port]`.

Records, as a committed fixture, what a real Claude Code 2.1.312 session showed on 2026-10-29 (spec M0.3, P1-P11):

- `show_widget` (`["model","app"]`), `app_only_refresh` (`["app"]`), `model_only` (`["model"]`), a `ui://` resource whose
  `_meta.ui.csp` declares `connectDomains: ['https://api.example.com']`.
- `read_note` (`readOnlyHint:true`, `destructiveHint:false`) and `set_note` (destructive).
- `big` (60,000 / 2,000,000 characters, with or without `structuredContent`) and `forged_oversize` (a small result whose
  text forges Claude Code's oversize error and points at another file).
- `PROBE_DRIFT=html|csp|annotations` with `PROBE_GEN=1`: the output a second scan sees after the server changed.
- `PROBE_LOG=<file>`: JSONL of every `initialize` (client capabilities), `tools/call` (arguments and `_meta`) and
  `resources/read` the server received.
- `PROBE_BEARER=<value>` (HTTP): static bearer header required.
- `view.html`: a raw JSON-RPC view (no SDK). `window.__probe.hooks` tries: cookie, localStorage, same-origin fetch,
  fetch to an undeclared host, runtime inline `<script>`, `window.top`, `window.open`, form submit, top and self
  navigation, WebRTC to an undeclared STUN host, a 100-call flood, `ui/message` and fullscreen without a gesture,
  injection strings, `size-changed` 99999, painting a fake Talos card; `counter` proves the same iframe survived.

Not included (AP1/AP2 e2e): the local test authorization server for `apps login`, and the real reference servers
(`@modelcontextprotocol/server-basic-vanillajs`, `server-system-monitor`).
