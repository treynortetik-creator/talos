# Option C: a dedicated Claude Code session per thread (opt-in)

Status: being built in work packages. This page grows with each one. Everything here is **off by default**: with the
master switch off, or a thread left on `shared`, Talos behaves exactly as before (the main session answers every
thread, option B in [CLAUDE-CODE.md](CLAUDE-CODE.md) C8).

## The idea

- A thread can be switched to **Own session** (`Thread.session: 'dedicated'`). It then gets a **worker**: an ordinary
  interactive `claude` running in tmux under the desktop app (`tmux -L talos`, session `t-<thread_id>`, `--name
  talos-<thread_id>`). The supervisor starts it on the thread's first message, parks it after 30 minutes idle, and resumes
  it by session id on the next message. Never `claude -p`, never `--bg`.
- Workers load **no channels** and no development-channel flag. Main's live bridge stays the only relay socket. A worker's `talos-app` MCP server runs in **worker mode**: no relay socket, no pid takeover; it sends its frames through main's bridge over a local socket (`$TALOS_APP_HOME/hub.sock`).
- Inbound: main's bridge (the hub) keeps the verified message, writes a wake file with message ids only, and the
  supervisor types one fixed line into the worker (`Talos: new message in this thread. Call read_inbound.`). The worker
  fetches the message with `read_inbound`. A message nobody claims within 90 s (120 s after a cold resume) is answered
  by main, with a system row saying so. Never both.

## Data (WP-OC0, `packages/protocol/src/thread-sessions.ts`)

| Field                   | Meaning                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Thread.session`        | `shared` (absent = shared) or `dedicated`                                                                                                                                                                                                    |
| `Thread.session_opts`   | `cwd` (absolute, default the agent folder), `model` (`inherit` or an alias, set with `--model` at launch, never `/model`), `effort`, `idle_park_min` (5-720, default 30). A `worktree` key from an older config is ignored (removed 2026-11) |
| `AgentConfig.dedicated` | `enabled` (default **false**), `max_live` (1-6, default 3), `governor` {`five_hour` 80, `weekly` 85, `park_all` 95, `off` false}                                                                                                             |
| `SessionState.scope`    | `main` (absent) or `{thread_id}`: which session a `session.state` describes                                                                                                                                                                  |
| `SessionKind`           | gains `thread` for the Sessions view                                                                                                                                                                                                         |
- The switch is a signed `config.patch` (`threads` was already allowlisted; `dedicated` is added). No card, no step-up.
- `threadSessionMode(config, id)` is the one place that decides: `dedicated` only when `dedicated.enabled`, the thread
  asks for it, and it may have one. The default thread, `general`, `inbox`, `system` threads and archived threads are
  always shared (`canBeDedicated`).
- The bridge judges the **exact config it is about to write** (after `resolveThreadsPatch` and the schema), and only the
  threads that change touches (`dedicatedPatchIssue(before, after)`): a thread newly set to dedicated that may not have
  one, or a dedicated thread made the default. A config that already breaks the rule (a hand edit) never blocks unrelated
  edits, and a change that only turns things off (`dedicated: {enabled: false}`, a thread back to shared) is never
  refused. Archiving a thread, by the owner or by the agent's `archive_thread`, turns its session back to shared
  (`clearArchivedSessions`). Refusals answer `thread_session_refused` with the reason.
- The Mac checks a thread folder before saving it: absolute, no `.`/`..`, under `$HOME`, an existing directory, and not
  inside `~/.claude` or `$TALOS_APP_HOME`, checked again after resolving symlinks (`apps/bridge/src/worker/patch-check.ts`).
  This runs only when the folder changes, so the supervisor (WP-OC3) re-runs the same check before every start: the
  folder could be swapped for a symlink later.

### Frames

| Frame                                                                                  | Direction                    | Notes                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread.session.control {control_id, thread_id, action: park\|resume\|restart\|fresh}` | app → relay → bridge, signed | like `session.control`: durable until its result is recorded; answered with `session.control.result` under the same `control_id`                                                            |
| `workers.status {status}`                                                              | bridge → relay → app         | `supported`, `supervisor_online`, per-thread `state`/`model`/`cwd`/`last_turn_at`/`parked_at`/`error`, governor state. Not durable; the relay keeps the last one for `ready.workers_status` |

New error codes: `worker_unavailable`, `worker_cap`, `usage_governor`, `worker_folder_claimed`, `needs_mac`,
`thread_session_refused`. A fallback notification to main carries meta `routed="fallback"` and `reason=<code>`.

