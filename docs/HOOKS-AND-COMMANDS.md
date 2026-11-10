# Commands list and owner event hooks (design)

Status: design only. Nothing here is built yet beyond what section 0 says exists. Phase 1 (section D) is the first package.

Two extension seams:

- **A. The commands list:** a machine-readable list of what can be run, so an agent reads it instead of guessing.
- **B. Owner event hooks:** owner scripts that run when a named lifecycle event happens.

## 0. What exists today

- `talos commands` and `talos commands --json` exist: `cmdCommands` in `apps/bridge/src/talos.ts`.
- The JSON today is `{ enforced: 'terminal', note, commands: CommandInfo[] }`, where `CommandInfo` is `{ name, summary, agent_may_run,
  needs_terminal? }`. A name is one word or `word sub`.
- There is ONE source: `export const COMMANDS` in `talos.ts`. The same list drives `terminalOnly()` and `terminalOnlyNames()` (the
  permission deny rules) and the worker fence.
- `WORKER_COMMANDS_OK` in `apps/bridge/src/worker/cli-refusal.ts` is a second, hand-kept list of what a thread session may run.
- `talos-app` itself: `apps/bridge/src/cli-main.ts` has a hand-kept `USAGE` string and a `switch` of `case '<cmd>':`.
- Existing honesty tests (`apps/bridge/test/talos.test.ts`): every COMMANDS name has one probe and every probe is listed; every listed
  command reaches its handler through the real CLI; every listed top-level name has a `case` in `cli-main.ts`.
- Gaps: a `case` in `cli-main.ts` that is not in COMMANDS is not caught, and `USAGE` is not checked against COMMANDS.
- The web palette's slash commands are a different thing: `InventoryCommand` (`packages/protocol/src/session.ts`) lists Claude Code's
  slash commands, filtered by `filterCommands` and blocked by `commandBlock` in `apps/web/src/features/session/logic.ts`. The two lists
  stay separate.

## A. The commands list

The list already exists, so this is an upgrade: richer rows and a CLI that is honest in both directions.

