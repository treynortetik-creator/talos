# Subagent activity panel

> **Status.** WP-A0 (protocol, relay pass-through, testkit, this doc), WP-A1 (mod + bridge, section 5.4) and WP-A2
> (web, section 6) are built. Extends [CLAUDE-CODE.md](CLAUDE-CODE.md) C2 (session visibility) and C4.6 (Sessions view). Builder rules are
> the original build spec (not published), sections 0, unchanged.
>
> **What it is.** A small panel to the right of the thread, beyond the context and usage meters, that shows what the
> session's subagents are doing: type, a one-line "now" text, elapsed time, tokens, and running / idle / done, plus
> counts of background shells and monitors. The reference UX is the Claude Code CLI's agent panel.
>
> **Labels.** **OBSERVED** = read or run against Claude Code 2.1.312. **DOC** = a code.claude.com page (Sources).
> **INFERENCE** = reasoned, not seen. **SMOKE** = a live session must confirm it before a builder relies on it
> (section 8).

---

## 1. Answer in one screen

- **Source: the Talos mod, plus one small tee.** The mod already syncs to the bridge every 2 s (C2.3). It adds an
  agents collector: `$.agent.list()` for the roster and status, its own `tool.call` / `turn.step` hooks (which carry
  `agentId` inside subagents) for the activity log and token counts, and shell / monitor tracking. The CLI's one-line
  progress summary ("Running memory and search vitest suites") comes from one place only: the `subagentStatusLine`
  command's `label` field. So a `talos-app subagent-tee` command, shipped as that setting, writes the CLI's own row data
  (label, tokenCount, startTime, model) to a state file. It prints nothing, so the CLI's rows look the same as before.
- **Fallback.** Without the tee, the row shows the subagent's latest tool call ("Run vitest suites") instead of the
  summary. Without the mod, there is no panel; the app shows one line saying how to get it. Hooks-only setups get
  nothing new.
- **Ruled out:** transcript parsing (C2.1 "never"; the format is internal and lags), `claude agents --json` (it lists
  sessions, not subagents; OBSERVED keys `cwd,id,kind,name,sessionId,startedAt,state`), the Agent SDK `task_*` stream
  (the richest source, but Talos is not an SDK host, and C8 already rejects SDK hosting on a subscription login), and
  settings hooks alone (`SubagentStart` / `SubagentStop` fire only at the edges, with no activity or tokens).
- **Stop: yes, behind a capability.** The mod calls the `TaskStop` tool through `$.tool.call`. It is a signed control
  like Stop today. No new approval gate. SMOKE S-A6.
- **No blocker.** The risk is the tee: it is terminal-UI-only code (INFERENCE from the 2.1.312 bundle), ticks every
  5 s, and whether a `--plugin-dir` plugin can ship it as a default is SMOKE S-A4. If it can't, an installer adds it
  (same pattern as `install-hooks`).

---

## 2. Research: what the vendor's own UIs use

The engine's task registry, read from inside the engine. The CLI panel, the Desktop "Background tasks" pane and the SDK
`task_*` messages all read one in-process task list. From a plugin, the closest equivalents are `$.agent.list()` plus
event hooks, which are live and run in the engine's own process. Polling files or scraping transcripts is what you do
when you can't get inside; a mod can.

### 2.1 Every source, ranked

| #   | Source                                                                                           | Live activity text                                  | Tokens                                                         | Elapsed                     | Shells / monitors                                                                                                                                                     | Status                                                       |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | **Mod `$.agent.list()`**                                                                         | no (`description` only)                             | no                                                             | no (first-seen time only)   | **no** (subagents and teammates only)                                                                                                                                 | `pending\|running\|waiting\|idle\|completed\|failed\|killed` |
| 2   | **Mod hooks with `e.agentId`** (`tool.call`, `turn.step`, `turn.complete`, `agent.spawn`)        | **yes**: each tool call (name + input) as it starts | **yes**: `turn.step` result `usage`; `turn.complete` `usage`   | **yes**: `agent.spawn` time | **partly**: `tool.call` on `Bash` with `run_in_background` and on `Monitor`; ends via `session.append` notification rows (`UserMessageTask {id, status, durationMs}`) | from the list                                                |
| 3   | **`subagentStatusLine` command**                                                                 | **yes**: `label`, the CLI's own line                | **yes**: `tokenCount`, `tokenSamples[16]`, `contextWindowSize` | **yes**: `startTime` (ms)   | **no** (`type: local_agent` only)                                                                                                                                     | `running\|completed\|failed\|killed`                         |
| 4   | Settings hooks `classic.Stop` / `SubagentStop`                                                   | no                                                  | no                                                             | no                          | **yes, as a snapshot**: `background_tasks: BackgroundTaskSummary[] {id, type: shell\|subagent\|monitor\|workflow, status, description, command?, …}`                  | yes                                                          |
| 5   | Settings hooks `SubagentStart`, `TaskCreated` / `TaskCompleted`                                  | no                                                  | no                                                             | edges only                  | no                                                                                                                                                                    | edges                                                        |
| 6   | On-disk files (`subagents/agent-<id>.jsonl` + `.meta.json`, `tasks/<id>.output`)                 | n/a                                                 | n/a                                                            | n/a                         | n/a                                                                                                                                                                   | `meta.json.finished`; **not used** (C2.1 "never")            |
| 7   | `claude agents --json`                                                                           | no                                                  | no                                                             | `startedAt`                 | no                                                                                                                                                                    | session `state`; a list of sessions, already used by C4.6    |
| 8   | Agent SDK `task_started/progress/updated/notification`, `background_tasks_changed`, `stopTask()` | yes                                                 | `usage.total_tokens`                                           | `usage.duration_ms`         | yes                                                                                                                                                                   | full; **not reachable**: Talos is not an SDK host            |
| 9   | Main `statusLine` JSON                                                                           | no                                                  | main loop only ("doesn't count subagent requests")             | no                          | no                                                                                                                                                                    | no                                                           |

