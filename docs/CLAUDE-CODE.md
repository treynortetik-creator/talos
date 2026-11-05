# Talos app: Claude Code integration addendum (rev 2.1)

> Extends the original build spec (not published) (v1 rev 2 + WP8 addendum) and follows its builder rules (section 0) unchanged. Section
> numbers are this addendum's own (`C0`...); where it changes a SPEC section it says so ("replaces 4.9"). The SPEC
> tables it changes are already updated in SPEC.md, and the calls made while building WP-C0/C0.5 are in SPEC.md's
> changelog. Copied from the design spec by `scripts/claude-code-doc.ts`.

## C0. Answer in one screen

- **Slash commands through a channel: not as commands.** A command is recognized only "at the start of your message"
  ([commands](https://code.claude.com/docs/en/commands.md)); channel events arrive wrapped in a `<channel>` tag
  ([channels-reference](https://code.claude.com/docs/en/channels-reference.md), "Notification format"). Nothing in the
  docs says a channel can run one (INFERENCE from absence). A chat channel plugin can answer its own commands and never forward them. Any other `/name` reaches Claude as text, and Claude may then load a matching skill
  with its Skill tool. That's why "slash commands work over a channel" holds for skills and never for `/compact`,
  `/model`, `/clear`, `/context`.
- **Talos gets real commands two ways:** built-ins through an optional **Talos mod** (a Claude Code hook module running
  in the session, `$.command.run`), skills by sending `/<name>` as a normal owner message so Claude runs them in the
  thread and their own invocation rules hold.
- **The mod also gives** live model, effort, context, cost and rate limits, a command list, Stop, Compact, and model and
  effort switching. Its API "may change between releases without notice" (the engine's own type file). Remote Control
  already offers much of this free; the owner chose to ship the mod in v1 anyway, optional and version-checked (≥2.1.304).
- **Permission prompts on the phone work today, without the mod,** through the documented channel permission relay. In
  bypass mode only explicit `ask` rules (and a few built-in cases) still prompt, so Talos ships an installer for a short
  ask-rule list: the dangerous calls reach the phone, everything else stays prompt-free.
- **Impossible from a channel or a mod:** restarting a crashed session, startup dialogs (dev-channel warning, workspace
  trust, MCP consent), `/login`, pickers with no argument form. Those wait for the desktop app.
- **Codex:** an optional delegate for image generation and second-opinion coding via `codex exec --json`. Codex computer
  use is documented only in the ChatGPT desktop app, so it stays a SMOKE item.
- **Threads** need rules for the agent and two UI fixes (C7). **Per-thread sessions:** option B now, C later (C8).

---

## C1. Research findings

### C1.1 Channels

| Fact                                                                                                                                                                                                                                                                                       | Source                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| A channel pushes `notifications/claude/channel {content, meta}`; Claude sees `<channel source=… meta…>content</channel>`                                                                                                                                                                   | channels-reference, "Notification format"      |
| Not acknowledged; while Claude is busy, events "are delivered together on the next turn"                                                                                                                                                                                                   | same                                           |
| Custom channels need `--dangerously-load-development-channels` during the preview                                                                                                                                                                                                          | channels-reference, "What you need"            |
| Relay: declare `claude/channel/permission: {}`; receive `permission_request {request_id, tool_name, description, input_preview}`; answer `permission {request_id, behavior}`                                                                                                               | channels-reference, "Relay permission prompts" |
| Terminal and every relaying channel stay live; "whichever answer arrives first" wins; the channel is not told when another answered                                                                                                                                                        | same, "How relay works"                        |
| Tool approvals only; "Project trust and MCP server consent dialogs don't relay"                                                                                                                                                                                                            | same                                           |
| `description` is Claude's summary, "never the command itself"; fields are sanitized, credential-masked, and past 3,500 code points per field the middle is replaced by `⋯ N code points elided ⋯`; unserializable values become `(value unserializable)`; "Treat both fields as untrusted" | same, "Permission request fields"              |
| A repeated id is dropped; "Neither verdict affects future calls"                                                                                                                                                                                                                           | same                                           |

### C1.2 Another channel plugin (removed)

The notes on the official chat channel plugin's relay (buttons to every allowlisted chat, `yes abcde` replies) were dropped with Telegram support. What matters here: any plugin that declares the relay can answer a prompt, and the first answer wins (see the note under C3).

### C1.3 Where real slash commands run remotely

| Surface                                                      | What runs                                                                                                                                                                         | Source                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Remote Control (claude.ai / Claude app on the local session) | Text-output commands, argument forms of `/model`, `/effort`, `/fast`, `/rename`, `/mcp` (text), `/config key=value`, `/autocompact`; pickers, `/plugin`, `/resume` are local-only | [remote-control](https://code.claude.com/docs/en/remote-control.md), "Limitations"                                                |
| A mod                                                        | Any command via `$.command.run({command, args})`, "as if the person typed `/command args`", queued until idle                                                                     | [mods reference](https://code.claude.com/docs/en/plugins/mods/reference.md); engine type file (written by 2.1.296), `command.run` |
| Agent SDK streaming query                                    | `supportedCommands()`, `interrupt()`, `setModel()`, `mcpServerStatus()`, `getContextUsage()`                                                                                      | [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript.md), "Query object"                                   |
| A channel                                                    | Nothing                                                                                                                                                                           | C1.1                                                                                                                              |

### C1.4 Mods

- Hook modules in a plugin, run "inside Claude Code"; can submit prompts, approve tool calls, call models
  ([mods overview](https://code.claude.com/docs/en/plugins/mods/overview.md)). On by default from 2.1.287; hooks run in
  the CLI, Desktop, VS Code, `claude -p`, the SDK and under Remote Control. `disableAllHooks`, `--bare`, `--safe-mode`
  turn user mods off.
- Talos uses (mods reference, "Mods API methods" and "Events"; minimum versions from the same pages):

| Need                                                                                    | API                                                                                                                                    | Min     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Commands                                                                                | `$.command.list()` → `{name, description, source: builtin\|plugin\|user\|mcp, plugin?}`; `$.command.run({command, args})`              | 2.1.287 |
| Session facts                                                                           | `$.session.model/version/id/cwd/surfaces`; `$.session.usage()` → `{startedAt, context{tokens?, window, percent?}, rateLimits[], cost}` | 2.1.287 |
| Compact                                                                                 | `$.session.compact({instructions})` ("the same call `/compact` makes"; rejects while a turn runs)                                      | 2.1.287 |
| Stop                                                                                    | `$.turn.abort({turnId})`; "Rejects… when `turnId` is not the running turn's"                                                           | 2.1.287 |
| Turns                                                                                   | `turn.start`, `turn.complete` (`isAborted`), `session.measure`                                                                         | 2.1.287 |
| Settings rows                                                                           | `$.config.list()` (rows with `kind`, `value`, `options` for choice rows), `$.config.set`                                               | 2.1.287 |
| Tools, subagents                                                                        | `$.tool.list()`, `$.agent.list()`; `tool.check` with `e.agentId`                                                                       | 2.1.290 |
| Interruption-safe calls beyond `prompt.submit`/`command.run`; `tool.check` `isReadOnly` |                                                                                                                                        | 2.1.304 |
| Bridge link                                                                             | `$.mcp.call(server, tool, args)`; "the plugin's call… is the grant"                                                                    | 2.1.287 |
- After the **user** interrupts, new-work calls "are refused until the user's next input" (mods api). `$.turn.abort`
  says "no interruption marker" (type file). **SMOKE S3.**
- A guard hook that throws "is skipped, leaving the verdict beneath" (type file, `tool.check` docs), so guards must catch.

### C1.5 Other sources

| Source                                                                                                                                                                                          | Gives                                                                                                                      | Limits                                                                                                                                                       | Doc                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Settings hooks: `SessionStart` (`model`, not always), `PostModelSwitch`, `PreCompact`/`PostCompact`, `Stop`, `Notification` (`permission_prompt` after ~6 s), `PermissionRequest`, `SessionEnd` | Events                                                                                                                     | No inventory or control; stdout of `SessionStart`/`PostModelSwitch` becomes context                                                                          | [hooks](https://code.claude.com/docs/en/hooks.md)                                                                              |
| Status line JSON                                                                                                                                                                                | `model`, `effort.level`, `cost.total_cost_usd`, `context_window.used_percentage`, `rate_limits.five_hour/seven_day`        | One `statusLine` per user; trigger-driven                                                                                                                    | [statusline](https://code.claude.com/docs/en/statusline.md)                                                                    |
| `claude agents --json [--all]`                                                                                                                                                                  | Interactive and background sessions: `working\|blocked\|done\|failed\|stopped`, `waitingFor`                               | Polling                                                                                                                                                      | [agent-view](https://code.claude.com/docs/en/agent-view.md), "Read session state from a script"                                |
| `RemoteTrigger` tool                                                                                                                                                                            | "Creates, updates, runs, and lists cloud scheduled tasks"; an API trigger "starts a new session and returns a session URL" | Cloud run status lives on claude.ai                                                                                                                          | [tools-reference](https://code.claude.com/docs/en/tools-reference.md); [routines](https://code.claude.com/docs/en/routines.md) |
| Transcript JSONL                                                                                                                                                                                | History                                                                                                                    | "may lag"; unstable                                                                                                                                          | hooks, "Common input fields"                                                                                                   |
| `claude mcp list` / `get`                                                                                                                                                                       | Health                                                                                                                     | "approved servers are health-checked" (`claude mcp --help`), which starts stdio servers (INFERENCE); a polling channel then conflicts. Never call from Talos |                                                                                                                                |

### C1.6 Permission modes (the bypass question)

- "Claude Code doesn't auto-approve the following in any mode, including `bypassPermissions`": tools matched by an
  **explicit ask rule**, connector tools an org set to `ask`, `AskUserQuestion` and MCP tools marked
  `requiresUserInteraction`, critical-path `rm`, cross-session safeguards
  ([permission-modes](https://code.claude.com/docs/en/permission-modes.md), "Actions no mode auto-approves").
- "Allow rules have no effect in `bypassPermissions`"; deny rules block in every mode (same page).
- Ask rules match nested subcommands ("`cd /tmp && git clean -f`" still prompts for `Bash(git clean *)`) and match past
  leading variable assignments ([permissions](https://code.claude.com/docs/en/permissions.md)).
- A PreToolUse hook "allow" doesn't skip a matching ask rule (permissions, hooks section).

### C1.7 Talos today

| Area               | State                                                 | Evidence                              |
| ------------------ | ----------------------------------------------------- | ------------------------------------- |
| Permission relay   | Deferred because agents run in bypass mode            | SPEC.md:736, :918-921, :2413          |
| Interrupt          | "No interrupt in v1 (an MCP server can't press Esc)"  | SPEC.md:893                           |
| Busy detection     | `queued` after 30 s delivered-not-seen                | SPEC.md:884-892                       |
| Session visibility | Presence only                                         | SPEC.md:472-476                       |
| Step-up            | Relay-checked, "stripped before forwarding"           | SPEC.md:542, 5.2                      |
| Test fakes         | FakeClaude models only `notifications/claude/channel` | `packages/testkit/src/fake-claude.ts` |

---

## C2. Session visibility

### C2.1 Sources, ranked

| Rank | Source                                                       | Use for                                                  |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------- |
| 1    | **Talos mod** (C2.3)                                         | Everything in C2.2                                       |
| 2    | Settings hooks → `talos-app hook-event` (C2.4)               | Model, busy/idle, compaction, restarts, "prompt waiting" |
| 3    | Status line tee, opt-in (C2.4)                               | Context, cost, rate limits without the mod               |
| 4    | `claude agents --json`                                       | Session state from outside; Sessions view (C4.6)         |
| 5    | Settings files, `claude plugin list`                         | "Configured" hints                                       |
| ✕    | Agent self-report, transcript parsing, `claude mcp list/get` | Never                                                    |

### C2.2 Models (owned by WP-C0.5, `packages/protocol/src/session.ts`)

Inbound engine data is parsed leniently (every field optional, `.passthrough()`); outbound frames stay strict.

```ts
export const SessionState = z.object({
  session_id: z.string().max(64),
  source: z.enum(['mod', 'hooks', 'statusline', 'agents_json']),
  capabilities: z
    .array(
      z.enum(['stop', 'compact', 'command', 'clear', 'model', 'effort', 'inventory', 'permission_close', 'sessions']),
    )
    .default([]),
  version: z.string().max(40).optional(),
  model: z.object({ id: z.string().max(80), display: z.string().max(40).optional() }).optional(),
  effort: z.string().max(16).optional(),
  permission_mode: z.string().max(24).optional(),
  busy: z.boolean().optional(),
  turn_id: z.string().max(64).optional(), // the running turn, for Stop
  compacting: z.boolean().optional(),
  stopped_at_mac: z.boolean().optional(), // "refused until the user's next input"
  context: z
    .object({
      tokens: z.number().int().optional(),
      window: z.number().int().optional(),
      percent: z.number().optional(),
    })
    .optional(),
  cost_usd: z.number().optional(), // client-side list-price estimate
  rate_limits: z
    .array(z.object({ kind: z.string().max(24), percent: z.number().optional(), resets_at: IsoTs.optional() }))
    .max(6)
    .default([]),
  surfaces: z.array(z.string().max(24)).max(8).default([]),
  at: IsoTs,
})
export const SessionInventory = z.object({
  commands: z
    .array(
      z.object({
        name: z.string().max(64),
        description: z.string().max(200),
        source: z.enum(['builtin', 'plugin', 'user', 'mcp']),
        plugin: z.string().max(64).optional(),
        route: z.enum(['control', 'message', 'local_only']), // C4.2
      }),
    )
    .max(400),
  models: z
    .array(z.object({ value: z.string().max(80), label: z.string().max(60), note: z.string().max(120).optional() }))
    .max(20),
  efforts: z.array(z.string().max(16)).max(8),
  mcp_servers: z
    .array(z.object({ name: z.string().max(64), tools: z.number().int(), status: z.enum(['connected', 'unknown']) }))
    .max(100),
  plugins: z.array(z.object({ name: z.string().max(80), enabled: z.boolean() })).max(200),
  codex: z
    .object({ installed: z.boolean(), version: z.string().max(24).optional(), logged_in: z.boolean().optional() })
    .optional(),
  at: IsoTs,
})
```

MCP health is honest: a server with tools in `$.tool.list()` is `connected`; anything else is `unknown`.

### C2.3 The Talos mod (`plugins/talos-app-mod/`, plain files, not a pnpm workspace)

- Loaded with `--plugin-dir <TALOS_APP_DIR>/plugins/talos-app-mod` on the launch line (SPEC 4.1, 12.1). Name must not
  start with `claude-` (`claude plugin validate` refuses it, [create a mod](https://code.claude.com/docs/en/plugins/mods/create.md)).
  `.claude-plugin/types/` (engine-written on load) is gitignored.
- **Capability check, not version check.** At `session.start` the mod tests `typeof` for every method it uses and
  reports `capabilities[]`; the app shows a control only if its capability is present. Below 2.1.304 the mod reports
  nothing and the app falls back to ranks 2-4.
- **Bridge link.**
  - Server name: the mod finds the bridge in `$.tool.list()` by its `talos_mod_hello` tool, not by a hard-coded name.
  - `talos_mod_hello {}` → `{mod_key}`. Allowed whenever the bridge has no live mod (no sync for 30 s); each call
    rotates the key and voids the old one. Covers `/reload-plugins` and bridge restarts.
  - `talos_mod_sync {mod_key, state?, inventory?, events?, results?}` → `{controls}`. Runs from **`$.clock.every(2000)`**,
    never inside an event hook (`$.command.run` "rejects… inside a hook the turn is waiting on"). The bridge answers at
    once; no long poll.
  - **Guard, fail closed.** `on('tool.check', …)` matches `mcp__*__talos_mod_*` for every caller, main or subagent
    (`e.agentId` set or not), returns `{decision:'deny'}`, wrapped in `.catch(() => ({ decision: 'deny' }))`.
    `tool.describe` sets both tools `isDeferred: true`; descriptions say "Internal to the Talos mod. Never call."
  - **What the key is.** Hygiene, not a boundary: in bypass mode the model can already run anything the mod can. The
    boundary is the bridge: it verifies `osig` on every `session.control` and applies C4.2 **before** queuing it. No
    security decision ever rests on mod-reported data; at most it marks a card "may already be answered".
- **Reports:** `session.start` → inventory + state + capabilities; `turn.start`/`turn.complete` → `busy`, `turn_id`;
  `session.measure` → `$.session.usage()`; `session.compact` → compacting; `session.attach/detach` → surfaces;
  `classic.PostModelSwitch` → model; a refused call whose reason contains "the session was stopped and nobody has sent
  input since" → `stopped_at_mac: true` (app: "Stopped at the Mac. Send a message to continue").
- **Executes:** C4.

### C2.4 Hooks-only fallback (no mod)

- `talos-app hook-event` reads hook JSON on stdin, writes `$TALOS_APP_HOME/state/events/<ulid>.json` atomically, prints
  **nothing** (stdout on `SessionStart` and `PostModelSwitch` becomes context), exits 0 in <100 ms. A command hook, not
  `mcp_tool`, because `mcp_tool` hooks are skipped at launch on `SessionStart` (hooks, "MCP tool hook fields").
- `talos-app install-hooks --agent-dir <dir> [--dry-run]` shows a diff of `.claude/settings.json`, asks y/N, adds
  `async: true` entries for the events in C1.5.
- `talos-app statusline-tee -- <original command…>` (opt-in, shown in Settings → Session with the exact change) writes
  the JSON to `state/statusline.json` and execs the user's own command with the same stdin.

### C2.5 Frames (adds to 3.4; owned by WP-C0.5)

| type                     | direction        | durable                                                     | fields                                                                                                                                                                                                 |
| ------------------------ | ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.state`          | bridge→relay→app | no; relay keeps the last, sends it in `ready.session_state` | `state`                                                                                                                                                                                                |
| `session.inventory`      | bridge→relay→app | no; last one in `ready.session_inventory`                   | `inventory`                                                                                                                                                                                            |
| `session.control` 🔏     | app→relay→bridge | yes                                                         | `control_id` (ULID), `thread_id`, `action` (`stop`\|`compact`\|`command`\|`clear`), `turn_id?` (required for `stop`), `command?` (builtin name), `args?` (≤500), `stepup?` (C3.6), `device_id`, `osig` |
| `session.control.result` | bridge→relay→app | yes                                                         | `control_id`, `ok`, `text` (≤4000, plain), `at`                                                                                                                                                        |
| `session.list`           | bridge→relay→app | no; last one cached                                         | `sessions` (C4.6)                                                                                                                                                                                      |
| `session.spawn` 🔏       | app→relay→bridge | yes                                                         | `spawn_id`, `thread_id`, `kind` (`subagent`\|`background`\|`cloud`), `prompt` (≤4000), `device_id`, `osig`                                                                                             |
- `session.agents` (bridge→relay→app, not durable, last one in `ready.session_agents`) and the `agent_stop` control
  belong to the subagent panel: [SUBAGENTS.md](SUBAGENTS.md).
- Controls and spawns join `CONSUMABLE_FRAME_TYPES`. For them **"consumed" = the result was recorded** (in
  `history.sqlite`), not "pushed as a notification", so a relay replay after a bridge restart finds the id in the
  persisted seen-ids and re-sends the stored result instead of running twice. A history kept aside (docs/bridge.md) has no stored results, so a control the owner signed before
  the reset time (plus 2 min of phone clock) is refused with `control_stale` and run by nothing.
- Stale guard: a control older than 2 min is refused (`card_expired`-style code `control_stale`). Stop also carries the
  `turn_id` the phone showed; the mod passes it to `$.turn.abort`, which refuses a mismatch itself.

---

## C3. Permission prompts on the phone (replaces SPEC 4.9 and the v1.1 row)

### C3.1 Making prompts exist in bypass mode

- Default (2026-11-03): `talos-app init` writes `permission_relay: true` into a new install's `config.json`, so prompts never need the terminal. The schema default stays `false`: a saved `false` is never flipped and a config with no key stays off. A worker (`server.ts`) never declares the permission capability and relays nothing. Switch: Settings → Health, "Tool prompts as approval cards".

- `talos-app install-ask-rules --agent-dir <dir> [--dry-run]`: shows a diff of the agent folder's
  `.claude/settings.json`, asks y/N, adds a short `permissions.ask` list. Generic default (edit before saving):
  `Bash(git push *)`, `Bash(rm -rf *)`, `Bash(rm -fr *)`, `Bash(rm -r *)`, `Bash(gh pr merge *)`,
  `Bash(gh release create *)`, `Bash(npm publish *)`, `Bash(* deploy *)`, `Bash(sh *)`, `Bash(bash *)`, and a set of rollback rules such as `Bash(*talos-app rollback*)`, `Bash(*cli.ts rollback*)`, `Bash(*cli rollback*)` (also with two spaces, a closing quote, or a quoted `"rollback"`; `rollback` must be the word right after the program, so a commit message or a `git add` of rollback.ts does not ask). They make an agent's
  rollback of the Mac's own code reach the owner, by the wrapper (bare, by path or quoted), the CLI file run directly, or `pnpm cli rollback`; a rule matches the command text, so rollback started any other way is not caught. An install from before a rule was added needs `install-ask-rules` run again, and `doctor` says so.
  An ask rule has nobody to ask in a headless run (a scheduled job), so there the call is refused. Ask rules apply
  per subcommand (permissions, "compound commands"), so a pipe-to-shell is caught by the `sh`/`bash` rules, not by a
  `curl … | sh` pattern; S12 confirms the matching.
- Ask rules prompt in every mode, bypass included (C1.6), so exactly these calls reach the phone and nothing else
  changes. **SMOKE S12** confirms an ask-rule prompt in bypass mode reaches a channel's relay.

### C3.2 The card

- **Kind** `'permission'` (WP-C0.5 adds it to `Card.kind`; the `card` tool's "destination required" rule exempts it;
  the agent's `card` tool **refuses** `kind:'permission'`: only the bridge mints them).
- **Binding** = `{request_id, tool_name, description, input_preview}` exactly as received, inside `payload`, so
  `payload_hash` covers all four.
- **Rendering**, plain text only (`body_format:'plain'`), no markdown anywhere:
  1. Title `Allow <tool_name>?`
  2. `input_preview` in a monospace field, **first**, never truncated by the app (scrolls)
  3. "Claude's summary:" + `description`, after it
  4. `primary_label: "Allow"`, `kill_label: "Deny"`, `allow_edit:false`, `allow_revise:false`, `origin:'background'`
- **Hidden parts.** If any field contains the elision marker (`⋯ … code points elided ⋯`) or `(value unserializable)`,
  the card has **no Allow button**, only Deny, and the warning "Part of this call is hidden. Approve at the Mac."
- **Risk.** `high` for Bash, Write, Edit, NotebookEdit and MCP tools; `low` otherwise.
- **Lifetime.** As long as the request: `expires_in_s` = 7 days. Claude Code ignores a verdict for a closed id, so a
  long-lived card is harmless.

### C3.3 Verdict path

- The bridge keeps the set of **open request ids** it received. A signed `card.resolve` passes the SPEC 4.5 ledger
  checks, then: PRIMARY → `permission{request_id, behavior:'allow'}` only if the id is still in the set; KILL → `deny`.
  The id leaves the set after one verdict.

### C3.4 Closing a card answered elsewhere

- Never supersede because a later request arrived (parallel prompts from subagents are normal).
- With the mod: its `tool.check` hook reports `prompt_open{tool_name, input_hash}` and later `prompt_closed{…}`. The
  bridge supersedes a card (reason `answered_elsewhere`) only on an exact `(tool_name, input_hash)` match with exactly
  one pending candidate. In auto mode `tool.check` can see `ask` before the classifier decides, so `prompt_open` alone
  never changes a card.
- Without the mod, after 60 s the card adds "May already be answered at the Mac".
- **SMOKE S13**: two concurrent prompts.

### C3.5 Threat model (ship this paragraph in the docs)

> A permission prompt goes to every channel that declares the relay, and the first answer wins. Your phone approval is
> only as strong as the weakest of them. If you rely on Talos for approvals, launch without other relaying channels
> (for example drop `--channels plugin:imessage@…`); `talos-app doctor` warns when another relaying channel is loaded.
> Talos's own cards can only be answered from a pinned, signed device; a mirrored copy elsewhere is text only.

### C3.6 Step-up for approvals (the `permission_stepup` setting was removed, 2026-11-01)

- The optional setting `permission_stepup: 'off'|'high'` is **gone** (owner call O3, SETTINGS-MAP). Nothing ever read it:
  the bridge refused every change to it and no verifier shipped. iPhone Approve already asks for device authentication.
  An old `config.json` that still has the key loads fine (unknown keys are stripped); a `config.patch` that names it is
  refused with `config_field_forbidden`.
- `permission_relay` keeps its step-up: changing it needs the relay's `config:session` token (`checkConfigPatch().stepupPurpose`).
- `StepupAssertion` stays on the wire for `card.resolve.stepup` and `session.control.stepup` (the shape and
  `stepupChallenge(payload_hash, frame id)` are unchanged), but nothing on the config side uses it:
  `CONFIG_MAC_STEPUP_FIELDS`, `macStepup`, the bridge's fail-closed branch and `configStepupChallenge` are deleted.
- The Mac-verified design that was planned (challenge `sha256(payload_hash + "\n" + frame id)`, checks listed in
  `STEPUP_BRIDGE_CHECKS`) is kept as a design note only.

### C3.7 Questions (P1, mod only)

`AskUserQuestion` always prompts and doesn't relay. A mod `tool.call` hook on it can raise a `decision` card with one
field per question and return `{result}`. **SMOKE S6.**

### C3.8 Not covered

Workspace trust, MCP consent, the dev-channel warning, the bypass disclaimer, login: startup dialogs, not tool prompts.

---

## C4. Session control from Talos

### C4.1 What is possible where

| Control                      | Channel           | Hooks  | Mod                                                                                                                        | Desktop app (pty)            |
| ---------------------------- | ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Stop the turn                | ✕                 | ✕      | `$.turn.abort({turnId})` (S3)                                                                                              | Esc                          |
| Compact                      | ✕                 | ✕      | `$.session.compact()`; mid-turn it rejects, the app says "Compacts after this turn" and the mod retries at `turn.complete` | yes                          |
| New conversation             | ✕                 | ✕      | `$.command.run({command:'clear'})`; threads survive (bridge store)                                                         | yes                          |
| Model, effort                | ✕                 | see it | C4.4                                                                                                                       | yes                          |
| Run a skill                  | model may load it | ✕      | not via the mod: C4.3                                                                                                      | yes                          |
| Resume an older conversation | ✕                 | ✕      | **SMOKE S7**                                                                                                               | yes                          |
| Restart after a crash        | ✕                 | ✕      | ✕                                                                                                                          | yes, restart-only guard (C5) |
| Startup dialogs, `/login`    | ✕                 | ✕      | ✕                                                                                                                          | at the Mac                   |
| Permission mode              | ✕                 | ✕      | refused by policy                                                                                                          | yes                          |

### C4.2 Command policy (bridge, `apps/bridge/src/session/policy.ts`), keyed on `(source, name)`

| Route                   | Which                                                                                                                                                                                                                                            | Rule                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control`               | `source:'builtin'` **and** on this allowlist, with an argument grammar: `context` (none), `usage` (none), `recap` (none), `mcp` (**none only**), `reload-plugins` (none; `--force` refused), `model` (C4.4), `effort` (C4.4), `fast` (`on\|off`) | `session.control{action:'command'}` → `$.command.run`                                                                                                                        |
| `control` (own actions) | `compact` (instructions ≤500) and `clear` (none; in-app confirm)                                                                                                                                                                                 | `action:'compact'` → `$.session.compact()` (C4.1); `action:'clear'` → `$.command.run({command:'clear'})`. Typing `/compact` or `/clear` in the palette maps to these actions |
| `message`               | `source` in `plugin`, `user`, `mcp` (skills, plugin commands, MCP prompts)                                                                                                                                                                       | Sent as a signed owner `message` with text `/<name> <args>` (C4.3)                                                                                                           |
| `local_only`            | Every other built-in, and any name whose `source` changed since the inventory the phone rendered                                                                                                                                                 | Greyed: "Run this at the Mac"                                                                                                                                                |
- A project or plugin skill that shadows a built-in name reports `source:'user'|'plugin'`, so it takes the `message`
  route and can't borrow a built-in's `control` rights.
- The phone sends the `(source, name)` it rendered; the bridge re-checks against the current inventory and refuses a
  mismatch (`command_changed`).
- Arguments never pass through a shell.

### C4.3 Skills from the phone

- The composer's `/` palette lists skills and plugin commands. Picking one sends an ordinary signed `message` in the
  current thread: `/<name> <args>`. Claude sees it in a `<channel>` tag with the thread id, loads the skill with its
  Skill tool if allowed, and replies in the thread.
- `disable-model-invocation: true` skills therefore **won't** run from the phone, by design (their authors reserved
  them for a person at the keyboard). The palette marks them "At the Mac only" when the inventory says so (from
  `$.command.list()` presence plus the absence of the skill from the model's list; if the mod can't tell, no mark).
  **SMOKE S5** checks how such skills appear in `$.command.list()`.

### C4.4 Model and effort controls (owner request)

| Fact                                                                                                                                                                                          | Source                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/model <alias\|id>` switches and "save[s] it as your default for new sessions"; works with an argument over Remote Control and in `-p`                                                       | [commands](https://code.claude.com/docs/en/commands.md) `/model`; remote-control "Limitations" |
| Aliases: `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`                                                                                          | [model-config](https://code.claude.com/docs/en/model-config.md), "Model aliases"               |
| `/effort <level>` sets effort; `auto` clears; `status` prints; levels depend on the model (`low…xhigh, max` on current models; `max` is session-only); the next message runs at the new level | model-config, "Adjust effort level", "When a new effort level starts"                          |
| Thinking can't be turned off on the current generation; effort is the control                                                                                                                 | model-config, "Extended thinking"                                                              |
| An admin `availableModels` list restricts every selection surface                                                                                                                             | model-config, "Restrict model selection"                                                       |
| `$.config.list()` returns `/config` rows with `options` for choice rows; a mod can also route a single request to another model in `turn.step`                                                | engine type file; mods events, "Follow a turn"                                                 |

Design:
- **Model picker** shows `config.session_models` (new config field, default `['default','opus','sonnet','haiku']`),
  intersected with the `model` row's options from `$.config.list()` when present (**SMOKE S4**). A value outside the
  list is refused (`model_not_allowed`). Adding `fable` or `best` shows "May use usage credits. The consent prompt
  appears only at the Mac." (remote-control "Limitations": that prompt "isn't forwarded").
- The pick runs `$.command.run({command:'model', args:<value>})`. The sheet says "Also becomes the default for new
  sessions" (documented behaviour).
- **Effort control**: a segmented row of the levels the current model supports (from `$.config.list()` if exposed, else
  the documented table), plus `auto`. Runs `$.command.run({command:'effort', args})`. Shows "Applies from the next
  message".
- **Thinking**: no toggle. One line: "This model always thinks; effort sets how much."
- Without the mod: both rows read-only from hooks or the status line.

**The warm-cache confirmation (rev 2.1).**

| Fact                                                                                                                                                                                                        | Source                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/model` asks to confirm "only while the cache is still warm and the new model isn't the one that produced the last response"                                                                               | [prompt-caching](https://code.claude.com/docs/en/prompt-caching.md), "Switching models" |
| A `PreModelSwitch` hook's `permissionDecision: "allow"` "proceeds and skips the confirmation"; `"deny"` cancels with a reason; precedence `deny` > `ask` > `allow`                                          | [hooks](https://code.claude.com/docs/en/hooks.md), "PreModelSwitch decision control"    |
| "Only `/model` in an interactive session can show the `ask` prompt. On every other surface… Claude Code treats `ask` as a refusal"                                                                          | same                                                                                    |
| Effort changes keep the cache, without asking, on Opus/Sonnet/Haiku 5.5 and Fable 5.1 (API key or subscription); on other models and some providers they ask while the cache is warm. No hook covers effort | prompt-caching, "Changing effort level"                                                 |

Design:
1. **Warn first.** Before sending, the picker shows "Switching re-reads the whole conversation: the next turn is slower and
   uses more of your limits." The owner's tap is the approval.
2. **Pre-approve exactly that switch.** The mod records a one-shot ticket `{to_model, control_id, expires: now+15 s}` and
   registers a `classic.PreModelSwitch` hook. If a switch arrives with a matching `to_model` inside the ticket's window,
   the hook returns `{hookSpecificOutput:{permissionDecision:'allow'}}` and burns the ticket; otherwise it returns
   nothing (no opinion). Then the mod runs `$.command.run({command:'model', args})`. A mod returning a classic-hook
   decision is **SMOKE S4b**. Fallback if it can't: `talos-app install-hooks` adds a `PreModelSwitch` command hook that
   reads the same one-shot ticket from `$TALOS_APP_HOME/state/model-switch.json` (written by the bridge, deleted on use)
   and prints the allow JSON only on a match.
3. **The user's own hooks still win.** A `deny` (or an `ask`, which outside the terminal is a refusal) beats the allow by
   precedence. The result comes back as `session.control.result{ok:false}` with code **`model_switch_denied`** and the
   hook's reason.
4. **Never hang silently.** If no `PostModelSwitch` (or model change in `session.state`) arrives within 15 s, the result
   is **`model_switch_pending`**: "Waiting for confirmation at the Mac." The ticket expires, so a late terminal answer is
   the owner's own.
5. **Effort.** On models that keep the cache, the change applies without asking. On the others, the control is marked
   "May ask at the Mac"; a change with no confirmed new level in 15 s returns **`effort_change_pending`**.

### C4.5 Session sheet (WP-C3)

- Opens from the header mascot or Settings → Session. Model pill + effort, context bar, "≈ $x.xx this session (list
  price)", the weekly and context bars (the 5-hour window is no longer shown; a peer that still sends it is read and ignored), busy word, version, "Also open in: …". Buttons by capability: Stop (busy only),
  Compact, Model ▾, Effort, New conversation.
- Tabs: Commands (Built-in · Skills · Plugins · MCP prompts, with route badges), MCP servers, Plugins, **Sessions**
  (C4.6).
- Composer `/` palette (C4.3). Thread status uses the mod's `busy` when `source:'mod'`.

### C4.6 Sessions view (owner request; the `config.sessions_view` switch was removed 2026-11-01: nothing read it)

What the agent can already start: subagents (Agent tool), background sessions (`claude --bg`), cloud sessions
(`claude --cloud`), cloud scheduled tasks and their API triggers (`RemoteTrigger`), headless `claude -p` runs
([commands](https://code.claude.com/docs/en/commands.md), `claude --help`, tools-reference, routines). Talos can't see
or start any of them today.

- **List** (`session.list` frame), merged from:

| Kind                                      | Source                                                                                                                                          | Status                                                  | Result                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents of the live session             | mod `$.agent.list()`                                                                                                                            | `pending…killed`                                        | the agent's reply in the thread                                                                                                                                                                                               |
| Local interactive and background sessions | `claude agents --json --all`, polled every 15 s by the live bridge                                                                              | `working\|blocked\|done\|failed\|stopped`, `waitingFor` | "Show output" runs `claude logs <id>` on request (text, ≤4000 chars, plain), **background sessions only** (`claude logs` prints "a background session's recent terminal output"); interactive rows say "Output not available" |
| Cloud sessions and scheduled-task runs    | the agent reports them with a new bridge tool `session_report {kind, title, url, status?, thread_id}` when it starts one (it gets the URL back) | whatever the agent last reported                        | link "Open on claude.ai", shown only when `url` starts with `https://claude.ai/` (the bridge drops any other host: an agent-supplied link must not become a phishing door)                                                    |
| Headless `claude -p` runs                 | the same `session_report`, or a background job calling `talos-app post`                                                                         | reported                                                | reply in the thread                                                                                                                                                                                                           |
- **Start one**: "New session" → prompt, kind (Subagent · Background · Cloud), thread. Sends signed `session.spawn`.
  The bridge never spawns processes itself: it delivers a `kind=spawn_request` notification (trust `owner`) and the
  agent starts the work its own way, then calls `session_report`. A Cloud spawn is a `low` card first (it uses plan
  limits off the Mac).
- **See the result**: every spawned row links to the thread where its result lands; finished rows stay for 7 days.
- Honest limits: cloud status is only as fresh as the agent's last report; `claude agents --json` is polled, not pushed.

---

## C5. Impossible, or waits for the desktop app

- **Startup dialogs and login.** No API presses keys at launch. A pty host can, under the owner's eyes.
- **Restart after a crash.** Bridge and mod die with the process; the relay's "Mac session stopped" push stays the
  signal (SPEC 4.1). Restart-only rule for the desktop app: it may type the dev-channel confirmation only when the
  session is a restart of one the user started and confirmed by hand, and only if the dialog's channel list is byte-for-
  byte what the user approved; never on a first launch. Anthropic's own `claude --bg` supervisor restarts sessions, but
  carrying `--dangerously-load-development-channels` across its restarts is unconfirmed (**SMOKE S14**).
- **Mid-turn steering beyond Stop.** A channel message waits for the next turn.
- **Seeing the terminal.** No API streams the TUI; the desktop app's terminal pane is the answer.

---

## C6. Optional: delegate to Codex

### C6.1 Facts (Codex CLI 0.147.0 `--help`; OpenAI docs fetched 2026-10-29)

| Fact                                                                                                                                                                                         | Source                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `codex exec`; `--json` JSONL events (`thread.started`, `turn.started`, `turn.completed` with `usage`, `turn.failed`, `item.*`, `error`); `-o` last message; `--output-schema`; `exec resume` | `codex exec --help`; [non-interactive](https://developers.openai.com/codex/noninteractive.md) |
| Default sandbox `read-only`; `-s workspace-write\|danger-full-access`; `--approve-for-me`; `--ignore-user-config` ("Do not load `$CODEX_HOME/config.toml`")                                  | same                                                                                          |
| `$imagegen` invokes image generation (`gpt-image-2`) in app, CLI, IDE; counts toward plan limits "3–5x faster"; API pricing with `OPENAI_API_KEY`                                            | [image generation](https://learn.chatgpt.com/docs/image-generation.md)                        |
| Computer use is set up in the **ChatGPT desktop app**; "can't automate terminal apps"; never mentioned for `codex exec`                                                                      | [computer use](https://learn.chatgpt.com/docs/computer-use.md)                                |
| Docs say `codex mcp-server` "has been removed"; 0.147.0 still lists it in `--help`. Not used either way                                                                                      | [MCP server removal](https://learn.chatgpt.com/docs/mcp-server.md); `codex --help`            |
| Included in ChatGPT plans                                                                                                                                                                    | [pricing](https://learn.chatgpt.com/docs/pricing.md)                                          |

### C6.2 Design (WP-C5 owns all of it)

- **Shape:** a skill `codex-delegate` at `plugins/talos-app-mod/skills/codex-delegate/SKILL.md` (skills in a plugin load
  without its hooks) plus a bridge CLI subcommand `talos-app codex run --thread <id> --dir <abs> --sandbox
  read-only|workspace-write [--image <path>…] -- "<prompt>"`, run by the agent with Bash.
- **The wrapper** spawns, as argv: `codex exec --json --ignore-user-config -C <dir> -s <mode> -o <tmp>/last.md
  "<prompt>"`. It never passes `-c`, `--enable`, `--add-dir`, `--approve-for-me` or either `--dangerously-*` flag.
  `--ignore-user-config` keeps the user's own MCP servers and plugins (which run outside Codex's sandbox) out of the run.
  - `item.started` → `set_status working` labels, at most one per 5 s.
  - At the end: one `reply` prefixed **"Codex:"** with the last message (wrapped, below) and new image files, found by
    mtime in the run directory and Codex's generated-images folder (S8 partly answered in WP-C5: this Mac keeps them at `$CODEX_HOME/generated_images/<codex thread id>/exec-*.png`; the wrapper collects that folder; a real `$imagegen` run is still unverified).
  - Prints `{ok, summary_wrapped, files[], usage, thread_id}`: the last message already inside a `wrapExternal` block,
    so the agent never reads Codex's raw text.
- **Safety mapping:** no card for any sandbox (owner decision, WP-C5: minimal friction; the sandbox and the single `--dir` are the limit). Superseded: `workspace-write` in a folder used to get a `low` card first.
  Anything leaving the Mac: never inside Codex. The wrapper's refusals are **advisory in bypass mode** (the agent could
  call `codex` directly); the docs say so.
- **Detection:** `talos-app doctor` and `talos-app codex check` run `codex --version` and `codex login status` (the mod inventory row is not built yet); without both the skill
  and the inventory row stay hidden. **Cost:** the user's own ChatGPT plan or API key; one run per thread; 20 min timeout.
- **Computer use:** not offered until **SMOKE S9** shows `codex exec` can drive it. Otherwise the product line is: "For
  Codex computer use, start the task in the ChatGPT app." Claude Code's own computer use stays the local path
  (interactive sessions only, [computer-use](https://code.claude.com/docs/en/computer-use.md)).

---

## C7. Threads: what they are and how the agent should use them

### C7.1 The model

- A thread is a **label on messages**, not a session (SPEC 1). It decides where a message shows, what pushes, and what a
  live call may seed.
- Kinds: `fixed` (owner config), `agent` (made by the agent, ≤20 live, `apps/bridge/src/tools/threads.ts:6`), `system`
  (`inbox`). Notify levels: `all` · `needs_you` · `off`.

### C7.2 Rules for the agent (append to the SPEC 4.4 instructions string; WP-C4)

> Threads are topics. Reply in the thread a message came from. For work you start yourself, pick the thread whose name
> matches the topic (`list_threads`); if a project or recurring topic has none and will produce more than one message
> this week, `create_thread` with a short noun name, then post there. Don't create a thread for a one-off answer. When a
> topic is finished, post a one-line wrap-up and `archive_thread` (agent threads only). Hook events stay in `inbox`
> unless the owner routed them.

### C7.3 UI gaps (WP-C4)

| Gap                                    | Evidence                                                      | Fix                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No explanation                         | `features/threads/ThreadList.tsx` header is just "Threads"    | One dismissible line: "Threads keep topics apart. {agent} replies where you ask and files its own updates by topic." |
| Create/rename/archive only in Settings | `AgentSettingsSection.tsx:214-234`; no add button in the list | "+ New thread" at the end of the list; long-press → Rename / Archive (`config.patch`)                                |
| Agent threads appear without context   | `ThreadList.tsx:102`                                          | Pin the agent's first message as the thread's "why"                                                                  |
| Notify level hidden behind `…`         | `ThreadScreen.tsx:34-62`                                      | Bell state on each row                                                                                               |
| "Where did that go?"                   | proactive messages land silently                              | Home "Up next" rows carry the thread name (check SPEC 8.2 ships it)                                                  |

---

## C8. Per-thread sessions (owner decision: B now, C designed for later)

### C8.1 Option B: orchestrator plus a background subagent per thread task (no code)

- The main session runs a thread's heavy task as a background subagent that inherits the bridge tools, so it replies in
  that thread and raises its own cards. One instruction line in C7.2's block: "For a multi-step task in a project
  thread, run it as a background subagent that replies in that thread."
- Limits: results return into the main context; later owner messages reach the orchestrator, which can `SendMessage` the
  running subagent; it ends with the task. The Sessions view (C4.6) shows these as `Subagent` rows.

### C8.2 Option C: a dedicated session per thread (later; `Thread.session: 'shared'|'dedicated'`)

- **Shape.** The live bridge stays the only relay socket (the hub). A dedicated thread gets a **worker**: an ordinary
  interactive session named `talos:<thread_id>`, started in the thread's folder, with no channel and no dev flag.
- **Inbound** via cross-session messaging from the main session's mod (`$.session.send({to:{sessionId}, text})`). The
  text is a pointer only (`Talos message m_… in thread <id>. Call read_inbound.`); the worker's headless `talos-app`
  gains `read_inbound {message_id}`, returning the verified frame from the Mac store with its trust label. A peer can't
  forge owner text; a held pointer only delays work.
- **Held pointers.** A receiving session holds peer messages when its permission class differs from the sender's
  ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md), "Control inbound messages").
  Start workers with `--settings '{"crossSessionInbound":"accept"}'` (documented for `-p`, **SMOKE S10** for `--bg`), or
  run hub and workers in the same mode.
- **Outbound** unchanged: headless `reply`/`attach`/`card` (SPEC 4.1).
- **Host.** `claude --bg --name talos:<id>` (supported, resumable, listed in `claude agents --json`); idle background
  sessions stop after about an hour unattached (agent-view); the hub restarts on the next message. Later: the desktop
  app's supervisor. Not the Agent SDK on a subscription login: Anthropic's terms say developers "should use API key
  authentication" and may not "offer Claude.ai login" ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md);
  [agent-sdk overview](https://code.claude.com/docs/en/agent-sdk/overview.md)).

| Rule                                 | Change                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One bridge socket; superseded = stop | Unchanged at the relay. New local rule: one worker per thread (`$TALOS_APP_HOME/workers.json`); a second start for a live thread is refused                      |
| Proactive messages                   | A worker posts only to its own thread (`TALOS_APP_WORKER_THREAD` set → headless `reply` rejects other ids); cross-topic briefs stay with the orchestrator        |
| Cards                                | Answered in the raising thread; the hub routes `card_action` to the worker by pointer                                                                            |
| Permission prompts                   | A worker without a channel can't relay. Workers run with the C3.1 ask rules and, if the mod is loaded there, its `ask` decisions become cards in its thread (P1) |
| Hook events, digests, voice          | Orchestrator                                                                                                                                                     |
- **Memory:** files only (agent folder `CLAUDE.md`, memory files, skills, `read_thread`), plus a `threads/<id>.md` brief
  the orchestrator writes at creation.
- **Orchestrator owns:** default thread, inbox, schedules and briefs, thread lifecycle, worker start/stop, voice,
  cross-topic work.
- **Cost and concurrency:** each worker has its own context and draws on the same plan limits; at most 3 live workers,
  idle stop after 30 min, per-thread switch with a cost note.

| Failure                      | Guard                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Two sessions edit one repo   | A worker starts only in a folder nobody else claims; in a git repo it runs in its own worktree (`--worktree`) or is refused (**SMOKE S11**) |
| Worker stopped or crashed    | Seen in `claude agents --json`; next message restarts it; the thread shows "Starting a session for this thread…"                            |
| Pointer held                 | Harmless (pointer only); after 2 min the orchestrator answers with a note                                                                   |
| Two sessions act on one card | Ledger resolves once; only the routed session gets the action                                                                               |
| Runaway cost                 | Caps; idle workers stopped between turns, never mid-turn                                                                                    |

### C8.3 When to use which

| Situation                                                                           | Use              |
| ----------------------------------------------------------------------------------- | ---------------- |
| Most threads, short tasks                                                           | Shared           |
| A heavy multi-step task in a topic thread                                           | B                |
| A long-lived project with its own large context, or one that must not share context | C, after S10/S11 |

---

## C9. Gap matrix

| Wish-list item                                 | Status                                      | Evidence                                                                                                                                                                                                         | Next step                                                                                                              |
| ---------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Frontier model, never hands off to a worse one | **PARTIAL**                                 | The session runs the chosen model; live voice talks on a fast voice model and hands real work to the agent (SPEC 6.3); the app can't show or set the model                                                       | C4.4                                                                                                                   |
| Spins up cloud and local code sessions         | **PARTIAL**                                 | The agent can: subagents, `claude --bg`, `claude --cloud`, `RemoteTrigger` scheduled tasks and API triggers, `claude -p` (C4.6). Talos can't see or start them                                                   | Sessions view (C4.6)                                                                                                   |
| Real-time voice with tool use                  | **PARTIAL** (built, not proven on a device) | SPEC 6; `docs/voice.md`; open smoke rows PR3 R5/R6 in `docs/FOLLOWUPS.md`                                                                                                                                        | Run `scripts/smoke/wp4.md`                                                                                             |
| Codex-level computer use on local sessions     | **PARTIAL**                                 | Claude computer use: interactive CLI only; Codex computer use: ChatGPT app only (C6.1)                                                                                                                           | C6; SMOKE S9                                                                                                           |
| Artifacts-quality decks, docs, design          | **DONE** (agent) / **PARTIAL** (app)        | Claude Code artifacts and `/design` (commands); Talos HTML page cards (SPEC 4.4), full-screen previews (commit 4492e31)                                                                                          | Link cards for artifact URLs                                                                                           |
| Mobile app as the UI                           | **DONE** (PWA) / **PLANNED** (native)       | SPEC 1, 8, 14                                                                                                                                                                                                    | Phase 2 wrapper                                                                                                        |
| Inline mini apps                               | **PARTIAL**                                 | Cards (SPEC 8.4)                                                                                                                                                                                                 | The separate MCP Apps addendum                                                                                         |
| Webhooks                                       | **DONE**                                    | SPEC 7; Settings → Webhooks (commit 57715c6)                                                                                                                                                                     | Smoke rows WP3                                                                                                         |
| Social media across platforms                  | **PARTIAL**                                 | Reading: a cross-platform research skill can pull Reddit, X, YouTube, TikTok, Instagram, HN, Polymarket and web search through third-party APIs (for example the community `last30days` skill). Posting: nothing | A draft-card flow: the agent drafts per platform as `publish` cards; it posts through an MCP connector only on PRIMARY |
| Plugins                                        | **DONE** in Claude Code / **GAP** in Talos  | C1.7                                                                                                                                                                                                             | C2, C4                                                                                                                 |
| Always-on, self-organizes into threads         | **PARTIAL**                                 | Threads and `create_thread` exist (SPEC 4.4); a crash waits for a key press (SPEC 4.1, 13 Q2)                                                                                                                    | C7; desktop app                                                                                                        |
| Control on mobile, web, desktop and voice      | **PARTIAL**                                 | Chat everywhere the PWA runs; no Stop/Compact/model today (SPEC 4.6)                                                                                                                                             | C4; desktop app PLANNED                                                                                                |
| A VM browser that doesn't get blocked          | **OUT-OF-SCOPE** for Talos                  | —                                                                                                                                                                                                                | The agent's own browser on the Mac (real profile, real IP); screenshots in-thread                                      |

Rows from earlier research this supersedes: chat forum topics (Talos threads), chat draft buttons (Talos cards), a webhook
tunnel (Talos `/hook`). Remote Control stays a free stopgap for commands from a phone.

---

## C10. Work packages and build order

**Contract rule.** Only **WP-C0.5** edits `packages/protocol` (SPEC builder rule 2). Every other WP codes against it.

| #   | WP                                                       | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P0                                          | Effort   |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| 0.5 | **WP-C0.5 Protocol PR** (architect, before fan-out)      | `packages/protocol/src/session.ts`, `models.ts` (`Card.kind:'permission'`), `frames.ts` (C2.5 frames, `ready` fields), `config.ts` (`permission_relay`, `permission_stepup`, `session_models`, `sessions_view`) + `config.patch` allowlist, `http.ts` (purposes `session:control`, `permission:allow`), enrollment binding with `credential_public_key`, `errors.ts` (`control_stale`, `command_changed`, `model_not_allowed`, `model_switch_denied`, `model_switch_pending`, `effort_change_pending`), fixtures; `## Requests`: `@simplewebauthn/server@14.0.3` for `apps/bridge` (already pinned for the relay; C3.6) | all                                         | 1 day    |
| 1   | **WP-C1 Permission cards**                               | bridge `src/permission/**`, `install-ask-rules`, web card variant, doctor warning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C3.1-C3.5, C3.8                             | 2 days   |
| 2   | **WP-C2 Talos mod**                                      | `plugins/talos-app-mod/**` except `skills/`; bridge `talos_mod_*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C2.3, capability report, guard, C3.4 closer | 2.5 days |
| 3   | **WP-C3 Session sheet, controls, model/effort, palette** | bridge `src/session/**`, web `features/session/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | C4.2-C4.5                                   | 3 days   |
| 4   | **WP-C4 Threads clarity**                                | bridge instructions string, web `features/threads/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | C7.2, C7.3 rows 1-2                         | 1 day    |
| 5   | **WP-C5 Codex delegate**                                 | bridge CLI `codex`, `plugins/talos-app-mod/skills/codex-delegate/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | C6.2                                        | 1.5 days |
| —   | WP-C6 Step-up by the bridge                              | bridge `src/permission/stepup.ts`, web step-up flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | C3.6                                        | 1.5 days |
| —   | WP-C7 Sessions view                                      | bridge `src/sessions/**`, `session_report` tool, web tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | C4.6                                        | 2 days   |
| —   | WP-C8 Hooks fallback + status tee                        | bridge CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | C2.4                                        | 1 day    |
| —   | WP-C9 Option C workers                                   | hub routing, `read_inbound`, `workers.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | C8.2, after S10/S11                         | 4-5 days |
| —   | WP-C0 Copy to repo                                       | `docs/CLAUDE-CODE.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | below                                       | 0.5 h    |

**Recommended top 5:** WP-C0.5 + WP-C1 (the owner's original requirement, no early-access API), WP-C2, WP-C3, WP-C4,
WP-C5. WP-C1 and WP-C4 can start as soon as WP-C0.5 merges; WP-C3 after WP-C2.

**Tests.**
- Fixtures copied verbatim from the channels reference: a 5-letter id without `l`, the elision marker, `(value
  unserializable)`, `[REDACTED]`, a repeated id. One real `permission_request` recorded during smoke and committed.
- FakeClaude gains `permission_request` and `permission` methods driven by those fixtures.
- The mod: `claude plugin test` (fires events, "no session, sign-in, or network",
  [test a mod](https://code.claude.com/docs/en/plugins/mods/test.md)) and `claude plugin validate`, in CI against the
  pinned and the latest CLI, plus a weekly canary job.

**WP-C0 copy step.** `scripts/claude-code-doc.ts` copies C0-C12 and the source list from the design spec, drops its
front matter and private appendix, and refuses output that mentions the appendix or matches a private-path pattern;
`check:personal` then runs with the private denylist and the design spec named in `CHECK_PRIVATE_DOCS`.

---

## C11. SMOKE list (a real Mac session)

| Id  | Check                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The mod can `$.mcp.call` the bridge from `session.start` (retry while connecting)                                                                                                     |
| S2  | The `tool.check` guard sees model and subagent calls to `talos_mod_*`, not the mod's own                                                                                              |
| S3  | `$.turn.abort` stops a long turn, and a later channel message still starts a turn                                                                                                     |
| S4  | `$.command.run` for `model <alias>` and `effort <level>`, `$.session.compact()`: idle and busy, cache warm and cold; what `$.config.list()` shows for model and effort rows           |
| S4b | A mod's `classic.PreModelSwitch` hook can return `permissionDecision:'allow'` and skip the warm-cache confirmation; a user hook's `deny` still wins and its reason reaches the result |
| S5  | How `disable-model-invocation` and `user-invocable:false` skills appear in `$.command.list()`; what a skill's `command.run` returns                                                   |
| S6  | A `tool.call` hook on `AskUserQuestion` answers with `{result}`                                                                                                                       |
| S7  | `$.command.run({command:'resume', args})`                                                                                                                                             |
| S8  | Where `codex exec` writes `$imagegen` output                                                                                                                                          |
| S9  | Whether `codex exec` can drive computer use                                                                                                                                           |
| S10 | A `claude --bg` worker with `crossSessionInbound: accept` receives pointers and restarts after idle stop                                                                              |
| S11 | Two workers in worktrees of one repo don't collide                                                                                                                                    |
| S12 | An ask-rule prompt in bypass mode reaches a channel's relay                                                                                                                           |
| S13 | Two concurrent permission prompts produce two cards; answering one at the Mac doesn't close the other                                                                                 |
| S14 | A `claude --bg` session keeps a development channel across a supervisor restart                                                                                                       |
| S15 | Polling`claude agents --json --all` every 15 s starts no MCP servers and no second channel poller                                                                                     |

---

## C12. Open questions

1. **Ask-rule defaults (C3.1):** ship the generic list as the default, or start empty and suggest? Recommendation: ship
   it, shown as a diff the user edits before saving.
2. **Sessions view default:** off (opt-in) as specified, or on when the mod is present? Recommendation: off; it polls a
   CLI every 15 s.

---

## Sources (fetched 2026-10-29)

- Claude Code docs: [channels](https://code.claude.com/docs/en/channels.md), [channels-reference](https://code.claude.com/docs/en/channels-reference.md), [commands](https://code.claude.com/docs/en/commands.md), [skills](https://code.claude.com/docs/en/skills.md), [hooks](https://code.claude.com/docs/en/hooks.md), [statusline](https://code.claude.com/docs/en/statusline.md), [permission-modes](https://code.claude.com/docs/en/permission-modes.md), [permissions](https://code.claude.com/docs/en/permissions.md), [model-config](https://code.claude.com/docs/en/model-config.md), [remote-control](https://code.claude.com/docs/en/remote-control.md), [agent-view](https://code.claude.com/docs/en/agent-view.md), [cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging.md), [tools-reference](https://code.claude.com/docs/en/tools-reference.md), [routines](https://code.claude.com/docs/en/routines.md), [mods overview](https://code.claude.com/docs/en/plugins/mods/overview.md), [mods api](https://code.claude.com/docs/en/plugins/mods/api.md), [mods events](https://code.claude.com/docs/en/plugins/mods/events.md), [mods reference](https://code.claude.com/docs/en/plugins/mods/reference.md), [create a mod](https://code.claude.com/docs/en/plugins/mods/create.md), [test a mod](https://code.claude.com/docs/en/plugins/mods/test.md), [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript.md), [agent-sdk overview](https://code.claude.com/docs/en/agent-sdk/overview.md), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md), [computer-use](https://code.claude.com/docs/en/computer-use.md).
- Local: `claude --help` and subcommand `--help` (2.1.312), including `claude plugin validate --help`; the engine-written mods type file (2.1.296).
- OpenAI: `codex --help`, `codex exec --help`, `codex mcp-server --help`, `codex plugin --help` (0.147.0); [non-interactive](https://developers.openai.com/codex/noninteractive.md), [computer use](https://learn.chatgpt.com/docs/computer-use.md), [image generation](https://learn.chatgpt.com/docs/image-generation.md), [MCP server removal](https://learn.chatgpt.com/docs/mcp-server.md), [pricing](https://learn.chatgpt.com/docs/pricing.md).
- Talos: `docs/SPEC.md`, `docs/FOLLOWUPS.md`, `packages/testkit/src/fake-claude.ts`, `apps/bridge/src/tools/threads.ts`, `apps/web/src/features/threads/*.tsx`, `apps/web/src/features/agent-config/AgentSettingsSection.tsx`.