The relay passes both frames through (`apps/relay/src/session/index.ts`) and advertises `thread-sessions/1`. It keeps the
last `workers.status` for `ready.workers_status`, and each thread session's last `session.state` (one with `scope:
{thread_id}`) for `ready.thread_session_states`; a scoped state never replaces main's `session_state`.

### Compatibility with an older app

- `ready` and `config.sync` gain only optional keys; an older app's parser drops them (tested against the real parser of the last
  commit before Option C in `packages/protocol/test/option-c-compat.test.ts`).
- An older app's `SessionState` is strict and refuses `scope`. Rule: a bridge sends a scoped `session.state` only once
  the relay lists `thread-sessions/1`, and main's state never carries `scope`.
- An older app that edits threads leaves `session` / `session_opts` out; `resolveThreadsPatch` keeps them.
- Newer values never strand an older app. The app drops any frame that fails to parse, and a dropped `ready` would lose
  config, cards and unread counts, so everything here is tolerant when read: an unknown worker state, failure or governor
  reading becomes `unknown`, an unreadable status field is dropped, `ready.workers_status` and
  `ready.thread_session_states` fall back to absent, an unknown `Thread.session` reads as shared, and `session_opts` and
  `dedicated` fall back field by field, so a newer `max_live` never loses the master switch. Writes stay strict: `config.patch` runs `sessionFieldsIssue` on the merged object before anything is
  saved.

### Files shared by the bridge and the supervisor

| File                                     | Writer                                              | Schema                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$TALOS_APP_HOME/workers.json`           | supervisor only (atomic, 0600, heartbeat every 5 s) | `WorkersFile`; a torn or unknown-version file parses to `null` and the hub treats the supervisor as down                                                                                                                |
| `$TALOS_APP_HOME/workers/<thread>/wake`  | hub                                                 | `WakeFile`: message ids only, never content                                                                                                                                                                             |
| `$TALOS_APP_HOME/workers/<thread>/nonce` | supervisor, before each start (0600)                | the same value goes in the worker's env as `TALOS_APP_WORKER_NONCE`; the hub refuses a `hello` without it                                                                                                               |
| `$TALOS_APP_HOME/workers/<thread>/ready` | hub, on a good `hello`                              | `WorkerReady`; the supervisor's start is done when it appears                                                                                                                                                           |
| `hub.sock` lines                         | both                                                | `HubWorkerLine` (`hello`, `out`, `mod`, `rpc`), `HubHubLine` (`welcome`, `ack`, `refused`, `controls`, `rpc_result`); `mod` and `controls` are P1 (WP-OC5); `rpc` carries the four Schedules tools ("Thread schedules") |

Fixtures for all three: `packages/protocol/fixtures/option-c/`. Shared constants: `WORKER_POINTER_TEXT`,
`WORKER_BRIDGE_TOOLS`, `WORKER_FORBIDDEN_ARGS` (`--channels`, `--dangerously-load-development-channels`, `-p`, `--bg`),
`WORKER_STRIPPED_ENV`, the deadlines and the backoff.

## The bridge (WP-OC1 and WP-OC2, PR #65)

| Piece            | File                                              | What                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker mode      | `src/server.ts`, `src/instructions.ts`            | `TALOS_APP_WORKER_THREAD` set: never live (exit 2 with `TALOS_APP_BRIDGE=1` or a bad id), no channel capability, no permission relay, `WORKER_INSTRUCTIONS`                                                                                                                                                                                                                                         |
| Tools            | `src/tools/index.ts`, `src/tools/read-inbound.ts` | `WORKER_BRIDGE_TOOLS` only; `reply`, `attach`, `card`, `set_status` refuse any other thread and name only the worker's own; `card_result` only for its own cards                                                                                                                                                                                                                                    |
| Worker transport | `src/worker/transport.ts`, `src/hub/client.ts`    | hub up: every frame goes to the hub and waits for its ack; hub down: `reply`/`card.create` over `POST /bridge/post`, nothing else                                                                                                                                                                                                                                                                   |
| Hub socket       | `src/hub/server.ts`                               | live bridge only; `hello` needs a fresh `workers.json` entry, the nonce, and a pid in the recorded pane's process group (`ps -o pgid=`); `out` frames are re-parsed, size-checked and thread-checked (`reply`, `card.create`, `card.update`, `status`, `receipt` only, no permission cards), then sent and mirrored by the hub                                                                      |
| Router           | `src/router/router.ts`                            | wraps the live bridge's notification emit. Owner `text`/`file`/`voice_note` in a dedicated thread, and `card_action` on a card that thread's worker raised, are held as `worker_routes` rows and named in the wake file. A `schedule_run` for a job of that thread is held the same way (see "Thread schedules"); voice calls, hooks, digests, heartbeat wakes, shares and `backlog` stay with main |
| Claims           | `src/worker/store.ts`                             | `inbound_claims` (`INSERT OR IGNORE`): the worker's `read_inbound` or the hub's deadline, whoever is first. Deadlines are re-armed after a bridge restart                                                                                                                                                                                                                                           |
| Governor         | `src/router/governor.ts`                          | from main's rate limits (`five_hour`, `seven_day`); no reading = `unknown`, never blocks. Paused: parked threads fall back with `usage_governor`, live workers keep their pointers. Park-all: a `park` wake for every live worker, once per crossing                                                                                                                                                |
| Controls         | `src/router/controls.ts`                          | `thread.session.control` → a wake with that action; the result is a `session.control.result`, stored and replayed like `session.control`                                                                                                                                                                                                                                                            |
| Status           | `Bridge.optionCTick()` (every poll)               | `workers.status` when it changes, and on every `ready`                                                                                                                                                                                                                                                                                                                                              |