JSON v1 (additive; today's keys stay):

- Top level: `schema: 1`, `app_version`, `commands[]`.
- New optional fields on `CommandInfo`:
  - `args`: the usage string, e.g. `[--json] | revoke <id>`. Today it lives only in the `USAGE` text.
  - `who`: `'agent' | 'owner' | 'owner_terminal'`, derived from `agent_may_run` and `needs_terminal`. The old booleans stay.
  - `effects`: a list from `'read' | 'writes_home' | 'writes_agent_dir' | 'network' | 'changes_app'`.
  - `risk`: `'low' | 'ask' | 'high'`, where `ask` means behind an approval card.
  - No `needs_mod` field: no CLI row needs the Talos mod. Add it when a row does.
- Single source: new fields are added in `COMMANDS` only.
- `USAGE` is generated from `COMMANDS` (`args` + `summary`), with a test.
- `WORKER_COMMANDS_OK` is derived from `COMMANDS`, or tested to be a subset of the `agent_may_run` rows.
- Versioning: the `schema` integer. Adding a field does not bump it; renaming or removing one does. Readers ignore unknown keys.
- Honesty tests:
  1. Every `case '<x>':` in `cli-main.ts` is a COMMANDS top-level name, or on a short named exception list.
  2. The generated `USAGE` covers every COMMANDS row.
  3. Every `needs_terminal` row has `agent_may_run: false`.
  4. The JSON parses against a `CommandsList` zod schema in `packages/protocol`, with a fixture.

## B. Owner event hooks

### B1. Named events that exist today

| Event                  | Emitted at                                        | Payload                                         |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `thread.folder_chosen` | `emitFolderEvents` in `apps/bridge/src/events.ts` | `thread_id`, `cleared` (never the path)         |
| `dialog.card_posted`   | `apps/bridge/src/dialog-card.ts`                  | `dialog_kind`, `thread_id`, `card_id`           |
| `dialog.card_answered` | `apps/bridge/src/dialog-card.ts`                  | `dialog_kind`, `thread_id`, `card_id`, `choice` |
- Mechanism: `emitEvent(log, name, fields)` writes one `log.info('event', …)` line. Nothing subscribes yet.
- The Mac app's `devCardOffered` / `devCardAnswered` are in-process Swift events, not bridge events.
- `keymap:changed` is only named in a comment in `apps/web/src/lib/keymap.ts`; nothing emits it. It is a web, per-device moment, so
  it needs a frame to the bridge before a bridge hook can see it. Its name moves to the rule below (`keymap.changed`).
- There are no schedule run events yet.

### B2. Rules

- Names are `<area>.<past_tense_snake>`, lowercase, e.g. `thread.folder_chosen`. One registry, `packages/protocol/src/events.ts`,
  holds every name and its payload schema; today's constants move there.
- Payloads carry ids and enums only, never free text, paths, tokens or card bodies. A card answer's ids and enum `choice` may reach a
  hook; free text never does. Each event has a zod schema, and a test checks that `emitEvent` fields parse.
- A hook's folder is named after its event: `<talos home>/hooks/<event>.d/`, with executables run in sorted order. The home comes from
  the `paths()` helper in `apps/bridge/src/config.ts`.
- How a hook runs: `spawn(file, [], { shell: false })`, with no arguments from the payload. The payload is one JSON line on stdin, plus
  `TALOS_EVENT` and `TALOS_EVENT_ID` in a clean environment (no bridge secrets). The working folder is the hook folder.
- Hooks never block. They are fire-and-forget: the bridge never waits, and a failing hook never delays or changes the event. A veto
  would be a different feature with its own card.
- Limits: a 10 s timeout that kills the process group, a capped output (e.g. 4 KiB) that is logged, and a per-minute rate limit.
- Where it runs: the bridge, since all three existing events are bridge events.
- Logging: one `hook.ran` line per run (event, hook, exit code, ms, truncated). Hooks never fire on `hook.*` events, so there are no
  loops.

### B3. Keeping hooks the owner's

Checked at every run, not once:

- The folder and file are owned by the current user, have no group or world write bits, and are not reached through a symlink.
- The file is on the owner's approved list (`hooks.json`: `{ event, file, sha256 }`). A hook whose hash changed does not run until it
  is approved again.
- A hook is enabled or approved only through an owner card in the app (agents customize only through cards). The card shows the event,
  the file name, its hash and what the script will see.
- The hooks folder is added to the agent deny rules alongside the other Talos-home paths.

Honest limit: an agent with a same-user shell can write any file the owner can, including `hooks.json`, and can change permission bits.
The card and the hash do not stop that. They stop a hook appearing or changing without the owner seeing a card, a script swapped after
approval, accidents, and other OS users. The real barrier stays the deny rules on the Talos home and the worker CLI fence, which is
itself a guard against accidents, not a lock.

## C. Standing rules

- **Shipped defaults vs the owner's changes:** no hooks ship; the owner's hooks live in the Talos home, apart from repo and kit files.
- **One settings registry:** the owner's on/off switch is a `hooks.enabled` row in `packages/protocol/src/settings-table.ts`, set so an
  agent cannot change it. `hooks.json` holds approvals only, not settings.
- **Feature list:** `bridgeFeatures()` (`apps/bridge/src/handshake.ts`) is capability negotiation only. It advertises `hooks/1`; it is
  not the owner's switch. The list has a cap (see docs/V2-FEATURES.md), so count first.
- **Tokens, not literals:** the timeout, output cap and rate limit are named constants in one place.
- **Named lifecycle events:** the B2 registry.
- **Re-runnable migration and a way back:** `talos-app hooks init` is idempotent (creates the folder 0700 and an empty `hooks.json`);
  turning `hooks.enabled` off or deleting the folder returns to today's behaviour.
- **Agents customize only through cards:** B3.
- **Public extension points:** plain executables with JSON on stdin, not a private plugin API. Claude Code's own hooks stay separate.

## D. Phases

1. **Events registry and commands upgrade, no hook execution** (~250 lines, mostly tests).
   - `packages/protocol/src/events.ts`: name, payload schema, emitter, status. The three constants move there.
   - `CommandInfo` gains `args`, `who`, `effects`, `risk`; `schema`, `CommandsList` zod and a fixture; `USAGE` generated from COMMANDS.
   - Tests: section A's four honesty tests; every `emitEvent` call uses a registered name; payloads parse; the worker list check.
   - `talos events --json` lists the event table, so agents can read it too.
2. **Hook runner, bridge only, owner-approved** (~400 lines).
   - Runner (spawn, timeout, cap, clean env, rate limit), ownership checks, `hooks.json` with hashes, the `hooks.enabled` row, `hooks/1`.
   - Tests with fake scripts in temp folders: runs once per event; the timeout kills; a world-writable file is refused; a changed hash
     is refused; the payload has no path; `hook.*` never fires a hook; a thread session cannot run the `hooks` command.
3. **Owner card to enable or approve a hook** (~300 lines). A new card kind on the phone and web, through the dialog-card path. Tests:
   no approval without the card's answer; a denied card means no run.
4. **More events:** the Mac's card events, `keymap.changed`, schedule runs. Each needs an emitter (and, for Mac and web events, a
   frame to the bridge) first. `keymap.changed` waits for the rebinding package.

## E. Decisions

1. No `needs_mod` field until a row needs it.
2. `USAGE` is generated from `COMMANDS`, with a test.
3. Hooks never block; fire-and-forget only. A veto would be a separate feature with its own card.
4. `bridgeFeatures()` is capability negotiation; the owner's on/off is `hooks.enabled` in settings-table, and the feature list only
   advertises `hooks/1`.
5. Hooks may see a card answer's ids and enum choice, never free text.
