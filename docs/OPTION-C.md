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

| Field                   | Meaning                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Thread.session`        | `shared` (absent = shared) or `dedicated`                                                                                                                                                                                                                                                                                |
| `Thread.session_opts`   | `cwd` (absolute, default the agent folder), `model` (`inherit` or an alias, set with `--model` at launch, never `/model`), `effort`, `idle_park_min` (5-720, default 30), `mcp_allow` (optional list of MCP server names, see "Leads and the fence"). A `worktree` key from an older config is ignored (removed 2026-11) |
| `AgentConfig.dedicated` | `enabled` (default **false**), `max_live` (1-6, default 3), `governor` {`five_hour` 80, `weekly` 85, `park_all` 95, `off` false}                                                                                                                                                                                         |
| `SessionState.scope`    | `main` (absent) or `{thread_id}`: which session a `session.state` describes                                                                                                                                                                                                                                              |
| `SessionKind`           | gains `thread` for the Sessions view                                                                                                                                                                                                                                                                                     |
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

| File                                                | Writer                                                 | Schema                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$TALOS_APP_HOME/workers.json`                      | supervisor only (atomic, 0600, heartbeat every 5 s)    | `WorkersFile`; a torn or unknown-version file parses to `null` and the hub treats the supervisor as down; one entry's failure code that this build does not know reads as `unknown` for that entry and never costs the file |
| `$TALOS_APP_HOME/workers/<thread>/wake`             | hub                                                    | `WakeFile`: message ids only, never content                                                                                                                                                                                 |
| `$TALOS_APP_HOME/workers/<thread>/nonce`            | supervisor, before each start (0600)                   | the same value goes in the worker's env as `TALOS_APP_WORKER_NONCE`; the hub refuses a `hello` without it                                                                                                                   |
| `$TALOS_APP_HOME/workers/<thread>/ready`            | hub, on a good `hello`                                 | `WorkerReady`; the supervisor's start is done when it appears                                                                                                                                                               |
| `~/.talos-inbox/<thread>/` (outside the Talos home) | hub (0600 files in 0700 folders, never through a link) | the owner's files for that thread, copied from `media/` as the message is routed; `read_inbound` returns these paths; removed after 7 days or past 1 GiB, and with the thread                                               |
| `hub.sock` lines                                    | both                                                   | `HubWorkerLine` (`hello`, `out`, `mod`, `rpc`), `HubHubLine` (`welcome`, `ack`, `refused`, `controls`, `rpc_result`); `mod` and `controls` are P1 (WP-OC5); `rpc` carries the four Schedules tools ("Thread schedules")     |