Rules the reviews added:

- **Cards stay with whoever raised them.** A raiser row is first-writer-wins. Over the hub, `card.create` needs a ledger
  row in the worker's thread already raised by it, and `card.update` needs the raiser; a worker's `card_result` and
  `supersedes` are checked before the shared ledger moves.
- **Switch-off is immediate.** With the master or thread switch off, `read_inbound` hands out nothing, the worker's tools
  and the hub refuse its frames (only a `card.update` on its own card still lands, so approved work can report), and the
  next tick hands every waiting message to main.
- **One worker per thread** on the hub socket. A second `hello` waits for the first socket to close.
- `thread-sessions/1` is in the bridge's `hello.client.features`; `workers.status` goes only to a relay that lists it.

Routing table (as built):

| Notification                       | Thread shared | Dedicated, reachable                                         | Dedicated, not reachable                    |
| ---------------------------------- | ------------- | ------------------------------------------------------------ | ------------------------------------------- |
| owner `text`, `file`, `voice_note` | main          | worker (wake + `read_inbound`), main after 90 s / 120 s cold | main at once, `routed=fallback`, system row |
| `card_action`                      | main          | the worker that raised the card                              | main + system row                           |
| `backlog`                          | main          | main (not split yet; main can pass it on)                    | main                                        |
| everything else                    | main          | main                                                         | main                                        |

"Not reachable" = supervisor heartbeat stale or `workers.json` unreadable, `workers_supported` false, the worker
`failed` or `stopping`, or the governor paused and the worker not live.

## The desktop supervisor (WP-OC3)

| Piece           | File                                      | What                                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerSpec`    | `TalosDesktopCore/WorkerSpec.swift`       | argv, env and the per-worker settings file. `validate()` refuses `--channels`, the dev-channel flag, `-p`/`--print`, `--bg`, `server:`/`plugin:` words, and any `TELEGRAM_*`/`IMESSAGE_*`/`TALOS_APP_BRIDGE`/`MCP_PROTOCOL_NEGOTIATION` env (except the two empty state dirs) |
| Files and rules | `TalosDesktopCore/Workers.swift`          | `WorkersFile`, `WakeFile` (decoded from the protocol fixtures in the tests), `DedicatedSettings` (the same front-door rules as `threadSessionMode`), `WorkerPolicy` (cap, LRU, idle, crash loop), `PointerTyper`                                                              |
| `WorkerManager` | `TalosSupervisor/WorkerManager.swift`     | the 1 s tick: heartbeat `workers.json` every 5 s, take wakes (rename, then read), start / resume / park / restart / fresh, type pointers, watch for dialogs, `No session found` and crashes, park idle workers, re-adopt live ones after an app relaunch                      |
| App             | `TalosDesktop/SupervisorController.swift` | runs the manager with the tmux host only; main's TakeoverCheck whitelists the worker process groups                                                                                                                                                                           |

How a worker is launched: `tmux -L talos new-session -d -s t-<id> -c <realpath> -- /bin/sh workers/<id>/launch.sh`. The
script (0600, deleted once the worker connects) is one line: `exec /usr/bin/env -i <the WorkerSpec env> <claude> <args>`.
`env -i` replaces the environment wholesale, so nothing in the tmux server's global environment (a token,
`TALOS_APP_BRIDGE`) can reach a worker; a file rather than tmux arguments because tmux caps a command at about 16 KB and
treats an argument ending in `;` as a separator. `-c` escapes `#`, since tmux expands it as a format: the folder checked is
the folder used. Args: the owner's permission flag, `--settings workers/<id>/settings.json` (Telegram and iMessage plugins
off, `effortLevel`), `--name talos-<id>`, `--model` unless `inherit`, `--append-system-prompt` (the agent folder's
`threads/<id>/WORKER.md`, else a built-in preamble), `--mcp-config workers/<id>/mcp.json` for a folder outside the agent
folder (only the `talos-app` entry, with any Telegram, iMessage or bridge env removed), then `--session-id <new uuid>` or
`--resume <id>`.

There is no runtime Telegram check (owner decision 2026-10-30: Telegram is being retired). The hard rule stays at the launch:
a worker never gets channels or a Telegram token. Plugins off, an empty state dir, `env -i`, and `validate()` hold it.

Rules as built:

- **Ready** = the hub's `workers/<id>/ready` file (written on a good `hello`) appears. 90 s without it stops the worker
  as `start_failed`. Nothing is ever typed into a dialog.
