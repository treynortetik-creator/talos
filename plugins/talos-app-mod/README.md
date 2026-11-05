# Talos mod

Optional. Without it Talos still works: the app falls back to hook events and the status line, and greys out what needs
the mod. Design: `docs/CLAUDE-CODE.md` C2.3 and C3.4.

What this package does (WP-C2, read side and guard):

- Connects to the bridge on session start (`talos_mod_hello`, retried with backoff while the bridge's MCP server comes
  up), then syncs every 2 s from a timer (`talos_mod_sync`). Never inside an event hook. After `/reload-plugins` expect up
  to a minute before it reconnects (the bridge frees the link 30 s after the last sync, then the retry backoff runs).
- Reports session state (model, effort, busy and turn id, context `percent`, rate limits `percentUsed`, cost `usd`,
  surfaces) and an inventory (commands and skills with their source, plugins, MCP servers, model and effort lists). The
  mod hashes each entry, but only to decide locally whether anything changed; the protocol has no hash field, so any
  change resends the whole inventory (at most every 30 s).
- Reports a capability list. A Claude Code below 2.1.304, or a missing core method, makes the mod do nothing.
  Only capabilities this build can act on are reported (`inventory`, `permission_close`, and since WP-C3 `stop`, `compact`, `command`, `clear`, `model`, `effort`; `hooks/lib/controls.ts` runs the controls the bridge hands over, detached so a slow `/model` never blocks the 2 s sync).
- Guards the bridge's `talos_mod_*` tools in three places, all failing closed: `tool.check` and `tool.call` deny every
  caller (model, subagent), and `mcp.call`, which raises neither of those, denies every other plugin. When the mod is not
  loaded at all, the bridge refuses the tools itself.
- WP-A1 (`docs/SUBAGENTS.md`): the agents panel. `hooks/lib/agents.ts` merges three sources into one snapshot, sent
  only when it changed and only to a bridge whose hello lists `agents`: `$.agent.list()`, its own observe-only hooks
  (`agent.spawn`, `tool.call`, `turn.step`, `session.append`, `classic.Stop`, `session.end`), and the subagent status
  line tee's file when it is fresh. It reports `agents` and `agent_stop`. Stop runs `TaskStop` through `$.tool.call`
  from the tick. The tee is opt-in: `talos-app install-subagent-tee --agent-dir <dir> --dry-run`.
- Reports `prompt_open` / `prompt_closed` for the C3.4 closer. `input_hash` is sha256 of the call's input as compact JSON
  with all whitespace removed.

## Agents

- `heartbeat-triage` (`agents/heartbeat-triage.md`, see `docs/HEARTBEAT.md`): reads a Heartbeat run pack and returns a short
  summary and suggestions. Its only tool is `Read`: it cannot post,
  send or run a command, but it can read other files you can read, so its summary is treated as untrusted. The bridge's wake
  notification names it as `talos-app-mod:heartbeat-triage`.

## The key (hygiene, not a boundary)

The bridge writes a 0600 file, `mod.key`, under `$TALOS_APP_HOME`; the mod reads it with `$.fs`. The key never travels
and no tool result carries it. `talos_mod_hello` takes `{ ts, proof }` where `proof` is HMAC-SHA256 of `hello\n<ts>` under
the key; every `talos_mod_sync` carries `seq` and, in `mod_key`, the HMAC of `sync\n<seq>\n<canonical body>`. The bridge
checks the MAC, requires `seq` to rise and `ts` to be fresh and unused, rotates the key on each hello, refuses a hello
while a mod is live, and tells the app "mod offline" when the mod goes quiet for 30 s.

What this does and does not do: another plugin whose `mcp.call` hook sees the arguments sees data and a MAC, not the key,
and cannot forge or replay a call. A process that can read files can read the key; in bypass mode the model is one, so
the owner's signature on every control, checked by the bridge, is the boundary. The engine skips a plugin's own hooks for
its own calls, which is why the mod signs instead of letting a hook add a secret.

Load it with `--plugin-dir <TALOS_APP_DIR>/plugins/talos-app-mod`. The engine writes `.claude-plugin/types/` on load; it is
gitignored.

Check it (no session, sign-in or network; use an empty HOME):

```sh
HOME="$(mktemp -d)" claude plugin validate plugins/talos-app-mod
HOME="$(mktemp -d)" claude plugin test plugins/talos-app-mod
pnpm typecheck:mod
```

Engine rules worth knowing: `$` may never be bound, passed or read as a value (so `typeof $.x.y` is refused and capability
checks are probes), `$.clock.now()` is async, and the mod's environment has `crypto.subtle.digest` but not `importKey`
(the HMAC is built on `digest`).