Fixtures for all three: `packages/protocol/fixtures/option-c/`. Shared constants: `WORKER_POINTER_TEXT`,
`WORKER_FORBIDDEN_ARGS` (`--channels`, `--dangerously-load-development-channels`, `-p`, `--bg`),
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
  as `start_failed`. Nothing is typed into a dialog except the one guarded answer to a tap ("Needs-you prompts" below).
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
- **Pointer**: `send-keys -l` then `Enter`, only when Claude's input box is on the screen and holds no draft, only at a screen with
  no dialog, and only when no attached client typed in the last 10 s; one line per wake batch. The box is `PointerTyper.inputBox`:
  the last pair of rule rows whose first row between them starts with `❯` (the real one is `❯` + U+00A0, but only the `❯` is checked;
  a dialog's option row is not between two rules). The box and the draft are read from the pane with or without a client attached.
  A worker goes live when the hub's `ready` file appears, which can be before Claude has drawn its screen, so a blank pane, a banner
  without a box, or a dialog caught half drawn gets nothing typed: the pointer waits (an Enter owed after the text went in waits the
  same way). What the owner sees: a draft held for 2 minutes (`draftNoticeAfter`), or no input box for `readyTimeout` (90 s, counted
  from when the pointer is due), puts ONE line in the thread ("<thread>'s session isn't showing its input box yet. Open Terminals →
  <thread> to see what it's waiting on.") and shows the thread as **Needs you** in the Terminals window until it clears. The worker is
  never stopped for this and is not idle-parked while the pointer waits. When the box appears the pointer is typed as usual and the
  hold is forgotten, its record in `notice.json` deleted, so a later hold tells the thread again. A worker's screen is a conversation,
  so a dialog needs its shape (`DialogMatcher.workerScreen`): a selection cursor, or a line that is the login message, not one that
  quotes it.
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
- **Idle**: no pointer, no change on the screen above the input box's lower rule, and no key from an attached tmux client for
  the thread's `idle_park_min` → SIGTERM to the worker's own process group, SIGKILL after 5 s, `parked`. What is drawn under
  that rule (the footer, and the owner's `statusLine`, which repaints when usage changes in any session) is not activity; a
  screen with no input box counts whole. The clients' key times are read only when the park is due, and a list that can't be
  read holds the park. Any output in the last 15 s still counts as busy (no parking, never a cap victim), so a status line
  that repaints more often than that keeps a worker from parking. The last activity is saved in `workers.json` as
  `last_active_at` (optional, written with the heartbeat while the worker has a pane, absent once parked; a value that is not a
  time reads as none, and a bridge that doesn't know the key ignores it). A relaunch seeds the clock from the latest of that,
  the last pointer and the start (never later than now), not from the pane's last output.
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
in flight is lost across an app relaunch; an owed pointer mostly is: `pointer_owed_until`, and `enter_owed` once its text is in the
input box, are in `workers.json`, and a relaunch types what is still wanted and finishes a line whose Enter was lost with the
Enter alone (or types the line again if the box was cleared meanwhile). The invariant: an owed Enter is sent only when one capture, with its colours, taken right before it shows the
box holding exactly our line at normal intensity (`boxHoldsOnlyOurLine`); a read that fails, or finds no box, sends nothing. An empty
box that the screen has had the chance to fill means the text is gone, and the whole line is typed again: the box decides that, not
whether a draft hold was running or an earlier look was taken. Right after the text is typed the screen gets ten looks with nine
30 ms pauses (about 0.27 s plus the reads) to show it, since a screen that has not drawn it yet also reads as empty; if it shows, the
Enter goes in the same tick, if not it waits for a later tick. Two trade-offs. The Enter needs an exact read-back of our line (the
box's rows joined over white space): that holds at 120 columns and at the viewer's 80-column minimum, but a width or a wrap that made
our own line read differently would hold it as an owner's draft (the thread is told after 2 minutes) rather than send it. And if the
screen takes longer than 5 s (`screenLag`, on the awake clock) to draw typed text, the empty box is read as gone ONCE per unseen
episode and the line is typed again: were the first keys only buffered, both copies land, read as the owner's draft and are held with
the usual notice, never typed a third time; were they dropped, the second copy lands. A line that still does not appear is not typed
a third time: the pointer waits, and the message goes to main at the hub's deadline. What remains: the deadline is the hub's
(`CLAIM_DEADLINE_MS`, or `_COLD_MS` for a wake that started the worker) counted on the Mac from when the hub wrote the wake or the
Mac took it, so it is an estimate, not the hub's own claim table, and can still be a tick off. Once it has passed nothing is typed,
and our own line is taken out of the box with Backspace only when the box holds exactly that line and no tmux client is attached
(nobody can type into a pane without one); with a client attached, or anything else in the box, it is left alone and the thread
gets one line. The line is recognised by its text, joined over the box's rows, which assumes Claude wraps at spaces: checked on real
Claude Code 2.1.319 captures at 120, 40 and 30 columns (`Tests/Fixtures/real-2.1.319`), where the line wraps at spaces with the
continuation rows indented two spaces, and one 53-Backspace burst empties the box at 120, 40 and 30 columns. A session that is
running but that `workers.json` doesn't know (the app died before its first write) stays refused as "already running" until it is
closed in the terminal.

### Needs-you prompts: the Mac side, as built

The contract is "Needs-you prompts" below (`packages/protocol/src/dialog-files.ts`); this is how the Mac app (`apps/desktop`) keeps it.

- **Reading the screen.** `DialogReader` reads only what `DialogMatcher.liveDialog` already calls trust, MCP consent or login, from the real
  2.1.318/2.1.319 captures: unnumbered rows under the last frame rule with one `❯` row, every sibling aligned under its text, then
  `Enter to confirm · Esc to cancel` and nothing after. The cursor row is read, never assumed (it starts on "No, exit" in trust and on
  the last row in MCP consent). The capture with colours (`capture-pane -e`) must be the same screen, with only the cursor row coloured
  and nothing dim. A folder or server name wrapped over rows, or cut with an ellipsis, is `subject: null`, never a half. The plural MCP
  dialog, duplicate labels, a row past 62 characters (a label that long may wrap, and its continuation row would read as one more option:
  the longest real row is 56) and any extra row are not read at all, and a dialog that is not read is not offered: it keeps the thread
  line at once. Login is a kind only (its screen is the input box with `Not logged in · Run /login`). Labels and subjects are compared
  character for character, by unicode scalars, not as Swift's `==` does.
- **The card wait.** A dialog is offered when its screen has held still (`dialogSettle`). The thread line waits `cardAckWait` (15 s) from
  the Mac's first sighting for `dialog-card.json` naming that dialog in any status; with one there the Mac never posts the line for it. No
  worker is stopped for a dialog but a STARTING one after `dialogLimit` (900 s), as before.
- **One sighting, one id.** The id lives in the worker's `workers.json` entry, so a relaunch finds it; but a record read back from disk is
  never pressed on. An agent can edit that file while the app is down, so an answer waits until THIS process has seen the dialog on the screen
  hold still, and the offer then has to equal the screen's own read (else it is a new sighting under a new id). The next settled sighting also
  gets a new id after ANY Enter the Mac sent, and after any change of the screen under an offer this process had verified (the owner's Enter
  in the pane, a second server's dialog that looks the same, even a cursor move), so an old card never applies to the next dialog.
- **Keys.** `TmuxCommands.sendDialogKey` takes a `DialogKey` (Up, Down, Enter) and sends it by tmux key name, leaving copy mode in the same
  invocation. `DialogAnswer` plans arrows then Enter from the CURRENT cursor row of a fresh read and never relies on the Select wrapping
  at its ends (it does wrap). The loop reads again after each arrow and needs the highlighted row exactly one step on; Enter goes only
  when the highlighted label is the signed choice's, never twice for one dialog. Before each key, and again right before the Enter and its
  last look at the screen, the Mac checks that no tmux client typed within `clientQuiet`; a `list-clients` it cannot read counts as typing
  (the pointer's guard says "not typing" for what it cannot read, a key into a dialog never does). A send that timed out counts as sent.
  Any mismatch stops with `nothing_pressed` (reason `screen_changed`).
- **Who may answer.** `isAuthentic` (`WorkerDialogAnswer.swift`) is the contract's five steps (`DialogProofCheck`); the signer's key comes
  from `DeviceKeys.pinnedKey`, the one place to change: it reads `devices.json` as the bridge does (any object with a `devices` array; a
  regular file, no link, 256 KiB at most; an entry that is not an object fails the whole file; no entry for the id revoked; the key's id
  equal to the entry's). `devices.json` is writable by the agent: the only guard on the signer source is the bridge's tripwire, not the
  operating system. Nothing in an answer file is authority but its proof. An answer for a dialog id that is not on the pane is `unverified`.
  A signed tap (its signature, per dialog id) is used once, whatever came of it: the same proof dropped again under another `control_id`
  (which is not signed) gets `already_answered`, even after a `nothing_pressed`. The folders `workers/` and `workers/<id>/` are refused if
  they are links, for reading and for writing; the answer is renamed away before it is acted on; each `control_id` is acted on once.
- **Open on the Mac.** `open` types nothing. It is the owner's own tap, so Terminals comes to the thread even inside the quiet window
  (quiet hours stop notifying the owner, not the app acting on his tap), forward but not key. If no window can be brought (no handler, or
  it says no) the result is `nothing_pressed` with no reason: none of the contract's reasons fits, and `opened` is never claimed for nothing.
- **The Mac popup.** A dialog the Mac OFFERS (settled on the screen and seen by THIS process, `offer.sinceAwake` set; never a record only
  read back from workers.json; not past `expires_at`) also gets a small native popup: `WorkerManager.popupOffers()` lists them, the popup is
  `TalosDesktop/NeedsYouPopup.swift`, and what it shows and when is the pure `NeedsYouPopupCoordinator` (`TalosDesktopCore/NeedsYouPopupModel.swift`).
  Plain words above the buttons, the SAME words as the phone and web card: the heading and the one-line explanation per kind come from one
  table, `DIALOG_WORDING` in `packages/protocol/src/dialog-card.ts` ("Trust this folder?", "Allow this MCP server?", "<thread> needs you to
  sign in"; "sign in", never "log in"), committed as `fixtures/needs-you/wording.json`, and the popup's tests assert the popup's text equals
  it. The folder or server is in a monospace box. The buttons are the dialog's options exactly as read, in screen order, with hidden
  characters shown as `⟦U+XXXX⟧` (`DialogVisibleText`, a port of the card's `dialogVisibleText`, tested against the shared table
  `fixtures/needs-you/visible-text.json`); what is pressed is the label as read, not as shown. Login has one button, "Open in Terminals".
  _Window rules:_ an `NSPanel` that is `.nonactivatingPanel`, `becomesKeyOnlyIfNeeded`, can never become key or main, has no default button
  and no key equivalent on any button, and eats any key event it is sent, so Return and every other key do nothing: keys never reach it (so
  Esc does nothing either). The close button only hides it (nothing is pressed, the card stays). A click is required, and only a real one:
  the button's action proceeds only when the event the app is handling is a left mouse button event on that button, a moment old at most,
  because an Accessibility press or an AppleScript click reaches the same action but sends no mouse event. A click in the first 0.6 s after
  a popup appears, or after it moves on the screen (the one above it closed or grew), is ignored: a popup under the cursor is not answered
  by the click that was meant for something else. Floating level, `sharingType = .none`, one popup per dialog id, at most three shown
  (oldest first, the rest wait), each placed before it is put on the screen. _Quiet hours:_ no popup while `StatusCoordinator.quietNow ==
  true`; one still offered when the window ends is shown then; `nil` (bridge not read) shows. _It closes_ when the dialog id is no longer
  offered (gone, a new sighting, expired), when something was actually pressed or opened for it (a verified card answer or a click), or
  when the owner hid it (a hidden one does not come back for that id). A result that pressed nothing, such as `unverified` for a forged
  answer or a phone that is not paired, closes nothing: the card says "Answer on the Mac", and the popup is how.
  _The click_ is `WorkerManager.popupAnswer`, reachable only from the popup button's action on the main thread (no file, URL scheme,
  AppleScript or notification calls it); it runs on the worker queue, so the main thread never waits. It is the same press path as a
  verified card answer: the dialog id must be the one offered now with `sinceAwake`; the option's label must equal, by unicode scalars, the
  label the owner saw, the offer's, and the screen's NOW at that row; the typing guard fails closed; arrows then Enter from the fresh cursor
  row. No proof is asked: the click is the owner's, at the Mac. _One press per dialog id, shared:_ whichever comes first, a verified card
  answer or the click, presses (`enterSentFor`, or `openedFor` for login); the other gets nothing (a later card answer: `nothing_pressed`,
  `already_answered`, also when the dialog has left the pane since, from the Mac's own record of what it pressed; a later click: "Already
  answered on <device>", the device from `dialog-card.json` status/by, display only).
  _Result before drop:_ success writes `dialog-result.json` `{v:1, dialog_id, source:'mac', outcome:'pressed'|'opened', choice, label, at}`
  (0600, atomic, the same link refusals) before the click returns, and the dialog leaves workers.json only on a later tick, so the bridge
  shows "Answered on this Mac" only once workers.json shows the dialog gone. A failed click writes NO result file (the schema has no mac
  `nothing_pressed`); the popup says why in words for six seconds, even if the dialog goes away meanwhile: "Nothing pressed: <thread>'s
  screen changed, so Talos left it alone. A new popup comes if it still needs you.", "You were typing in <thread>'s session, so Talos left
  it alone." (a typing client), "Talos could not check whether you were typing in <thread>'s session, so it left it alone." (tmux clients
  unreadable), "Already answered on <device>", or "Nothing opened: …" (login, no Terminals window). Then, if the same dialog id is still
  offered, it asks again, with a fresh first moment.
- **Known limit.** A press (up to three arrows, each waiting for the screen, and the Enter) runs on the worker queue and holds that tick
  for as long as it takes (a few seconds at the most); moving it off the tick is a follow-up.

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

- `talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--mcp a,b] [--sandbox | --light]`
  (`apps/bridge/src/lead`, owner terminal only, like `memory init` and `apps scan`: `terminalOnly` refuses it from an agent
  or a pipe). `--agent-dir` defaults from `TALOS_AGENT_DIR` and must be a real agent folder (a `.talos-version` or a
  `CLAUDE.md` in it), so a typo is refused instead of fenced. Before the first byte is written it refuses the default thread,
  system threads and archived ones (`canBeDedicated`), a folder that fails the thread-folder rules (inside `~/.claude`, the
  Talos home, outside `$HOME`, also through a symlinked parent), a folder inside or around any protected root, a non-empty
  folder it did not create (it marks its own with `.talos-lead`) and a folder made for another thread. It then writes
  `CLAUDE.md`, `BOARD.md`, `decisions.md` once (never over an owner edit), always rewrites `.claude/settings.json` (keeping
  added rules), the two hook scripts and the marker (and removes the old `lead-guard.sh`), and sets the thread's
  `session_opts.cwd` and `session_opts.mcp_allow` with `ConfigFile.update`, after the same folder check as a `config.patch`
  (`checkWorkerFolder`). Every write is `O_NOFOLLOW`/rename after an `lstat`; a symbolic link anywhere it would write (the
  folder, `.claude`, `.claude/hooks`, a file) is refused before anything is changed. It never sets `session: dedicated`:
  that stays the owner's switch. It knows the thread id from its first argument; the id goes into the marker (`thread`),
  which `lead check` uses to find the thread's allow list.
- `talos-app lead check <folder>` reports a brief over 6144 bytes, a board over 4096, a missing marker, hook or file, any
  fence rule or denied tool that has gone from `.claude/settings.json` (a missing credential-folder deny by name), and, for
  a sandbox lead, a sandbox that is off or not locked (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, a
  non-empty `excludedCommands` or `filesystem.allowRead`), a `.claude/settings.local.json` that sets `sandbox` or
  `permissions.allow`, and owner user settings (`<claude dir>/settings.json`) that weaken the sandbox. Both profiles are
  valid. It always prints what the profile does not stop (below), and flags a claude.ai connector on the thread's allow list (the
  list itself is applied by the Mac app, so it checks no MCP deny against it). Nothing runs it at session start; this is the owner's check. Agents may run it.
- Templates are `kit/templates/lead/`. The Stop hook blocks once per stop and fails open on empty or invalid input; see the kit page.

## Leads and the fence

The goal: a thread's own session (a "lead") cannot reach what is not its lane **by accident**. This is a fence, not a vault.
A determined process that runs as you can get past most of it, and this section says where.

**Two profiles, one fence.** Both deny the same roots; the sandbox profile adds the OS sandbox.

|                                                                         | Light (the default)              | Sandbox (`lead init --sandbox`)                        |
| ----------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| Deny rules (below)                                                      | yes                              | yes                                                    |
| OS sandbox (Seatbelt)                                                   | no                               | yes, locked                                            |
| Bash `cat`, `head`, `tail`, `sed`, `tee`, redirections on a denied path | refused                          | refused                                                |
| Bash `sqlite3`, `python`, `grep -r` on a denied path                    | **not stopped**                  | refused by the kernel                                  |
| Network                                                                 | open                             | through the sandbox proxy, empty allowlist (see below) |
| `git push`, `gh`, tmux suites, the desktop test suite                   | work                             | several do not (list below)                            |
| `SendMessage` to the builders                                           | allowed                          | denied                                                 |
| `Monitor`, `Tmux`, `PowerShell`, `ListAgents`, `RemoteTrigger`          | denied                           | denied                                                 |
| Cache variables                                                         | not written (shared caches work) | written, into `<lead>/.cache/`                         |

`lead init` is light unless you pass `--sandbox`. A re-run keeps the profile the folder has (a folder made before profiles
existed is a sandbox lead) and never weakens: it changes the profile only when you pass `--sandbox` or `--light`, and says so.
Going to light removes the sandbox keys, the `SendMessage` deny and the cache variables it wrote, and nothing else of yours.

**The roots,** kept in the `protect` list of the lead's `.talos-lead` marker. Read, Grep and Glob are denied for each, and so
are Edit, Write and NotebookEdit, as `Read(//<root>/**)` and `Read(//<root>)`, in the spelling given and in lower case:

1. the main agent folder (whole tree);
2. the whole Claude config folder, `CLAUDE_CONFIG_DIR` if set, else `~/.claude` (read once in `lead/cli.ts`, kept in the
   marker as `claude_dir`; a relative or `~` value is an error), always `~/.claude` too, and `~/.claude.json` and its backup;
3. the Talos app home (whole tree: `media/`, `shared-inbox/`, config, keys, databases), with no exceptions;
4. `~/private-agent-vault/` (the kit's default vault);
5. the credential folders `~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.npmrc` and `~/.netrc` (a lead has no use for them, and
   with the network open a read key can be sent out);
6. any folder given with `--protect <dir>` (kept on a re-run).

A root, the Claude folder or the lead folder with `* ? [ ] { }` in its path is refused at init (Claude Code reads it as a
glob). The lead's own `.claude/**` and marker are closed to its Edit and Write. Shell start-up files, launch agents,
`~/.gitconfig`, `~/.bunfig.toml`, the bin folders and every folder on `PATH` when `lead init` ran are closed to Edit, Write and
NotebookEdit (`LEAD_AUTOSTART_FILES`/`LEAD_AUTOSTART_FOLDERS`, best effort). The deny rules are Claude Code's, and they hold
under `--dangerously-skip-permissions`. They stop the file tools and the Bash commands Claude Code can read a path out of;
they do not stop a program that opens the file itself (`sqlite3`, `python`, `node`, `grep -r`). Only the sandbox does that.

**The inbox.** A file the owner sends to a dedicated thread is copied by the bridge, as it routes the message, from `media/`
(one flat folder for every thread, inside the Talos home) to `~/.talos-inbox/<thread>/` (`apps/bridge/src/worker/inbox.ts`; the
root is `TALOS_INBOX_ROOT` when set, which every test sets), and the path `read_inbound` returns is the copy. It lives outside the
Talos home on purpose, so the home deny can stay whole: there is no deny on the inbox and no carve-out (a `!` pattern in a deny
list is read relative to the current folder and cannot reopen a folder that is blocked as a whole). **That means every other
thread session can read every thread's inbox:** the light fence denies roots, and the inbox is not one; Bash and the file tools
open it like any folder of yours. It holds only the files you sent, and only for a week (below); if that matters for a file,
send it to a thread whose session you trust with it.
The root and the thread folder are 0700 and the files 0600. The root, `<thread>` and every write are checked with `lstat`; a
link there is refused (the message then goes to main whole, with its files where they were), and the folder's device and inode are
looked at again right before each write, rename and unlink, so a folder swapped for a link in between is refused too (the
remaining window is the few instructions between that look and the system call). The source must be a regular file inside
`media/`, opened by a handle that refuses a link. A message that names files past the tenth says they were left out; it never
names their `media/` path. Clean-up: copies older than 7 days are removed, and the oldest first once a thread's inbox passes 1 GiB
(`pruneInbox`, run with the bridge's other retention and after each copy); a thread's whole folder is removed when the thread is
archived (the agent's `archive_thread` or the owner's `config.patch`) or deleted, and the retention pass removes the folder of
any thread that is gone. A shared thread has no inbox. A lead can `attach` a file from its own inbox, never from another
thread's (decided after the real path is resolved); `attach` still refuses anything inside the Talos home.

**What a thread can call.** The tool lock is `WORKER_THREAD_LOCKED_TOOLS` plus the env and wrapper in `tools/index.ts`
(`workerRefusal`): `reply`, `attach`, `card`, `set_status`, `schedule_propose`, `handoff` and `read_thread` name the thread's own id or
are refused (a missing id too); `card` and `card_result` act only on cards this session raised; `list_threads` lists the
own thread only; `read_inbound` returns this thread's messages only; the schedule tools go to the main bridge over the hub socket,
which scopes them to the thread it proved. `test/worker-tool-lock.test.ts` names every worker tool and how it is held, and
fails when a worker-visible tool is not in its table. The CLI is an allow list: a thread session (`TALOS_APP_WORKER_THREAD` or
`TALOS_SESSION_ROLE=worker` set, or a `.talos-lead` marker in the current folder or any parent) may run only `hook`, `guard-hook`,
`commands`, `subagent-tee`, `lead check`, `codex check` and the usage text; every other command is refused, `restore-last-good`,
`rollback`, `install-*`, `start` and `update` included, and so is a command added later. The refusal runs in `cli.ts` before
the early dispatches (`hook`, `subagent-tee`, `rollback`, `restore-last-good`) and covers `talos` and `talos doctor --json`.
`worker/cli-refusal.ts` holds the list, and a test walks every entry of `COMMANDS`. This is a fence against accidents: a
session is only known by its variables or by a `.talos-lead` marker in the folder it runs from, so `cd /tmp && env -u
TALOS_SESSION_ROLE -u TALOS_APP_WORKER_THREAD talos-app logs` is not refused. The real protection of the Talos home is the deny
on it.

**MCP servers: one allow list.** `session_opts.mcp_allow` is a list of server names as Claude Code knows them (`github`,
`plugin:zoom:zoom-mcp`), up to 32, each up to 80 characters, no commas, no repeats, no control, bidi or zero-width characters.
**No list is today's behaviour** (the session gets whatever Claude Code gives it). **A list, even an empty one, means only
those**, plus `talos-app`, which a thread always has and which need not be named. A value that cannot be read (a list of the
wrong shape, or a `session_opts` that is not an object) is read as the empty list, never as no list. The sheet has a "Limit MCP
servers" switch and a list to edit; `lead init --mcp a,b` writes the list (`--mcp ""` clears it; an empty one without `--mcp`,
so a new lead gets `talos-app` only, as before) and keeps it on a re-run. It replaces the old `--disable-mcp` flag.
A patch merges `session_opts` one key at a time (`resolveThreadsPatch`): a key the client leaves out keeps its value, and `null`
clears it. That is how an older web, iOS or bridge build that does not know `mcp_allow` can rename or reorder a thread without
wiping the list, and why the sheet sends `mcp_allow: null` (and `cwd: null`, `effort: null`) to turn a setting off. An older
client can no longer clear the folder or the effort by leaving the key out.
**The Mac app applies the list at launch.** With no list the session starts as before (nothing is applied). With a list, even an
empty one, the Mac starts the session with `--strict-mcp-config` and a generated `workers/<thread>/mcp/mcp.json` (0600, in a 0700
folder, written whole and atomically, never through a link) that holds `talos-app`, always, and the definition of each listed server,
copied from where the owner defined it, with what a worker must never get (`TELEGRAM_*`, `IMESSAGE_*` and the bridge variables in a
server's `env`) taken out: user scope or the thread folder's local scope in `~/.claude.json`, the thread folder's `.mcp.json`, or an
enabled plugin's install folder (`plugin:<plugin>:<server>`). Where a name is defined twice, local wins over user over project, so a
`.mcp.json` a folder ships never shadows a definition the owner made. **A server of the thread's own folder is allowed** when it is
local scope (only the owner writes `~/.claude.json`), or from the folder's `.mcp.json` **only if the owner approved it for that folder**
(`enabledMcpjsonServers`, or `enableAllProjectMcpServers`, in the folder's entry of `~/.claude.json` or in the user's own
`~/.claude/settings.json`; a `disabledMcpjsonServers` entry beats both; the folder's own settings files are not read, since a cloned
repository cannot approve its own servers). An unapproved one is not launched: the worker goes `failed` on the `mcp` axis and the
thread is told how to fix it (`claude mcp add -s local <name> ...` in that folder, or approve it once in Claude Code there). Each
own-folder server a session is started with is written to the app log (`supervisor.log`) with its scope. A plugin server gets
`${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` (the thread folder) filled in and `CLAUDE_PLUGIN_ROOT` set in its environment;
one that uses `${CLAUDE_PLUGIN_DATA}` is left out, because the app cannot name that folder. A channel plugin (`plugin:telegram:...`,
`plugin:imessage:...`), a connector, or a browser server on a list is left out and the thread is told. Every installed plugin whose
servers are not on the list is switched off for the session (`enabledPlugins`). A listed server that exists nowhere is skipped, and
the thread is told once which ones (`These MCP servers on this thread's list were not found, so
the session started without them: ...`). No value from a definition (an `env` secret, a header) is ever printed, logged or sent in a
notice. The same launch also sets `disableClaudeAiConnectors: true` in the worker's `--settings` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`
in its environment, passes `--no-chrome`, puts `claude-in-chrome` and `computer-use` in `deniedMcpServers`, and denies `mcp__<server>__*`
for every server that exists for main or for the thread folder but is not on the list (and `mcp__claude_ai_*`), as defence in depth.
**A claude.ai connector cannot be on any thread's list now:** the connector switches hold from every settings scope, so nothing in the
launch can turn one back on (`lead init --mcp` refuses one, and `lead check` flags one added in the app); `claude-in-chrome` and
`computer-use` are dropped from a list the same way. `lead init` no longer turns the list into denies: a re-run takes out the denies an
earlier version wrote for it only when the owner asks: `lead check` lists the probable ones (the connector, plugin and per-server
`mcp__...` rules and their `disabledMcpjsonServers` names, worked out from the owner's `~/.claude.json`), because an owner's own rule can
look the same (`mcp__playwright__*`), and `lead init <thread> --remove-stopgap` removes the ones that are there and records them in the
marker (`stopgap_removed`). Nothing is removed without the flag. The browser and screen denies and `disableClaudeAiConnectors` stay.
_What cannot be turned off per session:_ servers a managed (organisation) settings file forces on, force-enabled plugins, and the
Claude desktop app's own local and SSH connectors. _Not verified against Claude Code's own code:_ the layout of
`~/.claude/plugins/installed_plugins.json` (a list of installs per plugin, or one object, both read) and of a plugin's `.mcp.json` and
`.claude-plugin/plugin.json`; where `enabledMcpjsonServers` lives (the docs say settings files; the folder's entry in `~/.claude.json`
is read as well); and the location of `${CLAUDE_PLUGIN_DATA}`. _What the documentation does not settle:_ whether `--strict-mcp-config` also drops
plugin servers and the connectors Claude Code fetches itself (hence the explicit switches above and the plugin servers copied into the
file), and whether `mcp__<x>__*` in a deny list stops the server from connecting at all (hence `deniedMcpServers` for the two that matter).

**The Talos home deny on every dedicated worker.** The `--settings` file the Mac writes for a thread session carries `Read`, `Grep`,
`Glob`, `Edit`, `Write` and `NotebookEdit` denies on the whole Talos home (`//<home>/**` and `//<home>`, in the spelling given and in
lower case: the lead fence's spelling), with no exception and no `!` rule. It is added after the optional guards' settings are merged
in, as a union: the guards' file replaces `permissions` and `hooks` wholesale, and the fence is never lost to it. The "Open claude here"
session in the Terminals window gets the same fence, and is not offered without a Talos home to fence. The home is fenced in the
spelling given, in lower case, and where it really is (a symbolic link in the path), and a home with `( ) * ? [ ] { }` in it is refused. A spec whose settings lack the
fence is refused before it runs (`validate`). **What it does not stop:** a worker's Bash can still read the home with `sqlite3`,
`python` or `grep -r`, because only a sandbox stops a program that opens the file itself, and a non-lead worker has none. Leads keep
their sandbox (or, in the light profile, the same honest limit).

**A live change.** On each tick the Mac compares what a running session was started with (`WorkerEntry.launched`: `cwd`, `model`,
`effort`, `mcp_allow`, written at every start) with the config. If they differ and the difference has stood for 30 seconds (two edits
in a row are one restart, with the final config; an edit put back restarts nothing), the session is restarted the way Restart is: it
goes through `stopping`, so a turn in progress is never cut, however long it runs (a saved setting does not arm the 15-minute limit a tap
on Restart has). A new **folder** starts a
fresh conversation (the old id moves to `previous_ids`) and the thread is told `Started a new conversation in <folder>.` once; a new
model, effort or MCP list resumes the same conversation. An entry with no `launched` (written by an older build) is never restarted;
the next start records it. The sheet says "Saving restarts the session when its current turn ends."

**The privilege ceiling at launch.** A thread session never starts wider than the main session, on three axes, checked on the finished
spec and refused one by one: the permission mode (bypass is wider than the default, which is wider than plan; main's is its own launch
flag, the worker's is its command line, else `permissions.defaultMode` in its settings). Main's REAL mode is worked out from its launch
arguments (`--dangerously-skip-permissions`, `--permission-mode X`) and, when they name none, from the settings it reads (the guards'
file, the agent folder's local and shared settings, the user's; `auto` and `bypassPermissions` do not take effect in the project files),
and it is written into the worker's `--settings` as `permissions.defaultMode`, which outranks the thread folder's own settings: a folder
asking for `acceptEdits` cannot widen the session. When main runs in the built-in default, which the app cannot read, nothing is written
and nothing is invented, the MCP servers (every listed server must be one
main can use itself: defined in user scope, in the agent folder or by an enabled plugin; a server defined only in the thread folder is
refused), and the deny rules (the worker's must include every one main has: the guards' file and the agent folder's project settings,
which the build copies into the worker's settings, each made absolute where it was defined: the kit's `Read(./.env)` stays the AGENT
folder's `.env`, and does not become a deny on the worker's own). A refused spec is not launched: the worker goes `failed` with the error code
`mode_escalation_denied` and `error.axis` `permission_mode`, `mcp` or `deny_rules`, a plain sentence in `error.detail`, and the thread is
told once. Messages go to the main session meanwhile, as for any failed worker; saving a narrower setting and pressing Restart tries again.

**What the sandbox profile can't do.** Under `--sandbox` a lead cannot: use git over SSH (push over https), run `gh` (Go TLS
fails under Seatbelt), run tmux integration suites (sockets in `/tmp/tmux-501`), run `xcodebuild`, the iOS Simulator or GUI
tests (`~/Library/Developer`, Mach lookups), install to `~/Applications`, run `ci-local.sh` (`~/.cache/talos-ci`), or `git clone` /
`remote set-url` / `push -u` when a nested `.git/config` is write-protected (clone in Terminal after init). It is denied
`SendMessage`, so a sandboxed Talos lead cannot reach the builders; main fetches the lead's branch by path and reviews it, and
never runs the lead's tree outside the sandbox.

**Network.** Light: open. Sandbox: Claude Code starts a proxy with an empty allowlist. Whether a request then goes out depends
on the permission mode, not on a setting here: under `--dangerously-skip-permissions` nothing asks, so it just works ("no setting
needed" is true only there); in the default mode Claude Code asks; in `dontAsk` it refuses. A strict allowlist cannot come from
project settings.

**What the fence is, and is not.** Light stops accidents, not a determined process: a lead that runs `sqlite3` on the history
database, or a script that opens a denied file, is not stopped, and with the network open it could send what it read. The
sandbox profile closes the file side at the kernel and still sends whatever it legitimately has. Neither stops: hooks (the kit
writes them, the lead cannot edit them, they run outside the sandbox); the owner's user settings or `--settings` files, which
can weaken it (`lead check` reports the known keys); a lead reading what the Mac user can read outside the roots. A lead's
search is not held to its own thread (no agent tool searches history today). Run `talos-app lead check` after a Claude Code update.

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

## Needs-you prompts

A thread session's Claude Code pane can stop on a dialog only the owner may answer. For three known dialogs the owner now
answers with a tap, on the iPhone, the web app or the Mac app, instead of in Terminals. **In scope:** folder trust (`trust`), MCP
server consent (`mcp_consent`) and login (`login`). **Not in scope:** the bypass-permissions disclaimer and any dialog Talos does not
recognise; they keep the thread line "…is waiting on a '<prompt>' prompt; open Terminals → <name> on the Mac to answer." There is no
Face ID or step-up: the tap is the approval. The first answer wins; every other face shows "Answered on <device>".

### The flow

1. The desktop supervisor reads the pane. A known dialog goes into `workers.json` as `threads.<id>.dialog` (below). It is there
   while the dialog is on the pane. A new dialog, or the same one back after it went away, has a new `id`: **at least 128 bits of
   randomness made by the Mac** (22 or more characters of base64url, or 32 hex), so no one can name a dialog before it is on the pane.
2. The live bridge reads `workers.json` on every poll (and the moment it changes: it watches the folder). A `dialog` whose `id` it
   has not seen, from a fresh supervisor, in a known thread, with the relay listing `needs-you/1`, becomes **one** `kind:'dialog'`
   card (`card.create`, 15 minutes from the Mac's first sighting at most). The bridge then writes `dialog-card.json` for the Mac. The
   record of the `id` is in history.sqlite, so a restart never makes a second card.
3. The owner taps. `card.resolve` carries `choice` (the option's index; none for login). The bridge checks the dialog is not
   shown to be a different one by a fresh `workers.json` and the index is one of the card's, records the answer in the ledger (first
   wins: the loser gets `card_not_pending`), marks the dialog "answering", and writes `dialog-answer.json` with the owner's signed
   tap as its **proof**. The card shows "Pressing…".
4. The Mac checks the proof (steps below) and presses the key only if all of it holds, then writes `dialog-result.json`. `pressed`
   ends the card done ("Trusted ~/Documents/x"; the answered card reads "Answered on <device> · <time> · the session is
   starting"). `nothing_pressed` ends it failed and says why: the screen changed ("Nothing pressed"), the popup or an earlier
   answer got there first ("Already answered at the Mac first."), or the Mac could not check the answer ("Answer on the Mac").
   `opened` ends the login card done ("Opened on the Mac"). A report that says it pressed something other than what was answered,
   or that is old, from the future, or for another answer, claims nothing. If no report comes within 60 seconds
   (`DIALOG_RESULT_WAIT_MS`) the card ends failed with `ran: 'unknown'` and the bridge **deletes the answer file**, so a late Mac
   finds nothing to press.
5. If the owner presses a button on the **Mac popup** instead, the Mac presses it itself and writes a `source: 'mac'` result. There
   is no claim and no round trip: the Mac arbitrates locally, once per dialog id, for whichever comes first, a verified answer or
   its own click. A later phone answer gets `nothing_pressed` with reason `already_answered`. The bridge shows a `source: 'mac'`
   result as "Answered on this Mac", **display only, and only once a fresh `workers.json` shows the dialog gone** (so the Mac writes
   the result before it drops the dialog from `workers.json`).
6. If the dialog goes away before anyone answers, the card is closed ("The session isn't waiting on this any more", state
   `superseded`) and nothing is pressed. If an answer was taken the card waits for the report instead: the dialog going away is
   the key press. A `workers.json` that cannot be read, or that is old, never closes a card.
7. If nobody answers in 15 minutes the card expires and the bridge posts the thread line the Mac used to post
   (`dialogFallbackLine`): **at most one per dialog** (the record is marked before the post, and a post that fails is logged, not
   retried). The worker is never stopped. The bridge tells Claude nothing about any of this: the card is bridge-handled.

The card's text is `composeDialogCard` (`packages/protocol/src/dialog-card.ts`), and its heading and one-line explanation per kind are the
shared table `DIALOG_WORDING`, which the Mac popup says too. Buttons are the dialog's options **as read from the
screen, in screen order, none dropped or edited** (three for MCP consent, including "Use this and all future MCP servers in this
project"); login has one button, "Open on the Mac", which brings Terminals forward and types nothing. The options are in the bound
payload, so `payload_hash` covers every button, the folder or server, the thread and the dialog id. Text from the screen is plain
text with every hidden character shown as `⟦U+XXXX⟧` and the bracket characters marked too, so a label cannot print a marker of its
own (`dialogVisibleText`, used by the bridge's sentences and the app alike). A subject the Mac could not read exactly is `null`
and the card shows none.

### Why an answer must prove itself

Every agent session runs as the same user and can write `$TALOS_APP_HOME`. The guards are optional and only match text. So no
file is believed about WHO answered. The answer file carries the owner's own signature on the tap, and the Mac verifies it.
Forged results, card files and `workers.json` only change what a card says (or hide the Mac's fallback line); they cannot press
a key. See `docs/SECURITY.md`.

### Files

All under `$TALOS_APP_HOME`, mode 0600, written atomically (temporary file, then rename). The ones in a thread's folder are
`workers/<thread>/…`. Schemas and caps are in `packages/protocol/src/dialog-files.ts`; the names are in `WORKER_FILES`.
Every reader treats them as untrusted: a regular file, **no link followed (`O_NOFOLLOW`)**, and for the bridge also no link in
`workers/` or `workers/<thread>/` (lstat), **at most 4096 bytes (16 KiB for the answer, which carries the signed frame and the
card's binding)**, strict fields, `control_id` of `[A-Za-z0-9_-]{1,64}` acted on **at most once**.

| File (writer → reader)                              | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers.json` `threads.<id>.dialog` (Mac → bridge) | `{ id, kind: trust\|mcp_consent\|login, subject: string\|null, options: string[], cursor: int\|null, seen_at, expires_at }`. `expires_at` = `seen_at` + 900 s. `options`: 1 to 6 labels of at most 120 characters (none for login); `subject` at most 500. Anything that does not fit reads as "no dialog" and the rest of the file stays valid                                                                                                                                                                                                                                                                                                                                                                                       |
| `dialog-card.json` (bridge → Mac)                   | `{ v:1, dialog_id, card_id, thread_id, status: waiting\|answered\|closed\|expired, by?, label?, at }`. Written when the card is made and rewritten when it changes. **The Mac posts its old thread line only when no such file naming this dialog appears within 15 s of first seeing it** (`DIALOG_CARD_WAIT_MS`: one whole 10 s poll plus the write; the bridge normally makes the card within a second of `workers.json` changing). An old bridge, a relay without `needs-you/1` or a bridge that is down never writes it, so those get today's behaviour. While a file for the dialog exists the Mac posts no line for it; the bridge posts the expiry line. **Display only**: a forged one can only hide the Mac's fallback line |
| `dialog-answer.json` (bridge → Mac)                 | `{ v:2, dialog_id, choice\|action:'open', label, by, at, control_id, proof }`, strict, at most 16 KiB. `choice`, `action`, `label` and `by` are for display and logging only. `proof = { signed, osig, device_id, binding }`: see "How the Mac verifies an answer". The Mac acts once per `dialog_id`, deletes the file, and always writes `dialog-result.json`                                                                                                                                                                                                                                                                                                                                                                       |
| `dialog-result.json` (Mac → bridge)                 | strict: `{ v:1, dialog_id, control_id?, source: card\|mac, outcome: pressed\|nothing_pressed\|opened, choice?, label?, reason?, at }`. `source:'card'` answers one bridge answer (`control_id` required; `pressed` carries `choice` and the `label` the screen showed; `nothing_pressed` carries `reason`: `screen_changed`, `already_answered` or `unverified`). `source:'mac'` is a popup press (no `control_id`; `pressed` or `opened`). The bridge deletes the file once used                                                                                                                                                                                                                                                     |

The bridge looks at the result file every second while a dialog card is open (and at every 10 s poll).
There is **no`dialog-claim.json`**: the Mac popup presses by itself and reports with a `source:'mac'` result.

### The proof, exactly

`proof.signed` is the exact text the owner's device signed: `jcs(frame without osig, relay, stepup_token)`, the RFC 8785 canonical
JSON of the `card.resolve` frame as received (`ownerSignedString`, built from the raw frame, never from a parsed copy).
`proof.osig` and `proof.device_id` are that frame's. `proof.binding` is `jcs(card binding)`, the text `payload_hash` commits to
(`"sha256:" + sha256Hex(binding) == payload_hash`). The binding contains the card id, `thread_id`, and the payload
`{ dialog_id, thread, dialog_kind, subject, options, expires_at }`.

### How the Mac verifies an answer

Every step must pass, in this order. On a failure the Mac presses **nothing** and writes `dialog-result.json` with
`nothing_pressed`: reason `unverified` for steps 1 to 4, `screen_changed` or `already_answered` for step 5.

1. `proof.device_id` is a **device paired and not revoked in `devices.json`** (an entry with that `id`, a `pubkey_jwk` and no
   `revoked_at`), and its P-256 public key `K` satisfies `deviceIdFromSpki(K) == proof.device_id`, where `deviceIdFromSpki(spki)` is
   `"d_"` + the first 20 characters of the lowercase RFC 4648 base32 (no padding) of SHA-256(`spki`), `spki` being the DER
   SubjectPublicKeyInfo of `K`. The lookup is one function, `pinnedKey(device_id) -> K | nil`, so where the keys come from can
   change in one place. `devices.json` is writable by any program running as the same user; the existing tripwire is what is
   meant to catch a device added that way (see `docs/SECURITY.md`). A Mac whose `devices.json` is missing, unreadable or has no
   such device passes nothing here: the card says "Answer on the Mac".
2. The owner signature checks. `proof.osig` is base64url (no padding) of 64 raw bytes (IEEE P1363 `r || s`, not DER): an ECDSA
   P-256 / SHA-256 signature by `K` over the UTF-8 bytes of

   `"talos-owner/v1" + "\n" + proof.device_id + "\n" + sha256Hex(proof.signed)`

   where `sha256Hex` is the lowercase hex of SHA-256 over the UTF-8 bytes of `proof.signed` exactly as stored (do not parse and
   re-serialize it). The domain string is `OWNER_SIG_DOMAIN` in `packages/protocol/src/owner-sig.ts`, whose header reads
   `signing input = "talos-owner/v1\n" + device_id + "\n" + sha256Hex(jcs(frame without osig, relay, stepup_token))`.
3. Parse `proof.signed`. It is an object with `type == "card.resolve"`, `action == "primary"`, **no** `edited` key, `device_id ==
   proof.device_id`, and a `choice` that is an integer 0 to 5 (absent only for a login dialog, which is answered with
   `action:'open'`). Its `ts` is no more than 15 minutes before the Mac's clock and no more than 2 minutes after it.
4. `"sha256:" + sha256Hex(proof.binding) == signed.payload_hash`. Parse `proof.binding`: `kind == "dialog"`, `id == signed.card_id`,
   `thread_id` is THIS worker's thread, `payload.thread` is this thread, `payload.dialog_id` is the id of the dialog on the pane
   now, and `payload.dialog_kind`, `payload.subject` and `payload.options` are **exactly equal** (same strings, same order, same
   count; `subject` null equals null) to the Mac's **own in-memory record** of that sighting, the one it wrote to `workers.json`.
5. `payload.options[signed.choice]` equals, character for character, the label the screen shows **now** at that place, and the Mac
   has not pressed anything for this `dialog_id` before (a popup click or an earlier answer counts). Then it presses at most
   once per `dialog_id`. For login nothing is typed: the Mac brings Terminals forward.

The Mac presses from `signed.choice`, never from the display fields at the top of the file. The reference check in TypeScript is
`verifyDialogAnswer` (`packages/protocol/src/dialog-proof.ts`); the bridge runs it on its own answer before it writes the file.

### Fixtures for the Mac side

`packages/protocol/fixtures/needs-you/`, all checked by `packages/protocol/test/dialog-proof.test.ts` with now =
`2026-11-07T10:00:30Z`. Signed with the committed test device key (`fixtures/test-device-key.json`, device `d_rjxnk4xufxem5xago5zd`,
paired in `pinned-devices.json`, the `devices.json` entries the check sees; `device-b.json` is a second device that is not paired). The pane records the Mac compares with:
`pane-trip.json` (thread `trip`) and `pane-login.json` (thread `inbox2`). Regenerate with
`UPDATE_NEEDS_YOU_FIXTURES=1 npx vitest run packages/protocol/test/dialog-proof.test.ts` (new random signatures each time).

| Fixture                                    | Pane  | A correct Mac                                                                     |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------- |
| `dialog-answer.json`                       | trip  | presses option 1                                                                  |
| `dialog-answer-open.json`                  | login | opens Terminals                                                                   |
| `dialog-answer-display-differs.json`       | trip  | presses option **1** (signed), though the top says 0                              |
| `dialog-answer-missing-proof.json`         | trip  | nothing (unverified, step 0)                                                      |
| `dialog-answer-wrong-device.json`          | trip  | nothing (step 1: a valid signature by an unpaired device)                         |
| `dialog-answer-bad-signature.json`         | trip  | nothing (step 2)                                                                  |
| `dialog-answer-wrong-choice.json`          | trip  | nothing (step 2: the signed text was edited)                                      |
| `dialog-answer-old-ts.json`                | trip  | nothing (step 3: an hour old)                                                     |
| `dialog-answer-kill.json`                  | trip  | nothing (step 3: signed `kill`)                                                   |
| `dialog-answer-edited.json`                | trip  | nothing (step 3: signed with `edited`)                                            |
| `dialog-answer-signed-device-differs.json` | trip  | nothing (step 3: the signed frame names another device)                           |
| `dialog-answer-changed-binding.json`       | trip  | nothing (step 4: the binding's folder was edited)                                 |
| `dialog-answer-changed-binding-title.json` | trip  | nothing (step 4: only the card's wording was edited, so only the hash catches it) |
| `dialog-answer-subject-differs.json`       | trip  | nothing (step 4: really signed, but for a card with another folder)               |
| `dialog-answer-wrong-thread.json`          | trip  | nothing (step 4: a real card of the `garden` thread)                              |
| `dialog-answer-wrong-card-thread.json`     | trip  | nothing (step 4: `thread_id` of the binding is wrong, the payload's is right)     |
| `dialog-answer-wrong-payload-thread.json`  | trip  | nothing (step 4: the payload's thread is wrong, the binding's is right)           |
| `dialog-answer-other-card-id.json`         | trip  | nothing (step 4: the signed frame names another card than the binding)            |
| `dialog-answer-other-dialog.json`          | trip  | nothing (step 4: a real card for another dialog id)                               |

The other files: `workers-with-dialog.json`, `dialog-card.json`, `dialog-card-answered.json`, and `dialog-result*.json` (pressed,
opened, nothing pressed with each reason, and a popup press).

### Compatibility and version skew

- **`card.resolve` gains an optional `choice` (integer 0 to 5).** An older app never sends it, so every older frame parses and
  verifies as before (the signature covers all fields except `osig`, `relay` and `stepup_token`, so `choice` is signed). The frame is
  still strict. An older bridge would refuse a frame with `choice` (`bad_frame`), but it never makes a dialog card, so no app has
  one to answer. A choice outside 0 to 5 is refused by the relay.
- **`resolution.by`** (device label, at most 60 characters) is optional on `card.update`; an older reader drops it, and a value that
  does not fit reads as none.
- **The `dialog` card kind** is refused by a relay that does not know it. The relay lists `needs-you/1` in `ready.features`
  (it ships the web build that draws the card), and **the bridge makes no card until `ready` lists it**. Deploy the relay first. Until
  then nothing changes: the Mac keeps posting its thread line.
- An app build from before this does not know the kind and drops the card (strict parsing). It ships with the relay, so it is the
  same build.
- `NATIVE_APPROVABLE_KINDS` does not include `dialog`: a notification opens the app, and a notification Approve of a dialog card is
  refused by the relay and the bridge.

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