- **A dialog on a worker's pane** (workspace trust, MCP consent, login) is watched in every state that
  has a pane. A worker's screen is a conversation that may quote any of these words, so it counts only as a whole dialog
  (`DialogMatcher.liveDialog`): a rule row, then the dialog's phrase and its options with exactly one `❯` cursor (numbered or not:
  Claude's trust and MCP dialogs hide the numbers) and the footer `Enter to confirm · Esc to cancel`, in the bottom rows of
  the screen, unchanged for 5 s. The worker's own question menu is not one. The shapes come from real Claude Code 2.1.318
  captures (`apps/desktop/Tests/Fixtures/real-2.1.318`). A start waiting on such a dialog does not run out the 90 s ready timer. The worker is flagged needs-you (memory only, `WorkerManager.needsYou()`; the Terminals window shows the
  badge), and its own thread gets one plain line through `talos-app post` (the same signed path main's notices use): which
  prompt, and "open Terminals → <thread> on the Mac to answer". One line per dialog, and at most one per thread per kind of dialog in 10 minutes (kept in `workers/<id>/notice.json`, so a
  relaunch with the same dialog still open says nothing more; a record whose dialog is gone is closed at the first settled
  look after a relaunch and at every start). A clear failure of the post is tried three times and then shown
  in the Mac menu; a timeout is not retried, since `talos-app post` has no message key and it may have been sent. While starting, the pane is kept for the owner and the 90 s timer waits; a dialog nobody
  answers for 15 minutes (`dialogLimit`) stops the worker as `needs_mac`. A flagged worker is never idle-parked.
- **A new thread folder shows Claude Code's trust prompt once.** Talos does not pre-trust folders: Claude Code applies a
  folder's trust to every non-git folder under it, in every session, for good, and a write to its config could lose a save
  Claude Code makes at the same moment. The prompt is the owner's to answer; the Terminals window shows the thread as
  **Needs you**, and its thread gets the notice above.
- **Pointer**: `send-keys -l` then `Enter`, only at a screen with no dialog, only when Claude's input line holds no draft
  (the input box is the last pair of rule rows with a `❯` row between them, drawn `❯` + U+00A0; read from the pane with or
  without a client attached; a draft held for 2 minutes puts one line in the thread and shows the thread as Needs you), and only when
  no attached client typed in the last 10 s; one line per wake batch. A worker's screen is a conversation, so a dialog needs its shape
  (`DialogMatcher.workerScreen`): a selection cursor, or a line that is the login message, not one that quotes it.
- **One copy runs workers**: the holder of `flock` on `$TALOS_APP_HOME/workers.lock`. A second copy of the app stays passive
  and writes nothing until it can take the lock.
- **Never mid-turn**: the governor's park, a switch-off, Park now, Restart and Start fresh all go through `stopping` and
  wait for the pane to go quiet. `Quit and stop` and an idle cap victim stop at once.
- **A hung turn can't hold the thread for ever**: an owner's stop (Restart, Start fresh, Park now, Back to shared, the master
  switch off) waits 15 minutes from the first tap, on the awake clock. Then SIGTERM to the worker's own group, SIGKILL after
  the grace, and the queued action runs (`stop_limit`). The session id is kept and an unanswered message gets its row. A
  tap on a worker already `stopping` arms it, so a tap can rescue a governor's stop. The governor never does this, and
  nothing is typed to break the turn. The limit is memory only: after a relaunch a `stopping` worker has none until the
  next tap, because it might be the governor's.
- **Parked means gone**: `parked` waits for the whole process group, with SIGKILL after the grace, so a child that ignored
  SIGTERM can't outlive it; a crash kills what's left of the group too.
- **An unknown is a no-op.** A tmux read that fails is not an empty screen, a quiet pane or a dead worker: nothing is
  typed, signalled, killed, started or marked failed on it, and the next tick looks again. A worker is gone only when tmux
  says so (`can't find session`, `no server running`, or no socket at all), when its pane's pid isn't the worker's (pane ids
  restart with a new tmux server), or when the kernel says its group is empty. Unknown busy counts as busy. A failed
  `capture-pane` or `list-clients` means no typing. A failed read during adopt keeps the worker as the file has it and
  leaves its wakes in place until it can be read. A failed read during a start holds the start.
- **Clock jumps**: a turn, the ready wait and the park grace are timed on an awake clock that stops in sleep and never
  jumps, so waking the Mac can't look like a quiet pane or a wait long over.
- **What arrives on the way out** runs when the worker is gone, however it went (a crash included): a message resumes it,
  `restart` and `fresh` happen then, and neither stays armed for a later park.
- **Relaunch**: `starting` stays `starting`, the idle clock and the crash count carry on, and a worker pane with channels on
  its command line is stopped. An unreadable `config.json` keeps the last good settings; with none read since launch,
  running workers stay as they are and no wake is taken. A state in the file this build doesn't know gets the same look
  as a live one.
- **Quit and stop** stops the tick first and drops everything waiting, so nothing starts behind it. A worker that still
  can't be read stays for the next launch: nothing we can't prove is ours gets a signal. A passive copy writes nothing.
- **Idle**: no pointer and no output for the thread's `idle_park_min` → SIGTERM to the worker's own process group, SIGKILL
  after 5 s, `parked`. Output in the last 15 s counts as busy (no parking, never a cap victim).