Evidence: rows 1, 2 and 4 OBSERVED in the mod types Claude Code 2.1.296 writes on load (`AgentInfo {id, teammateId?,
description, type, status, parentId?, spawnedBy?, name?}`, `TurnStepInput.agentId`, `TurnStepResult.usage`,
`UserMessageTask`, `BackgroundTaskSummary`) and in the 2.1.312 binary (same three methods `$.agent.list/spawn/register`;
the `subagentStatusLine` setting, `tokenSamples`, `contextWindowSize`; the status line ticks after 300 ms, then every
5 s, only while visible tasks exist, INFERENCE from minified code). Rows 3, 5, 8, 9 DOC.

**IDs line up (OBSERVED):** the same id names the subagent's transcript file and its task output file; the types say
`$.agent.list()` `id` = `tool.call` / `turn.step` `agentId` = classic `agent_id`. That the tee's `tasks[].id` is the
same string is SMOKE S-A7.

### 2.2 How the vendor renders it (match this)

- **CLI** (DOC sub-agents): a subagent panel below the prompt input; nested agents as a tree with `(+N)`; successful rows
  leave at once (footer hint `/tasks to see subagents` for 30 s); failed or stopped rows stay 30 s; `x` stops; `/tasks`
  lists them with model and effort. Default row = `name · description · token count`; the activity line is the
  progress `label`.
- **Desktop** (DOC desktop): a "Background tasks" side pane listing subagents, background shells and workflows; click
  for output or stop.
- **Fork mode is on by default since 2026-08** (DOC whats-new 2026-w33), so subagents Claude spawns run in the
  background by default. INFERENCE: most rows will be background ones, so the panel earns its space.

Talos copies the Desktop pane's shape (right side, one list, shells included) and the CLI's row text.

---

## 3. Data source per field