- **Cap**: a start at `max_live` parks the longest-idle non-busy worker; with all busy the wake is held up to 2 min and
  then dropped (the hub's deadline hands the message to main). `parking` and `stopping` workers hold a slot, and a lowered
  cap parks the excess as they go idle, not counting the ones already on their way out.
- **Crash** while live → `parked` (the transcript is on disk; the next message resumes). 5 exits in 15 min →
  `crash_loop`. The CLI's resume error on a line of its own (`No conversation found with session ID`, or `No session found
  with ID`) during a start → `resume_missing`, id kept; `fresh` moves it to `previous_ids` (last 5).
- **Crash after a claim**: `read_inbound` has already told the phone `seen` and the deadline stood down. When the run that
  claimed a message has definitely ended with nothing said since (`parked`, `failed`, `off`, or a newer `started_at`), the
  hub posts one row in the thread. A stale heartbeat, an unknown state or a missing entry posts nothing. Kept in
  `claim_settled`, so a hub restart doesn't repeat it.
- **Switched off** (master switch or the thread back to shared): its worker parks.
- One worker per folder outside the agent folder (`folder_claimed`), compared by realpath, case-folded. It clears on its
  own when the other worker goes.
- A thread folder is re-checked before every start (`WorkerSpec.folderProblem`: realpath, under home, not `~/.claude`,
  named or wherever it links to, not the data folder, case-insensitive, and short and clean enough for `workers.json`); a
  folder swapped for a symlink since the bridge checked it fails the start.

Known gaps: a tool process that left the worker's group (Claude Code's Bash tool does) outlives a crash, and the next
message starts beside it. No new kill for this: such a process has no group of ours to signal, and finding it another way is a
pattern kill, which the spec forbids, and would also end a dev server or `nohup` job a worker meant to leave running. O14
measures it; if it hurts, the row after a crash says a tool may still be running. `afterPark` is memory only, so a Restart
in flight is lost across an app relaunch. A session that is running but that `workers.json` doesn't know (the app died
before its first write) stays refused as "already running" until it is closed in the terminal.

Not built yet (P1 / later): `/compact` before parking a large context (needs the mod's context reading), busy from
`claude agents --json` instead of pane output, `--worktree` for a second session in the same git repo, terminal tabs and
the "Thread sessions ▸" menu.

## The app (WP-OC4)

| Piece                      | File                                                                       | What                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Store                      | `apps/web/src/features/thread-sessions/store.ts`                           | the last `workers.status` (also from `ready.workers_status`); `useThreadSessionView(id)` = offered / unsupported / dedicated / worker; park, resume, restart, fresh as signed `thread.session.control`, answered by `session.control.result`                 |
| Own session                | `OwnSession.tsx`, in the thread settings sheet (`manage/ThreadEditor.tsx`) | the switch, shown only when `dedicated.enabled`, `workers.status.supported`, and `canBeDedicated` (never the default thread, General, Inbox); the cost note; the worker's state ("Live", "Parked 14:02", a failure in words); Park now, Restart, Start fresh |
| Settings → Thread sessions | `ThreadSessionsSection.tsx`                                                | the master switch (off by default; `config.patch {dedicated: {enabled}}`, no step-up), one row per dedicated thread (parked ones too), the "Saving limits" banner when the governor pauses                                                                   |
| Session sheet              | `features/session/SessionPanel.tsx`, `store.ts`                            | the weekly bar says "all sessions" once thread sessions are allowed; a thread-scoped `session.state` never replaces main's                                                                                                                                   |

Rules the reviews added: the switch also needs `thread-sessions/1` in `presence.features`; the store starts at the app
root, because `ready.workers_status` arrives once; a `ready` without it clears the status (an older Mac or relay); the
master switch stays reachable when it's on, even on a Mac that sends no status, since switching off is never refused; the
toggle uses `useThreadPatch` like every other thread edit; an unknown worker state reads "Unknown".

Fallback rows ("Thread session didn't pick this up … Main answered.") are ordinary system messages and render as such.

## Hand-offs

The `handoff` tool (`apps/bridge/src/tools/handoff.ts`, ledger in `src/worker/handoff.ts`) lets the main session orchestrate leads.
Args: `thread_id`, `type` (`TASK`, `RESULT`, `BLOCK`), `text` (100 words at most). One target per call.

- Main sends a `TASK` only, to a thread whose session is dedicated; a shared thread answers "That thread has no lead."
- A lead hands off to main only: its `thread_id` is its own thread (the worker thread lock), so another worker is refused. It answers with `RESULT` or `BLOCK`, or sends a `TASK` for a request outside its lane.
- Every hand-off is a system row in the lead's thread written by the live bridge. The label ("Talos → Trip lead: TASK") is the row's `handoff` field, drawn apart from the body, so the body can't imitate it. The row's id comes from the hand-off id, so it is never posted twice.
- The text is run through `sanitizeExternal` and made one line when it is recorded, like every other non-owner text: wrapper and `<channel>` look-alikes, special tokens and invisible characters are neutralised before the thread, the lead or main see it.
- The receiver gets `kind=handoff trust=agent`, never `owner`. A lead reads it with `read_inbound`; a parked lead is woken by the usual wake file. A hand-off has no deadline and no fallback to main while it waits. Main receives a lead's hand-off on the next poll tick. Delivery is three remembered steps (row posted, route added, delivered), so a crash or failure between them resumes without a double post.
- A hand-off is an agent's word, not the owner's: one recorded after the owner spoke cancels the owner's words for every owner-asked check (`config_propose`, schedule origin), like a share does.
- A TASK the lead has not claimed in 15 minutes (it would not start, a wake is held, it needs the Mac, it is crash-looping) comes back to main as a plain "The Trip lead didn't pick this up (TASK "<first words>"): <reason>" row and note (labelled as from the bridge, "Talos (the bridge)"; with a warm lead the reason is just "not picked up within 15 minutes"), and its slot is freed. A thread switched back to shared does the same for its pending TASK.
- Budget, in the `handoffs` table of `history.sqlite`: 5 a day each way per lead, counted from the last midnight in the owner's configured timezone (the refusal says when it resets; rows dated in the future don't count). At most 3 open TASKs per lead; a TASK stops being open only on the lead's `RESULT`/`BLOCK` (each closes the oldest still-open, non-expired TASK), when the thread goes back to shared, and after 24 h; a reply or card in the thread closes nothing, because main and the lead share the author `agent`. At the cap the refusal lists the open TASKs (first words and age) so main can wait or ask. A hand-off is retried until delivered, however late: there is no give-up. A `RESULT`/`BLOCK` needs an open TASK to close, and main's TASK within 10 minutes of that lead's RESULT is refused ("that looks like a reply to its RESULT"), so nothing replies to a RESULT.
- A lead's `RESULT`/`BLOCK` counts as its answer, so a session that ends after it gets no "stopped before it answered" row.

## Leads

A lead is a dedicated thread session given a role, a memory and a boot file in its own folder, outside the main agent
folder (`~/leads/<lane>/`), so it does not inherit the main agent's rules. The kit side is in [`kit/README.md`](../kit/README.md)
("Thread leads"); this is the bridge side.

- `talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--disable-mcp a,b]`
  (`apps/bridge/src/lead`, owner terminal only, like `memory init` and `apps scan`: `terminalOnly` refuses it from an agent
  or a pipe). `--agent-dir` defaults from `TALOS_AGENT_DIR` and must be a real agent folder (a `.talos-version` or a
  `CLAUDE.md` in it), so a typo is refused instead of fenced. Before the first byte is written it refuses the default thread,
  system threads and archived ones (`canBeDedicated`), a folder that fails the thread-folder rules (inside `~/.claude`, the
  Talos home, outside `$HOME`, also through a symlinked parent), a folder inside or around any protected root, a non-empty
  folder it did not create (it marks its own with `.talos-lead`) and a folder made for another thread. It then writes
  `CLAUDE.md`, `BOARD.md`, `decisions.md` once (never over an owner edit), always rewrites `.claude/settings.json` (keeping
  added rules), the two hook scripts and the marker (and removes the old `lead-guard.sh`), and sets `session_opts.cwd` with
  `ConfigFile.update`, after the same folder check as a `config.patch` (`checkWorkerFolder`). Every write is `O_NOFOLLOW`/rename after an `lstat`; a symbolic link
  anywhere it would write (the folder, `.claude`, `.claude/hooks`, a file) is refused before anything is changed. It never
  sets `session: dedicated`: that stays the owner's switch.
- `talos-app lead check <folder>` reports a brief over 6144 bytes, a board over 4096, a missing marker, hook or file, any
  fence rule or denied tool that has gone from `.claude/settings.json`, a sandbox that is off or not locked
  (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, a non-empty `excludedCommands` or `filesystem.allowRead`), a
  `.claude/settings.local.json` that sets `sandbox` or `permissions.allow`, and owner user settings
  (`<claude dir>/settings.json`; the marker's `claude_dir`, else the env, else `~/.claude`) that set `excludedCommands`,
  `filesystem.allowRead` or `allowWrite`, or `filesystem.disabled` (weakening every lead). Nothing runs it at session
  start: claude's own `failIfUnavailable` is the start-time guarantee, and this is the owner's check. Agents may run it.
- Templates are `kit/templates/lead/`. The Stop hook blocks once per stop and fails open on empty or invalid input; see the kit page.

**The fence: whole roots, enforced by the OS.** A lead lives outside the main agent folder and needs nothing in it, so the
fence lists no files. It names whole **protected roots**, kept in the `protect` list of the lead's `.talos-lead` marker:

1. the main agent folder (whole tree);
2. the whole Claude config folder, `CLAUDE_CONFIG_DIR` if set, else `~/.claude` (read once in `lead/cli.ts`, kept in the
   marker as `claude_dir`; a relative or `~` value is an error): transcripts, history, file history, settings, hooks,
   skills, agents, commands, `CLAUDE.md`. Always `~/.claude` too, and `~/.claude.json` and `~/.claude.json.backup` (MCP env
   vars, the project list). Claude Code itself still reads all of it, outside the sandbox; only the lead's tools and Bash
   are denied;
3. the Talos app home (whole tree: `media/`, `shared-inbox/`, config, keys, databases);
4. `~/private-agent-vault/` (the kit's default vault);
5. any folder given with `--protect <dir>` (kept on a re-run).

A root, the Claude folder or the lead folder with `* ? [ ] { }` in its path is refused at init: Claude Code reads it as a glob.

`.claude/settings.json` turns Claude Code's own Bash sandbox (Seatbelt on macOS) on and locks it: `sandbox.enabled: true`,
`sandbox.failIfUnavailable: true` (claude exits at start if the sandbox cannot run) and
`sandbox.allowUnsandboxedCommands: false` (the `dangerouslyDisableSandbox` parameter is ignored). Claude Code merges the
`Read(...)` deny rules into the sandbox's `denyRead` and the `Edit(...)` rules into `denyWrite`, so each root is
`Read(//<root>/**)` and `Read(//<root>)` (and Edit/Write), in the spelling given and in lower case. The kernel then
refuses the open for Bash and every child process: scripts, python, node, sqlite3, `~user`, variables, symlinks and hard
links into a root, other letter case, and under `--dangerously-skip-permissions`. A lead cannot make a hard link into a root,
but a hard link that already exists outside the roots is readable. The file tools (Read, Edit, Write) run outside the
sandbox and are held only by the deny rules; under the owner's skip-permissions flag, Edit and Write can still write
anywhere the Mac user can outside the roots (a shell rc file, say). The lead's own `.claude/**` and marker are denied to
Edit and Write. Other leads' folders are not roots. Grep and Glob rules stay for future versions. `Monitor`, `Tmux`
and `PowerShell` (they run outside the sandbox) and `SendMessage`, `ListAgents` and `RemoteTrigger` (other sessions: a lead
talks to main only through the `handoff` tool) are denied outright. There is no text parser and no PreToolUse hook.

_Where a lead can write._ In its own folder (and tmp, for Bash): the Bash sandbox confines writes there. The file tools run
outside the sandbox, so the places a write would take effect later are also denied to Edit, Write and NotebookEdit:
shell start-up files (`~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.zlogin`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`,
`~/.config/fish`), `~/Library/LaunchAgents` and `LaunchDaemons`, `~/.ssh`, `~/.gitconfig`, `~/.config/git`, `~/.npmrc`,
`~/.bunfig.toml`, the bin folders (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) and every absolute folder on
`PATH` when `lead init` ran (read once in `lead/cli.ts`; tmp, lead-folder, relative and glob paths are skipped).
The list is `LEAD_AUTOSTART_FILES`/`LEAD_AUTOSTART_FOLDERS` in `settings.ts`, best effort; `lead check` reports a missing
fixed-list rule, not the PATH ones (PATH differs between shells).

_Caches and network._ `npm`, `pnpm` and `bun` caches are outside the sandbox's writable area, and the shared ones are not
opened up (a lead could poison what main installs later). `env` in the settings points `npm_config_cache`,
`npm_config_store_dir` and `BUN_INSTALL_CACHE_DIR` into `<lead>/.cache/`. Network needs no setting. ssh remotes do not
resolve in the sandbox: a lead pushes over https.

_Connectors._ `disableClaudeAiConnectors: true`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, a `mcp__claude_ai_*` deny, and
`mcp__<server>__*` denies for the browser and computer-use defaults, `--disable-mcp`, and what the owner's main project
entry in `~/.claude.json` switched off (`disabledMcpServers`) plus every user-scope server there (talos-browser, blender and
the rest). A plugin's server uses its real tool prefix (`plugin:a:b` is `mcp__plugin_a_b__*`), and `mcp__plugin_*` denies every plugin
server. `talos-app` (from `--mcp-config`) stays; a server you add later that is in none of these lists is on.

**Thread lock for a worker.** `read_thread` is in `WORKER_THREAD_LOCKED_TOOLS` with `reply`, `attach`, `card`, `set_status`
and `handoff`: a worker naming another thread, or none, gets the same refusal. `list_threads` from a worker lists its own
thread only, so it cannot learn other threads' names or topics. `attach` from a worker refuses any file inside the Talos home,
because `media/` keeps every thread's files in one flat folder, and any file whose real path is inside a protected root in the
lead marker (`.talos-lead` in the thread's `session_opts.cwd`; compared after realpath, ignoring letter case and the
`/private` spelling). A marker that exists but cannot be read or parsed refuses every file; no marker, no change. `talos-app digest`, `post` and `inbox*` refuse to run when
`TALOS_APP_WORKER_THREAD` or `TALOS_SESSION_ROLE=worker` is set (the variables the desktop supervisor gives a worker), or
when a `.talos-lead` file is in the current folder or any parent (so unsetting the variables does not help; `cd /` does, and
the sandbox denying the Talos home is the real block). A
lead's search is **not** held to its own thread: no agent tool searches history today and the phone's `search.query` is
answered by the live bridge. `laneSearch` (`src/search/lane.ts`) exists for a future search tool and is not wired.

**What the fence is, and is not.** The OS decides what a process can open, not a reading of the command. It does not cover:
MCP servers (they read their own data outside the sandbox; `talos-app` stays, under its thread lock); hooks (they run
outside it, are written by the kit, and the lead cannot edit them); network exfiltration of anything the lead legitimately
has (its own folder, what a thread hands it); and the owner's user settings or `--settings` files, which can weaken it
(`lead check` reports the known keys). `talos-app digest`, `post` and `inbox*` also refuse from a lead's shell; that marker
check is a backstop (`cd /` gets past it), and the real block is the sandbox denying the Talos home. A lead can
read what the Mac user can read outside the roots. Run `talos-app lead check` after a Claude Code update.

## Thread schedules

A job that runs in a thread with its own session runs in that session; main keeps everything else. One Chronos, one
Schedules service, on main's bridge (owner decision 2026-11-05). Everything is off with the rest of Option C: a shared thread's
jobs fire in main exactly as before.

- **Routing.** The service offers a job as it always did (`schedule_run`, trust `owner`, the thread is the job's result
  thread). The router now treats `schedule_run` like an owner message: if the thread is `dedicated`, the notification is
  held in `worker_routes`, a wake file names the run id (the supervisor resumes a parked session, even at 3 am), and the
  session fetches it with `read_inbound`. Claimed in time, main is never told. Not claimed within the usual deadline
  (90 s, 120 s after a cold start), or the supervisor is down, the session failed, or the governor refuses a start: main
  gets the same notification (`routed=fallback`) and the thread gets "Thread session didn't pick this up (…). Main answered."
  Never both. **A heartbeat wake (`heartbeat` in its meta), a `schedule_held` notice, and a job in the default or a shared
  thread always go to main.** A session that took a run and stopped before reporting leaves "This thread's session stopped
  before it finished a scheduled job. Open Schedules to see how the run ended." (the run itself times out as for main).
- **The claim protocol from the worker.** `schedule_run_start` / `schedule_run_done` in worker mode are hub requests
  (`rpc` / `rpc_result` lines, `packages/protocol/src/thread-sessions.ts`). The hub answers as the thread the connection proved
  at `hello` (nonce and process group); the request cannot name another. The hub only accepts a run that is routed to that
  thread and claimed by `worker:<thread>` in `inbound_claims`; the Schedules service then does the Chronos claim exactly as
  for main (same instance id, same time-outs and orphan sweep).
- **Tool scope** is in docs/SCHEDULES.md S6.1 ("In a thread's own session"): list, propose, update, delete only for the
  session's own thread, every create an owner-approved card in that thread. The rules live in
  `apps/bridge/src/schedules/worker-scope.ts` and `ScheduleService`, so the hub, not the agent's tool wrapper, enforces them.
- **Which jobs, which workers.** Only a plain session job (runner `session`, not a command, not a heartbeat) is handed to a
  session; any other job of a dedicated thread is main's. A worker's `hello` carries `features: ["schedules/1"]`
  (`HubHello`, optional and read tolerantly); a session that is connected without it (an older worker) is not handed a run, main
  gets it with the usual note, and a parked or not-yet-connected one is assumed current. A worker whose hub refuses a hello that
  carries `features` (an older hub's strict schema) says hello again without it.
- **Old and new together.** An older hub ignores an `rpc` line (it is not in its schema): the worker's tool waits 60 s and
  reports that it may or may not have run. A worker that predates this has no schedule tools, so nothing asks. Nothing in the
  card payload changed, so an older app shows the card with its old wording and buttons.
- **App.** Schedules is grouped by thread (docs/SCHEDULES.md S5.2a), each group saying who runs it.
- **The worker preamble.** `WORKER_INSTRUCTIONS` now tells a thread session how to use schedules (see `WORKER_SCHEDULE_TEXT`).
  A per-agent `WORKER.md` or the desktop supervisor's built-in preamble that says workers do not own schedules should be
  changed to match (the supervisor's text is in `apps/desktop`).

## Work packages (numbering as in the spec, section 10)

| WP  | Contents                                                                                        | PR    |
| --- | ----------------------------------------------------------------------------------------------- | ----- |
| OC0 | protocol, the config switch (off by default), the Mac-side patch checks, the relay pass-through | #63   |
| OC1 | worker-mode bridge, the hub socket, `read_inbound`, the claim tables, the thread lock           | #65   |
| OC2 | router: wake files, deadlines, card `raised_by`, governor, system rows                          | #65   |
| OC3 | desktop supervisor: WorkerSpec, cap and parking, pointer typing, re-adopt                       | #68   |
| OC4 | web: the Own session switch, worker status, Settings rows                                       | #69   |
| OC5 | the Talos mod in workers (P1)                                                                   | later |
| OC6 | the agent's own hooks (private, outside this repo)                                              | later |
| OC7 | docs and the smoke list                                                                         | later |