| Field                                           | Primary                                                                                                                                                                                               | Fallback                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Roster, type, description, name, parent, status | mod `$.agent.list()` every sync (2 s)                                                                                                                                                                 | tee `tasks[]`                                                     |
| Activity line                                   | tee `label` when it differs from `description`                                                                                                                                                        | mod: latest `tool.call` of that `agentId`, rendered per 4.3       |
| Recent activity (tap)                           | mod: last 8 `tool.call` lines per agent, ring buffer                                                                                                                                                  | none                                                              |
| Tokens                                          | tee `tokenCount` (the CLI's figure)                                                                                                                                                                   | mod: last `turn.step` `usage` input + cache + output (SMOKE S-A3) |
| Elapsed                                         | tee `startTime`                                                                                                                                                                                       | mod: `agent.spawn` time, else first seen                          |
| Model                                           | tee `model`                                                                                                                                                                                           | `agent.spawn` result `model`                                      |
| Shells, monitors                                | mod: `tool.call` on `Bash` + `run_in_background:true` and `Monitor` (id from the result), ended by a `session.append` task notification; corrected by each `classic.Stop` `background_tasks` snapshot | none                                                              |
| Stop                                            | mod `$.tool.call({ tool: 'TaskStop', input: { task_id } })`                                                                                                                                           | none (button hidden)                                              |

Why the mod, not hooks or files: it's already loaded, capability-checked and syncing (C2.3); it's push from inside the
engine; and it adds no polling and no new process. The tee exists for one field (`label`) that nothing else exposes.

---

## 4. Protocol (WP-A0, built)

Code: `packages/protocol/src/session-agents.ts` (models and helpers), `session.ts` (capabilities, control, sync),
`frames.ts` (the frame and `ready`), `errors.ts`. Fixture: `packages/protocol/fixtures/frames/session.agents.json`.

### 4.1 Models

```ts
export const AGENT_LIMITS = { rows: 50, recent: 8, text: 160, frameBytes: 64_000, keepEndedMs: 600_000 } as const
export const AGENTS_EMIT_INTERVAL_MS = 2_000 // bridge: at most one session.agents per 2 s, trailing edge
export const AGENTS_HEARTBEAT_MS = 10_000 // bridge: re-send an unchanged snapshot this often while the mod syncs
export const AGENTS_FEATURE = 'agents/1' // relay `ready.features`: it passes session.agents on
export const AGENTS_TEE_FRESH_MS = 12_000 // mod: read the tee file only when younger than this
export const AGENTS_TRACKER_MAX_IDS = 100 // mod: tracker bound
export const AgentKind = z.enum(['subagent', 'teammate', 'shell', 'monitor', 'workflow', 'remote'])
export const AgentRunStatus = z.enum([
  'pending',
  'running',
  'waiting',
  'idle',
  'completed',
  'failed',
  'killed',
  'unknown',
])
const Line = z.string().max(160) // + refuses control characters, line separators, bidi overrides
const AgentId = z.string().min(1).max(80) // + the same one-line rule: ids are TaskStop targets and UI keys

export const AgentRow = z.strictObject({
  id: AgentId,
  kind: AgentKind,
  type: z.string().max(64), // agent type ('Explore', 'general-purpose'), 'shell', 'monitor'
  name: z.string().max(64).optional(), // SendMessage name
  title: Line, // the Agent call's description, or the shell's description
  status: AgentRunStatus,
  activity: Line.optional(), // the one-line "now" text
  activity_source: z.enum(['summary', 'tool']).optional(),
  parent_id: AgentId.optional(),
  model: z.string().max(80).optional(),
  tokens: z.number().int().nonnegative().optional(),
  started_at: IsoTs.optional(),
  ended_at: IsoTs.optional(),
  background: z.boolean().default(false),
  stoppable: z.boolean().default(false), // capability present AND status is live
  recent: z
    .array(z.strictObject({ at: IsoTs, text: Line }))
    .max(8)
    .default([]),
})
export const AgentsSnapshot = z.strictObject({
  session_id: z.string().min(1).max(64),
  source: z.enum(['mod', 'mod+tee']),
  can_stop: z.boolean().default(false), // the mod can run agent_stop (see "Old peers" below)
  rows: z.array(AgentRow).max(50),
  at: IsoTs,
})
export const CappedAgentsSnapshot = AgentsSnapshot.refine((s) => agentsSnapshotBytes(s) <= 64_000)
```

- **Live** statuses are `pending`, `running`, `waiting`, `idle`; **ended** are `completed`, `failed`, `killed`;
  `unknown` is neither (the mod lapsed, or the engine said something new).
- `oneLine(v, max = 160)`: control characters become spaces, whitespace collapses, the ends are trimmed, and anything
  longer is clipped to `max` characters ending in `…` (never inside a surrogate pair). Every string the mod sends goes
  through it; the outbound schema refuses what it would have removed.
- `agentRowsFromEngine(raw, { canStop })` / `agentsSnapshotFromEngine(raw, { session_id, source, canStop, at })` parse
  the mod's merged data leniently (the pattern of `sessionStateFromEngine`): `$.agent.list()` fields, tracker fields and
  tee fields, camelCase or snake_case; a field of the wrong type is dropped; an unknown status is `unknown`; `kind` is
  inferred (`teammateId` → teammate, type `shell`/`local_bash` → shell, `monitor`, `workflow`, `remote_agent` →
  remote, else subagent). **`stoppable` is computed (`canStop` and a live status), never read from the input.** Rows
  without a usable id, and repeated ids, are dropped and counted. Over 50 rows, live rows are kept first. `recent` keeps
  the newest 8 lines. The mod ships an import-free copy, like its other protocol copies.
- `agentActivityForTool(toolName, input)` builds the activity line (4.3). Inputs only; tool results never go in.
- Shared helpers: `sameAgentsSnapshot` (ignores `at`), `emptyAgentsSnapshot`, `markAgentsUnknown` (live rows →
  `unknown`, `stoppable:false`; ended rows untouched), `agentCounts` (the chip: running + waiting + idle, `busy` while
  one runs, live shells and monitors), `agentsForSession(snap, state)` (no snapshot when the state names another
  session: the relay may still hold a previous session's), `canStopAgent(snap, rowId, state)` (`snap.can_stop`, the row
  stoppable and live, the state a live mod's, i.e. source `mod` with capabilities, of the same `session_id`).
- `SESSION_CAPABILITIES` gains `'agents'` (from `agent.list`) and `'agent_stop'` (probe
  `$.tool.call({tool:'TaskStop', input:{task_id:'__talos_probe__'}})`, which must reject with a normal error; SMOKE
  S-A6). The mod's `METHOD_CAPS` row for `agent.list` becomes `['sessions', 'agents']` in WP-A1; the mod reports only
  what it implements, so today's mod reports neither. **These two travel mod → bridge only** (see "Old peers").
- **Old peers.** Every app and relay since C2 parses `session.state.capabilities` as a strict enum of nine, so one
  unknown capability refuses the whole state, and the whole `ready` carrying it: an old cached app would never go
  online. So: (1) the bridge publishes `session.state` through `wireSessionState()`, which keeps only
  `SESSION_CAPABILITIES_V1` (main's nine); the panel's facts travel in `session.agents` instead (a snapshot at all =
  the mod has `agents`; `can_stop` = it has `agent_stop`), a frame type old peers drop and a `ready` field their
  non-strict `ready` strips. (2) From this build on, `capabilities` is read leniently (unknown strings dropped,
  duplicates collapsed), so the next capability cannot do this again. A test checks the published shape against a
  frozen copy of main's parser.
- `ModSyncRequest` gains `agents: AgentsSnapshot.optional()`, sent only when it changed since the last sync. It may be
  over the frame cap: the bridge trims.
- `session.control` and `ModControl` gain `action: 'agent_stop'` with `agent_id` (1-80 characters), required for it
  and refused on every other action; `agent_stop` takes no `args`. Same `osig`, stale guard and consume-once rule as
  `stop`. No step-up and no card.
- `checkSessionControl` for `agent_stop`: after the usual stale / mod / stopped-at-Mac / capability checks (the
  bridge's own, unstripped copy of the mod's state), the row must be in the bridge's last agents snapshot **for the
  current session** with `can_stop`, live, and stoppable; otherwise
  `agent_not_found` ("That agent already ended. Nothing was stopped."). New context field `agents`; without a
  snapshot the answer is `agent_not_found`. Like every check there, it only refuses: mod data never allows anything
  the policy would not.
- New error code `agent_not_found`.

### 4.2 Frames (adds to CLAUDE-CODE.md C2.5)

| type             | direction        | durable                                                                               | fields                                            |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `session.agents` | bridge→relay→app | **no**; the relay keeps the last one in memory and sends it in `ready.session_agents` | `agents` (`CappedAgentsSnapshot`, ≤ 64,000 bytes) |
- On `SESSION_BRIDGE_FRAME_TYPES` beside `session.state`; not owner, not durable, not consumable. An app may not send
  one. The fixture has one running Explore with the tee summary, one idle teammate, one background shell and one
  completed row; `ready.json` carries the same snapshot.
- **Size cap.** The schema caps allow about 80 KB of plain text (50 × 8 × 160 in `recent` alone) and more with
  multi-byte text, so trimming is a real path. `session.agents` and `ready.session_agents` refuse anything over
  `frameBytes` (measured as the UTF-8 bytes of the snapshot's JSON); the relay answers such a frame `bad_frame`.
  Before sending, the bridge runs `trimAgentsSnapshot(snap)`, which, while the snapshot is over, one row at a time and
  oldest first: (1) empties `recent` on ended rows (oldest `ended_at`), (2) empties `recent` on the other rows (oldest
  `started_at`), (3) drops ended rows, and (4) as a last resort (only reachable with long multi-byte text everywhere)
  drops the oldest remaining rows. The result always fits; the input is never changed.

### 4.3 Privacy (the owner's own app; kept lean)

- Showing paths, prompts and commands to the owner is fine. **Persist nothing:** the relay keeps the last snapshot in
  memory exactly like the last `session.state` (`apps/relay/src/session/index.ts`); never in SQLite, never in a push
  payload, never in logs (log row counts only). A relay restart forgets it until the next bridge send. The bridge keeps
  it in memory. The tee file is overwritten each tick and deleted on `session.end`.
- Activity text per tool (`agentActivityForTool`), one line: `Bash` → its `description`, else the first 80 characters
  of `command`; `Read` / `Edit` / `Write` → `<verb> <basename>`; `Grep` / `Glob` → `Search "<pattern>"`; `WebFetch` →
  the host; `Agent` → `Spawn <type>: <description>`; MCP → `<server> · <tool>`; anything else → the tool name. Tool
  results never go in.

---

## 5. Bridge and mod (WP-A1)

### 5.1 Mod: `plugins/talos-app-mod/hooks/lib/agents.ts` (new) + hooks in `register.ts`

- `AgentTracker` holds per-id `{firstSeen, spawnModel, lastStepUsage, ring[8]}` plus a shells map. Bounded:
  `AGENTS_TRACKER_MAX_IDS` ids, ended ids dropped after `keepEndedMs`.
- Hooks, all observe-only and wrapped so they can never change a verdict or a result (the pattern of the C3.4 closer):
  - `agent.spawn`: `const r = await next(e)`; record `r.agentId`, `r.model`, now.
  - `tool.call`: if `e.agentId` is set, push an activity line for it. For `Bash` with `run_in_background` and for
    `Monitor`, also await the result and record the task id it returns (main loop or subagent; SMOKE S-A5).
  - `turn.step` (async generator, pass-through `yield* next(e)`): read the final `usage` when `e.agentId` is set. It must
    not buffer or delay chunks; the test asserts the chunk order is unchanged.
  - `session.append`: a task-notification row (`UserMessage` with `task`) ends that shell or monitor (`status`,
    `durationMs`).
  - `classic.Stop`: replace the shells map with `background_tasks` where `type` is `shell` or `monitor` (the
    self-correcting snapshot).
- In the existing `$.clock.every(2000)` sync: `await $.agent.list()`, read the tee file with `$.fs.read` if fresh
  (`AGENTS_TEE_FRESH_MS`), merge by id, build the snapshot (the import-free copy of `agentsSnapshotFromEngine`), and
  send it only when it changed. After a new `talos_mod_hello`, send it again in full.
- Control `agent_stop`: `$.tool.call({ tool: 'TaskStop', input: { task_id } })` → `ModControlResult` with the tool's
  text; a rejection is `agent_not_found`. It runs from the sync tick, never inside a hook the turn waits on (C2.3).
- `METHOD_CAPS`: `agent.list` → `['sessions', 'agents']`, the `TaskStop` probe → `agent_stop`; both join `IMPLEMENTED`.

### 5.2 Tee: `talos-app subagent-tee`

- Reads the stdin JSON (base hook fields + `columns` + `tasks[]`), keeps `{id, name, agentType, status, label,
  description, startTime, model, tokenCount}` per task, writes `$TALOS_APP_HOME/state/agents-tee/<session_id>.json` atomically, and
  **prints nothing**, so the CLI keeps its default rows (DOC: "Omit a task's `id` to keep the default rendering"). It
  exits 0 in under 100 ms.
- If the owner already has a `subagentStatusLine`, the installer wraps it (`subagent-tee -- <original>`), like
  `statusline-tee`, and passes stdout through.
- **Shipping:** first try a plugin default in `plugins/talos-app-mod/settings.json` (DOC: plugins can ship a default
  `subagentStatusLine`); SMOKE S-A4. If that doesn't apply under `--plugin-dir`, use
  `talos-app install-subagent-tee --agent-dir <dir> [--dry-run]`, which shows a diff, asks y/N and writes
  `.claude/settings.json`. Opt-in in Settings → Session, showing the exact change.
- The tee runs only while subagents are on screen and only in the terminal UI (INFERENCE). So `label` is best-effort,
  and the mod rows never wait on it.

### 5.3 Bridge (`apps/bridge/src/mod/link.ts` + `apps/bridge/src/session/`)

- `talos_mod_sync` accepts `agents`. **Add `'agents'` to the link's MAC body keys (`BODY_KEYS`) in the same change
  that makes the mod send it**: a mod that MACs a member the bridge leaves out fails every sync as `unauthorized`.
- The link validates `agents` with `AgentsSnapshot` (drop on failure, log the reason, keep the last good one), holds it
  in memory, and emits `session.agents` on change (`sameAgentsSnapshot`), at most once per `AGENTS_EMIT_INTERVAL_MS`
  with a trailing send so the latest change always goes out, after `trimAgentsSnapshot`. Like `session.state`
  (`STATE_HEARTBEAT_MS`), a sync re-sends the held snapshot with a fresh `at` once `AGENTS_HEARTBEAT_MS` has passed
  without a send, so a relay that restarted gets it back without waiting for a change.
- It sends `session.agents` only to a relay whose `ready.features` lists `AGENTS_FEATURE` (an older relay answers the
  unknown type with `bad_frame`). `session.state` already goes out through `wireSessionState()` (frames-out).
- Mod lapses (no sync for `MOD_LIVE_WINDOW_MS`): emit one final snapshot through `markAgentsUnknown` (only if a row
  was live); the app greys the panel with "Mod offline". A mod that comes back gets its rows back on its next sync.
  `session.end`: emit `emptyAgentsSnapshot`. A new `session_id`: nothing of the old session goes out after it.
- Pass the bridge's last snapshot to `checkSessionControl` as `agents`, `f.agent_id` in the check input, and
  `agent_id` in the `ModControl` handed to the mod.
- The bridge never reads the tee file itself (the mod merges it), so there's one writer of truth.
- Reference behaviour and contract: `FakeAgentsLink` and `defineAgentsBridgeContract` in `@talos-app/testkit`. WP-A1
  adds `apps/bridge/test-contract/agents.contract.vitest.ts` with a driver over the real `ModLink` + frames-out and its
  history store for `durableText`.

### 5.4 As built (WP-A1)

- **Mod:** `hooks/lib/agents.ts` (`AgentTracker`, `AgentsCollector`, import-free copies of `oneLine` and the activity
  text; `apps/bridge/test/mod-agents-client.test.ts` parses its output with the strict `AgentsSnapshot` and compares the
  copies with the protocol's). Hooks in `register.ts`: `agent.spawn`, the one unmatched `tool.call` hook (the engine
  allows one; it also runs the C3.4 closer), `turn.step`, `session.append`, `classic.Stop`, `session.end`. Tests:
  `tests/agents.test.ts` (`claude plugin test`).
- **Old bridges:** `talos_mod_hello` now answers `{ ok: true, features: ['agents'] }`. The mod uses that list for two
  things. It sends the `agents` member only when the list has it: a bridge from before A1 leaves `agents` out of its
  MAC, so every sync would fail as `unauthorized`. And it puts `agents` / `agent_stop` in `state.capabilities` only
  then: a bridge from before A0 reads that list as a strict enum and would drop every state.
- **`TaskStop` call shape:** `$.tool.call({ tool: 'TaskStop', task_id })`. The tool's arguments sit beside `tool` (the
  engine's `ToolCallEnvelope`), not in an `input` member. The probe never calls it: a real call at session start
  could wait on a prompt and hold up the whole link. `agent_stop` is reported when `$.tool.list()` names `TaskStop`,
  with a 1.5 s deadline. Whether deferred tools appear in that list is SMOKE S-A6; if not, Stop stays hidden.
- **`session.end`:** the mod resets its tracker, blanks the tee file (`$.fs` has no delete), and from then on sends an
  empty snapshot for that session id. The bridge needs no event of its own for this: the empty snapshot goes out
  through the normal throttle. A mod that dies first lapses, and its live rows go `unknown`.
- **Task notifications** (`session.append`): `message.task` when the row has one, else `origin.kind ===
  'task-notification'` with `<task-id>` / `<status>` read from the text (SMOKE S-A5).
- **Bridge:** `apps/bridge/src/mod/agents.ts` (`ModAgents`: validate, hold in memory, throttle, 10 s beat, lapse,
  trim). When an `agents` member doesn't parse, nothing goes out, but the held snapshot stops backing a Stop
  (`can_stop: false` to the policy) until the next good one. The mod re-sends an unchanged snapshot every 30 s, so that
  wait is bounded. The mod also bounds every time it sends to 4-digit years and builds each row on its own, so one odd
  row is left out instead of sinking the snapshot. `ModLink` feeds it and adds `agents` to `BODY_KEYS`. `bridge.ts` sends `session.agents` only after a `ready`
  listing `agents/1`, and re-sends the held snapshot on each such `ready`. `SessionControls` passes `liveAgents()` and
  `agent_id`. Contract: `apps/bridge/test-contract/agents.contract.vitest.ts`. Real-bridge tests:
  `apps/bridge/test/agents.test.ts`.
- **Tee:** `apps/bridge/src/subagent-tee.ts` imports only `node:` builtins, so it starts fast (under 100 ms, tested).
  It runs as `bun <abs>/subagent-tee.ts` or as `talos-app subagent-tee`. `src/cli.ts` is now a thin entry that
  dispatches the tee before loading the rest of the CLI (`cli-main.ts`). There is one file per session,
  `$TALOS_APP_HOME/state/agents-tee/<session_id>.json`, holding its `session_id`, so two live sessions never overwrite
  each other's labels. `talos-app install-subagent-tee --agent-dir
  <dir> [--scope project|user] [--dry-run]` shows the change, asks y/N, and wraps an existing command as `... --
  /bin/sh -c '<original>'`. **There is no plugin `settings.json` default yet.** Loading the mod would turn the tee on
  for everyone, and the owner asked for opt-in. Whether a plugin default runs under `--plugin-dir` and loses to the
  owner's own setting is SMOKE S-A4. Add the default only after that passes.

---

## 6. Web UI (WP-A2, `apps/web/src/features/agents/`)

### 6.1 Placement

| Width          | Where                                                                                                                               | Opens                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| ≥1024 px       | The **Session panel**, docked on the right of the thread (360 px, not a modal); its **Agents** section sits under Context and Usage | The usage chip in the screen's top-right corner, or the panel's cross; the choice is kept per device |
| 768 to 1023 px | The same chip                                                                                                                       | A bottom sheet with the same panel                                                                   |
| <768 px        | The context ring in the phone header                                                                                                | A drawer from the right with the same panel                                                          |

The agents rail and the "3 agents" header chip are gone: there is one Session panel, and Agents is a section of it.

- In the panel, Agents comes right after Context and Usage. It has two groups: "This session" (the helpers, then the
  shells and monitors behind a count) and "Thread sessions" (each thread's own session with the state the Mac last
  reported). Nothing in the app feeds a group of remote builders, so there is none. The Commands, MCP servers and
  Plugins lists are in Settings → Session; the panel links there.
- The panel draws `agentsForSession(snapshot, state)`, never a leftover of another session. The rows come from the snapshot the mod
  sends (the mod has `agents`; `session.state` never lists it).

### 6.2 Rows

```
● Explore · research mods API                12.3k · 2m 14s
  Running memory and search vitest suites
```

- Line 1: status dot (`running` pulsing accent, `waiting` / `idle` hollow, `completed` check, `failed` warn, `killed`
  muted, `unknown` grey), `type · title` (or `name` when set), right-aligned `tokens · elapsed` in tabular figures.
  Elapsed ticks on the client from `started_at` (one shared 1 s timer, paused when the tab is hidden) and freezes at
  `ended_at`.
- Line 2: `activity`, one line, truncated; italic when `activity_source: 'tool'`.
- Children are indented under `parent_id`, one level deep visually; deeper rows show `(+N)` like the CLI.
- Groups: **Agents** (subagents, teammates, workflows, remote), then **Shells & monitors** (collapsed by default with a
  count, for example "2 shells · 1 monitor").
- Ended rows: completed rows dim at once and leave after 10 min; failed and killed rows stay 10 min. The CLI's 30 s is
  too short for a phone you glance at.
- **Tap → detail** (inline expand on the rail; push view in the sheet): model, started time, the `recent` lines with
  relative times, and **Stop** when `canStopAgent(snapshot, row.id, state)`. While `presence` says the Mac is offline,
  grey the panel too (the relay keeps handing out the last rows). Stop sends a signed `session.control {action:
  'agent_stop', agent_id}`; the pending state and the result text reuse the `useSessionController` outcomes. No confirm
  dialog (it's one subagent, and the owner can tell it to restart).
- Empty: "No agents running." Mod missing: "Needs the Talos mod (Settings → Session)." Mod offline: rows greyed, header
  "Mod offline".

### 6.2a As built (WP-A2)

- Code: `apps/web/src/features/agents/` (`logic.ts`, `AgentsList.tsx`, `useNowTick.ts`); the
  store half is in `features/session/store.ts` (`agents`, `visibleAgents`, `showsAgentStop`, `stopAgent`). The panel is
  `features/session/SessionPanel.tsx`; `Shell.tsx` docks it (`SessionDock.tsx`) on `/t/:thread`, so the timeline keeps its
  760 px column.
- The Agents section is always shown. With nothing running, or no snapshot at all (an old relay or bridge without
  `agents/1`, a mod without `agents`, no mod), "This session" reads "No agents running." The app cannot tell those cases
  apart, so it says no more and never blames the mod (the panel's hint covers that). The owner's open / closed choice for
  the docked panel is kept per device (`localStorage` `talos-session-dock`).
- Counts (review F1): `chipLabel()` names the kind like the CLI's pill (2.1.312): the kind when every live task is one
  kind ("3 agents", "2 shells"), "tasks" when mixed. A shell or monitor is never called an agent. The "N active" beside
  the Agents heading (a polite live region) counts the Agents group only; shells and monitors have their own count.
- Stop outcomes live in the store by agent id (`agentOutcomes`), not in the detail: collapsing or going back never
  loses a failed Stop, and each row's live region is the only one that announces it (the session panel's outcome line
  ignores agent stops). Calm results fade after 10 s; errors stay until the next Stop of that row.
- Timers: a non-live row freezes at `ended_at`, or at the snapshot's `at` when the engine gave none. The 1 s clock runs
  only while a live row with `started_at` is on screen (else a 30 s clock keeps "3m ago" and the expiry honest).
- Focus: in push mode opening a row focuses its detail heading and "All agents" returns focus to the row; closing the
  chip's sheet returns focus to the chip. The running mark's pulse trough is opacity 0.75 (>= 3:1 in both schemes).
- Below 640 px the chip rides the status line under the thread name (`IDLE · 6 agents`, 44 px hit area) instead of the
  header, because one more header button truncates the thread name on a 390 px phone. 640 to 1279 px it sits next to
  the session mascot as specified.
- Stop on the phone is checked with `canStopAgent` plus a fresh mod (`modOnline`) and an online Mac, not
  `checkSessionControl`: the published `session.state` never lists `agent_stop` (section 4.1, "Old peers"). The bridge
  still runs `checkSessionControl` with its own copy.
- Detail adds the full task title (rows truncate at 320 px). Completed rows dim with secondary ink, and the offline panel
  greys with `grayscale` and secondary ink, never opacity, so every line keeps AA contrast.
- Fake mode: `?fake_agents=demo|empty` (default: a mod without `agents`); `window.__talos.session.setAgents(rows)`.
  Screenshots: `docs/screenshots/subagents/`.

### 6.3 Store

- Extend the session store (`features/session/store.ts`) with `agents?: AgentsSnapshotT`, filled from
  `ready.session_agents` and `session.agents` frames, replaced wholesale on each. No new controller.
- Accessibility: the list is `role="list"`; the status is text too (`aria-label="running"`), not colour only; 44 px tap
  targets; `aria-live="polite"` only on the count, never on ticking timers.
- Reference behaviour and contract: `FakeAgentsView` and `defineAgentsViewContract` in `@talos-app/testkit`; WP-A2 runs
  it with a driver over the real store. Fixture data: `@talos-app/protocol/fixtures/frames/session.agents.json`, or
  `agentsSnapshotSample()` / `oversizeAgentsSnapshot()` from the testkit.

---

## 7. Tests

| Layer    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Protocol | Fixture round-trips; rejects over-long strings, control characters, >50 rows, >8 recent, unknown kind or status; the cap refuses an untrimmed snapshot; trim order 1 to 4; `agent_stop` needs `agent_id` (frame, `ModControl`, `checkSessionControl`); `oneLine`; `agentRowsFromEngine` tolerates missing fields; activity text per tool **(A0, built)**                                                                                                         | `packages/protocol/test/session-agents.test.ts`                           |
| Relay    | `ready.session_agents` carries the last snapshot; a `session.state` of another session retires it; only the envelope and snapshot are forwarded (the cap covers the frame); fanned out without a seq; not persisted across a relay restart (no file holds it); no push; oversize refused; `agents/1` in `ready.features` **(A0, built)**                                                                                                                         | `apps/relay/test/session.test.ts`, `apps/relay/test/core/session.test.ts` |
| Testkit  | Both contracts against the reference fakes; FakeMod task registry, `agents` on change only, `agent_stop` **(A0, built)**                                                                                                                                                                                                                                                                                                                                         | `packages/testkit/test/session-agents.test.ts`                            |
| Mod      | `agent.list` → rows; `tool.call` with `agentId` → activity text; a main-loop call adds nothing; `turn.step` pass-through keeps chunk order and reads usage; background Bash and Monitor tracked, ended by `session.append`, corrected by `classic.Stop`; tracker caps at 100 ids; a stale tee file is ignored and a fresh one wins on `activity` / `tokens` / `started_at`; a hook that throws never changes a result; `agent_stop` calls `TaskStop` with the id | `claude plugin test`, fake `$` (A1)                                       |
| Tee CLI  | Writes atomically; prints nothing; exits 0 on bad JSON; the wrapped mode passes the original's stdout through; under 100 ms                                                                                                                                                                                                                                                                                                                                      | A1                                                                        |
| Bridge   | `defineAgentsBridgeContract` over the real link: validated or dropped; throttled to 2 s, on change only, trailing; trim order; mod lapse → `unknown`; comeback; `session.end` → empty; new session; nothing durable                                                                                                                                                                                                                                              | `apps/bridge/test-contract/` (A1)                                         |
| Web      | `defineAgentsViewContract` over the real store; rows render each status; elapsed ticks and freezes; tap expands recent lines; Stop shown only with capability + live row, and sends a signed control; layouts at 390, 1024, 1440 px (screenshots); rail collapse persists; no horizontal scroll at 390 px                                                                                                                                                        | vitest + Playwright (A2)                                                  |

---

## 8. SMOKE (a live session, before the builders rely on it)

| ID   | Check                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-A1 | `$.agent.list()` on 2.1.312 lists foreground and background subagents; statuses move `pending→running→completed`; how long ended rows stay before the engine drops them                                                                                                         |
| S-A2 | `tool.call` fires with `e.agentId` for a subagent's calls (DOC says so for `tool.check`; the types say so for `tool.call`)                                                                                                                                                      |
| S-A3 | `turn.step` results inside a subagent carry `usage`; compare our token sum with the CLI row's figure                                                                                                                                                                            |
| S-A4 | A `subagentStatusLine` default in the mod's `settings.json` runs under `--plugin-dir`; `label` equals the CLI activity line; ticks about every 5 s; still runs while channels are attached; an owner's own `subagentStatusLine` wins over the plugin default (never clobber it) |
| S-A5 | A background Bash's `tool.call` result exposes its task id; a `Monitor` does too; `session.append` sees the task-notification row; the `classic.Stop` `background_tasks` snapshot matches                                                                                       |
| S-A6 | `$.tool.call({tool:'TaskStop', input:{task_id}})` from the mod stops a background subagent and a shell, with no prompt in bypass mode; the bogus-id probe rejects with a normal error                                                                                           |
| S-A7 | Tee `tasks[].id` equals the `$.agent.list()` `id`                                                                                                                                                                                                                               |
| S-A8 | In a Desktop-app session the mod rows still work (the tee is expected not to run there)                                                                                                                                                                                         |

---

## 9. Work packages

| WP                     | Scope                                                                                                                                                                                                                                | Depends on                                   | Size              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------------- |
| **WP-A0 protocol**     | 4.1 to 4.3: models, `oneLine`, `agentRowsFromEngine`, capabilities, `ModSyncRequest.agents`, `agent_stop`, `session.agents` + `ready.session_agents`, fixture, relay pass-through, testkit fakes and contracts, this doc. **Built.** | none                                         | S                 |
| **WP-A1 bridge + mod** | 5.1 mod collector, hooks and `agent_stop`; 5.2 `subagent-tee` + `install-subagent-tee` + plugin `settings.json`; 5.3 link / emit / trim / control wiring; the bridge contract driver; tests                                          | WP-A0                                        | M (1 to 1.5 days) |
| **WP-A2 web**          | 6.1 to 6.3: rail, chip, sheet section, rows, detail, Stop, store wiring; the view contract driver; vitest + Playwright at three widths                                                                                               | WP-A0 (builds on the fixture; A1 not needed) | M (1 day)         |
| Review                 | Code review of A1 + A2 against this doc; run the SMOKE table in a live session                                                                                                                                                       | A1, A2                                       | S                 |

A1 and A2 can run in parallel.

---

## Sources

- Mods reference: https://code.claude.com/docs/en/plugins/mods/reference.md
- Hooks (SubagentStart/Stop, TaskCreated, common `agent_id` / `agent_type`): https://code.claude.com/docs/en/hooks.md
- Status line, "Subagent status lines" / "Task fields": https://code.claude.com/docs/en/statusline.md
- Subagents (CLI panel, `/tasks`, stop): https://code.claude.com/docs/en/sub-agents.md
- Desktop (Background tasks pane): https://code.claude.com/docs/en/desktop
- Agent SDK TypeScript (`task_*`, `background_tasks_changed`, `stopTask`): https://code.claude.com/docs/en/agent-sdk/typescript.md
- What's new 2026-w33 (fork mode default): https://code.claude.com/docs/en/whats-new/2026-w33
- OBSERVED: the mod types Claude Code 2.1.296 writes into a plugin's `.claude-plugin/types/` on load; strings of the
  2.1.312 binary; `claude agents --json` keys; the on-disk subagent and task layout (structure only).
