# Option C: a dedicated Claude Code session per thread (opt-in)

Status: being built in work packages. This page grows with each one. Every thread starts on `shared`: with a thread left
on `shared`, or the master switch off, Talos behaves exactly as before (the main session answers every thread, option B in
[CLAUDE-CODE.md](CLAUDE-CODE.md) C8).

**Allowed by default (2026-11-19).** The master switch (`dedicated.enabled`) shows **on** for a config that never wrote it
(every new install), so each ordinary thread's settings offer **Own session**, off, under its cost note
(`threadSessionsAllowed`). Routing, and the Mac app, still read a missing switch as off; the first thread turned on writes
it on (`writeSwitchOnFirstUse`: the bridge's `config.patch` and `update`, and the app's own patch for a Mac with an older
bridge), and any thread already `dedicated` that the change does not name goes back to `shared`, since it never ran and was
shown off. An explicit `enabled: false` stays off. The agent's settings row reads what runs (off until written).

## The idea

- A thread can be switched to **Own session** (`Thread.session: 'dedicated'`). It then gets a **worker**: an ordinary
  interactive `claude` running in tmux under the desktop app (`tmux -L talos`, session `t-<thread_id>`, `--name
  talos-<thread_id>`). The supervisor starts it on the thread's first message, parks it after 30 minutes idle, and resumes
  it by session id on the next message. Never `claude -p`, never `--bg`.
- Workers load **no channels** and no development-channel flag. Main's live bridge stays the only relay socket. A worker's `talos-app` MCP server runs in **worker mode**: no relay socket, no pid takeover; it sends its frames through main's bridge over a local socket (`$TALOS_APP_HOME/hub.sock`).
- Inbound: main's bridge (the hub) keeps the verified message, writes a wake file with message ids only, and the
  supervisor types one fixed line into the worker (`Talos: new message in this thread. Call read_inbound.`). The worker
  fetches the message with `read_inbound`. A message nobody claims within 10 minutes (3 minutes when the session had to be started for it; a
  thread with no session at all goes to main at once) is answered by main, with a system row saying so. Never both.

## Data (WP-OC0, `packages/protocol/src/thread-sessions.ts`)

| Field                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Thread.session`        | `shared` (absent = shared) or `dedicated`                                                                                                                                                                                                                                                                                                                                                                         |
| `Thread.session_opts`   | `cwd` (absolute, default the agent folder), `model` (`inherit` or an alias, set with `--model` at launch, never `/model`), `effort`, `idle_park_min` (5-720, default 30), `mcp_allow` (optional list of MCP server names, see "Leads and the fence"), `ops_read` (optional boolean, Mac only, see "Reading the problem folder from a thread"). A `worktree` key from an older config is ignored (removed 2026-11) |
| `AgentConfig.dedicated` | `enabled` (default **false**), `max_live` (1-6, default 3), `governor` {`five_hour` 80, `weekly` 85, `park_all` 95, `off` false}                                                                                                                                                                                                                                                                                  |
| `SessionState.scope`    | `main` (absent) or `{thread_id}`: which session a `session.state` describes                                                                                                                                                                                                                                                                                                                                       |
| `SessionKind`           | gains `thread` for the Sessions view                                                                                                                                                                                                                                                                                                                                                                              |
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
  The agent switches a thread's session with a `config_propose` card (`threads.<id>.session`, always a card, even in trust mode,
  docs/bridge.md); a thread session may propose that for its own thread only, through the hub (`rpc config_propose`).
- The Mac checks a thread folder before saving it: absolute, no `.`/`..`, under `$HOME`, an existing directory, and not
  inside `~/.claude` or `$TALOS_APP_HOME`, checked again after resolving symlinks (`apps/bridge/src/worker/patch-check.ts`).
  This runs only when the folder changes, so the supervisor (WP-OC3) re-runs the same check before every start: the
  folder could be swapped for a symlink later.

### Frames

| Frame                                                                                  | Direction                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread.session.control {control_id, thread_id, action: park\|resume\|restart\|fresh}` | app → relay → bridge, signed | like `session.control`: durable until its result is recorded; answered with `session.control.result` under the same `control_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workers.status {status}`                                                              | bridge → relay → app         | `supported`, `supervisor_online`, per-thread `state`/`model`/`cwd`/`last_turn_at`/`parked_at`/`error` (+`error_at`), and for the app's status line `needs_you {kind, since, step?, resets_at?}` (kind: a known prompt name from `WORKER_NEEDS_YOU_KINDS`, else "a prompt"; `step` from `needsYouStep`), `stopped_why`, `started_at`, `turn_started_at`, `restarts_1h`; never `error.detail`. Governor state. `main_needs_you`: Main's own wait from `main-restart-check.json` while it is fresh, the same shape. Not durable; the relay keeps the last one for `ready.workers_status` |

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

| File                                                | Writer                                                 | Schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$TALOS_APP_HOME/workers.json`                      | supervisor only (atomic, 0600, heartbeat every 5 s)    | `WorkersFile`; a torn or unknown-version file parses to `null` and the hub treats the supervisor as down; one entry's failure code that this build does not know reads as `unknown` for that entry and never costs the file. Optional per entry: `needs_you {kind, since}`, `stopped_why`, `turn_started_at` (below, "Main controls a thread's session"), `pointer_hold {reason, since}` (below, "Why a message waits"); a value that does not fit is none for that entry |
| `$TALOS_APP_HOME/workers/<thread>/wake`             | hub                                                    | `WakeFile`: message ids only, never content                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `$TALOS_APP_HOME/workers/<thread>/nonce`            | supervisor, before each start (0600)                   | the same value goes in the worker's env as `TALOS_APP_WORKER_NONCE`; the hub refuses a `hello` without it                                                                                                                                                                                                                                                                                                                                                                 |
| `$TALOS_APP_HOME/workers/<thread>/ready`            | hub, on a good `hello`                                 | `WorkerReady`; the supervisor's start is done when it appears                                                                                                                                                                                                                                                                                                                                                                                                             |
| `~/.talos-inbox/<thread>/` (outside the Talos home) | hub (0600 files in 0700 folders, never through a link) | the owner's files for that thread, copied from `media/` as the message is routed; `read_inbound` returns these paths; removed after 7 days or past 1 GiB, and with the thread                                                                                                                                                                                                                                                                                             |
| `hub.sock` lines                                    | both                                                   | `HubWorkerLine` (`hello`, `out`, `mod`, `rpc`), `HubHubLine` (`welcome`, `ack`, `refused`, `controls`, `rpc_result`); `mod` and `controls` are P1 (WP-OC5); `rpc` carries the four Schedules tools ("Thread schedules")                                                                                                                                                                                                                                                   |

Fixtures for all three: `packages/protocol/fixtures/option-c/`. Shared constants: `WORKER_POINTER_TEXT`,
`WORKER_FORBIDDEN_ARGS` (`--channels`, `--dangerously-load-development-channels`, `-p`, `--bg`),
`WORKER_STRIPPED_ENV`, the deadlines and the backoff.

## The bridge (WP-OC1 and WP-OC2, PR #65)

| Piece            | File                                              | What                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker mode      | `src/server.ts`, `src/instructions.ts`            | `TALOS_APP_WORKER_THREAD` set: never live (exit 2 with `TALOS_APP_BRIDGE=1` or a bad id), no channel capability, no permission relay, `WORKER_INSTRUCTIONS`                                                                                                                                                                                                                                                                                         |
| Tools            | `src/tools/index.ts`, `src/tools/read-inbound.ts` | `WORKER_BRIDGE_TOOLS` only; `reply`, `attach`, `card`, `set_status` refuse any other thread and name only the worker's own; `card_result` only for its own cards                                                                                                                                                                                                                                                                                    |
| Worker transport | `src/worker/transport.ts`, `src/hub/client.ts`    | hub up: every frame goes to the hub and waits for its ack; hub down: `reply`/`card.create` over `POST /bridge/post`, nothing else                                                                                                                                                                                                                                                                                                                   |
| Hub socket       | `src/hub/server.ts`                               | live bridge only; `hello` needs a fresh `workers.json` entry, the nonce, and a pid in the recorded pane's process group (`ps -o pgid=`); `out` frames are re-parsed, size-checked and thread-checked (`reply`, `card.create`, `card.update`, `status`, `receipt` only, no permission cards), then sent and mirrored by the hub                                                                                                                      |
| Router           | `src/router/router.ts`                            | wraps the live bridge's notification emit. Owner `text`/`file` in a dedicated thread, and `card_action` on a card that thread's worker raised, are held as `worker_routes` rows and named in the wake file. A `schedule_run` for a job of that thread is held the same way (see "Thread schedules"); voice calls, hooks, digests, heartbeat wakes, shares and `backlog` stay with main                                                              |
| Claims           | `src/worker/store.ts`                             | `inbound_claims` (`INSERT OR IGNORE`): the worker's `read_inbound` or the hub's deadline, whoever is first. Deadlines are re-armed after a bridge restart                                                                                                                                                                                                                                                                                           |
| Governor         | `src/router/governor.ts`                          | from the newest reading per limit kind of any session on the Mac (main's mod, each worker's status line via `workers/<id>/usage.json`; `src/router/usage-pool.ts`), a window past its reset dropped; a reading older than 30 min, or none, = `unknown`, never blocks. Paused: parked threads fall back with `usage_governor`, live workers keep their pointers. Park-all: a `park` wake for every live worker, again 30 s later while it stays live |
| Controls         | `src/router/controls.ts`                          | `thread.session.control` → a wake with that action; the result is a `session.control.result`, stored and replayed like `session.control`                                                                                                                                                                                                                                                                                                            |
| Status           | `Bridge.optionCTick()` (every poll)               | `workers.status` when it changes, and on every `ready`                                                                                                                                                                                                                                                                                                                                                                                              |

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

| Notification         | Thread shared | Dedicated, reachable                                           | Dedicated, not reachable                    |
| -------------------- | ------------- | -------------------------------------------------------------- | ------------------------------------------- |
| owner `text`, `file` | main          | worker (wake + `read_inbound`), main after 10 min / 3 min cold | main at once, `routed=fallback`, system row |
| `card_action`        | main          | the worker that raised the card                                | main + system row                           |
| `backlog`            | main          | main (not split yet; main can pass it on)                      | main                                        |
| everything else      | main          | main                                                           | main                                        |

"Not reachable" = supervisor heartbeat stale or `workers.json` unreadable, `workers_supported` false, the worker
`failed` or `stopping`, or the governor paused and the worker not live.

## The desktop supervisor (WP-OC3)

| Piece           | File                                      | What                                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerSpec`    | `TalosDesktopCore/WorkerSpec.swift`       | argv, env and the per-worker settings file. `validate()` refuses `--channels`, the dev-channel flag, `-p`/`--print`, `--bg`, `server:`/`plugin:` words, and any `TELEGRAM_*`/`IMESSAGE_*`/`TALOS_APP_BRIDGE`/`MCP_PROTOCOL_NEGOTIATION` env (except the two empty state dirs) |
| Files and rules | `TalosDesktopCore/Workers.swift`          | `WorkersFile`, `WakeFile` (decoded from the protocol fixtures in the tests), `DedicatedSettings` (the same front-door rules as `threadSessionMode`), `WorkerPolicy` (cap, LRU, idle, crash loop), `PointerTyper`                                                              |
| `WorkerManager` | `TalosSupervisor/WorkerManager.swift`     | the 1 s tick: heartbeat `workers.json` every 5 s, take wakes (rename, then read), start / resume / park / restart / fresh, type pointers, watch for dialogs, `No session found` and crashes, park idle workers, re-adopt live ones after an app relaunch                      |
| App             | `TalosDesktop/SupervisorController.swift` | runs the manager with the tmux host only; main's TakeoverCheck whitelists the worker process groups                                                                                                                                                                           |

How a worker is launched: `tmux -L talos new-session -d -s t-<id> -c <realpath> -- /usr/bin/env -i /bin/sh
workers/<id>/launch.sh` (`LaunchFile`, the same as main). The file (0600, created new in a 0700 folder) removes itself as
its first line, then sets the WorkerSpec env with one `export NAME='value'` each and `exec`s claude with its args, every
element single-quoted. `env -i` replaces the environment wholesale, so nothing in the tmux server's global environment (a
token, `TALOS_APP_BRIDGE`) can reach a worker, and nothing is ever set on the server. `export` is a shell builtin, so no
value (the worker's nonce among them) is ever in an argv where `ps` would show it; a file rather than tmux arguments also
because tmux caps a command at about 16 KB and treats an argument ending in `;` as a separator. `-c` escapes `#`, since tmux expands it as a format: the folder checked is
the folder used. Args: the owner's permission flag, `--settings workers/<id>/settings.json` (Telegram and iMessage plugins
off, `effortLevel`, and a `statusLine` that records the session's plan-usage reading in `workers/<id>/usage.json`:
protocol `usage-readings.ts`, the Mac's `WorkerUsage.swift`), `--name talos-<id>`, `--model` unless `inherit`, `--append-system-prompt` (the agent folder's
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
  prompt, and "open this thread in Terminals on the Mac to answer". The line is a system row, read as Talos speaking, so it says
  "This thread's session" and never the thread's name (a name is something an agent's card or a hand edit can set). One line per dialog, and at most one per thread per kind of dialog in 10 minutes (kept in `workers/<id>/notice.json`, so a
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
  from when the pointer is due), puts ONE line in the thread ("This thread's session isn't showing its input box yet. Open this thread in
  Terminals to see what it's waiting on.") and shows the thread as **Needs you** in the Terminals window until it clears. The worker is
  never stopped for this and is not idle-parked while the pointer waits. When the box appears the pointer is typed as usual and the
  hold is forgotten, its record in `notice.json` deleted, so a later hold tells the thread again. A pane the owner scrolled back
  (tmux's copy mode) takes keys as commands of the mode, so nothing is typed, entered or cleared while it is in one: every send is an
  `if-shell -F '#{pane_in_mode}'` that sends only in no mode (`TmuxCommands.unlessInMode`), one tmux invocation, so a scroll cannot
  land between a check and the keys; it prints `talos-sent` after the keys went and `talos-in-mode` when it held them, and only the
  first counts as sent. That hold is told too: once the pointer's claim deadline has
  passed (the hub has given the message to main), or after `draftNoticeAfter`, ONE line per hold (a hold on a pointer already past
  its deadline keeps quiet for `noticeDebounce` after the first, so scrolling in and out does not repeat it) ("This thread's session is scrolled
  back, so Talos can't type into it; …press q to return to the prompt.") and **Needs you** ("scrolled back") until the mode is left.
  A pointer the mode held back keeps its deadline from then on, like one read back after a relaunch: out of the mode and past it, the
  **A screen Talos does not type into (the deaf-thread alarm, `WorkerDeaf.swift`, `DeafWatch`).** A thread's pane can show something
  that is not Claude's input box (a row under the box that Claude Code never draws there, no box, a box not at column 0), and then the
  key guard refuses every key: the thread's owner messages, scheduled runs and card taps reach main at the hub's deadline, with one
  quiet fallback line each. The pane is therefore read every tick for each live worker, whether or not anything wants to type (a
  thread that only gets scheduled runs is as deaf as one that gets messages). A pane that repaints (a sub-agent's row ticking) is still deaf, so a running turn does not stop the look (only a screen with no
  box is let go while one runs); a refused pointer is a look too. Not counted: a dialog or prompt that has its own card and line,
  the owner's own typing, a scrolled-back pane, the owner's draft in the box. Only time actually seen counts: looks further apart
  than 10 s are not one stretch, so a sleep or a stalled tick never passes the waits, and a clear look followed by a gap ends the run. After 60 s (`deafAfter.notice`)
  the thread gets ONE line: "The "<name>" thread has something on its screen Talos doesn't recognise, so Talos can't send it
  messages right now. If it stays that way, your main agent answers your messages." (the name is the owner's config text, quoted,
  never words of Talos's own; no place to go). After 10 min (`deafAfter.needsYou`) it is **Needs you** (`needs_you` in `workers.json`, `since` = when the refusals began, kind "something
  Talos does not type into", the same kind as before, now in `WORKER_NEEDS_YOU_KINDS`, with a `needsYouStep`): the phone's
  Needs-you item and the thread list read it from `workers.json` like any other. A screen that reads fine for under 10 s
  (`deafAfter.recover`) does not end the run. A restart, park or relaunch ends the run with its recovery said (a relaunch finds the run again from the open notice record). A thread that flaps is told once in `noticeDebounce`: its notice record is closed, not forgotten, on recovery, and a run whose notice was held back says nothing about clearing. When it clears, the flag goes by itself and the thread gets one line: "Talos can
  message the "<name>" thread again." and, from the bridge's tally `main-handled.json`, "Main handled 3 messages, 2 scheduled runs
  and 1 card tap while this thread couldn't be reached." What happens to each kind while it is deaf: an owner message is typed if the
  hold clears before its claim deadline (the pointer is owed), else the hub gives it to main (one atomic claim, never both); a
  scheduled run does the same and main's run is marked "Ran in Main, not in <thread>" in the run history (`RunNote.ran_in_main_for`,
  shown ahead of the run's summary); a card tap goes to main the same way. Nothing already handled by main is delivered again.
  Counts: `deaf-threads.json` (the Mac writes it every 15 s while a thread is listed; `talos-app doctor` has a WARN row per thread
  with its minutes and its refused keys in the last hour, Settings → Health has one amber row, `workers.status` carries `deaf`);
  both files are `packages/protocol/src/deaf-thread.ts`. The Linux supervisor does not have this alarm yet; its
  older pointer-refusal line and Needs you still work and use the same kind.
  line is dropped (or taken out of the box), never typed for a message main already has. A worker's screen is a conversation,
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
  nothing is typed to break the turn. The tap's limit is memory only, so a worker found `stopping` after a relaunch gets one of
  its own: whose stop it was is not in the file, and the wait would otherwise have no end. It is 10 minutes (`adoptedStopLimit`;
  the governor has no limit to use instead) from when the stop was asked for, which the entry now carries as `stopping_since`
  (written while `stopping`; a time in the future counts as now, a file without one counts from the relaunch; and whatever the file
  says, the turn gets at least `adoptedStopFloor`, 2 minutes, from the relaunch, since the file can be edited while the app is down and
  the time away is wall clock). At the limit the turn
  is ended as an owner's stop would end it, and the thread gets one line saying its turn was cut and the conversation is kept.
- **Parked means gone**: `parked` waits for the whole process group, with SIGKILL after the grace, so a child that ignored
  SIGTERM can't outlive it; a crash kills what's left of the group too.
- **An unknown is a no-op.** A tmux read that fails is not an empty screen, a quiet pane or a dead worker: nothing is
  typed, signalled, killed, started or marked failed on it, and the next tick looks again. A worker is gone only when tmux
  says so (`can't find session`, `no server running`, or no socket at all), when its pane's pid isn't the worker's (pane ids
  restart with a new tmux server), or when the kernel says its group is empty. Unknown busy counts as busy. A failed
  `capture-pane` or `list-clients` means no typing. A failed read during adopt keeps the worker as the file has it and
  leaves its wakes in place until it can be read. A failed read during a start holds the start.
- **Clock jumps**: a turn, the ready wait, the park grace and the idle time are timed on an awake clock that stops in sleep and
  never jumps, so waking the Mac, or a wall clock that is set, can't look like a quiet pane, an idle session or a wait long over.
  The wall clock is kept for `workers.json` only. The key times tmux reports for its clients are wall times: they are put on the
  awake clock as the clocks read when they are looked at, and when the wall clock is seen to have moved more than 2 s against the
  awake one (each tick, and again where the keys are read; `wall_clock_jump` in the log) every session counts as active then, so
  none is parked within a whole idle time of a jump, or of a sleep with the app running (time away while the app is not running
  counts as idle at the relaunch, from the file's times). The cap ranks by the awake clock too.
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
  **Background work holds the park** (`WorkerBackground.swift`, after the 2026-11-15 loss of a session's `sleep` waker): when the
  park is due, the process table is read, and any live process under claude other than its MCP servers and its own helpers
  (caffeinate) keeps the session up: a shell claude started (the Bash tool, a command run in the background included) and
  everything under it. It is the app updater's rule (`BackgroundWork.offenders`). Claude Code's native install runs as a file
  named for its version (`2.1.325`), so claude is also known by that name with `claude` as its argv[0]. A table that can't be
  read holds the park too. The log says so once per hold: `worker_idle_held thread=<id> bg=<n|unknown>`. A sub-agent runs
  inside claude and can't be seen by itself, only while a command it started runs.
- **Cap**: a start at `max_live` parks the longest-idle non-busy worker with no background work. A session with background work is never
  stopped for it: when every quiet one has some, the new session starts over the limit (log: `worker_start_over_limit
  thread=<id>`, once it has really started) and its thread gets one line, "Your computer is busy: ..." (kept and retried like the
  background-cut line), at most one in ten minutes. The cap's own tick does not count those quiet sessions with work against the rest, so
  the new one stays while the work runs; once it ends, the longest idle is parked and the count comes down. The sessions that can be over are bounded by the thread sessions the owner has
  made, one worker each. With all busy the wake is held up to 2 min and
  then dropped (the hub's deadline hands the message to main). `parking` and `stopping` workers hold a slot, and a lowered
  cap parks the excess as they go idle, not counting the ones already on their way out.
- **Every park is logged**, once, when it is decided: `worker_parked thread=<id> why=<idle|cap|crash|update|governor|control|
  switched_off|stop_limit|owner|restart|...> idle_s=<awake seconds since the last activity> bg=<n|unknown>`. A park that cut
  background work posts one line in that thread: "Parked while <n> background task(s) were running: <first command, 60
  chars>." After a crash the count is `unknown` and no line is posted: the CLI starts each Bash tool shell detached (its own
  process group and session, an empty environment), so once claude is gone nothing proves whose a shell was.
- **Long waits** in a thread session use a Talos schedule (`schedule_propose`: it runs in that session and wakes it when it
  is parked) or a background process, never only an in-process timer: a parked session has no process for a timer to fire in.
- **Messages from other sessions** do not wake a parked one. Claude Code's `SendMessage` reaches a peer over its socket
  (`/tmp/cc-socks/<pid>.sock`, listed in `~/.claude/sessions/<pid>.json`); a parked session has no process, so no socket and no
  entry, and a send by name fails at the sender before anything reaches a path the supervisor could watch. The route that
  wakes is the Talos `handoff` tool: the hub writes the lead's wake file, as for an owner message. Not built, and what it
  would take: each thread session launched with a fixed `--messaging-socket-path` of its own (the CLI has the flag), so its
  address outlives one process; the supervisor listening on that path while the session is parked and taking any connection
  as a wake (the send itself still fails, and the sender must send again once the session is up); and senders using that
  `uds:<path>` address, because a name is looked up in the CLI's live list, which only the CLI writes. Whether the CLI accepts
  a socket outside `/tmp/cc-socks` as a peer address was not checked (its address check has a list of allowed folders).
- **Crash** while live → `parked` (the transcript is on disk; the next message resumes). 5 exits in 15 min →
  `crash_loop`. The CLI's resume error on a line of its own (`No conversation found with session ID`, or `No session found
  with ID`) during a start → `resume_missing`, id kept; `fresh` moves it to `previous_ids` (last 5).
- **A session nobody has typed in** has no saved conversation (Claude Code writes `<config dir>/projects/<folder>/<id>.jsonl`
  after the first message or an `/exit`), and `--resume` of it would be refused. Main's rule applies (`SessionTranscript`,
  docs/desktop.md): before a resume the file is looked for in the session's own `CLAUDE_CONFIG_DIR` (else `~/.claude`), under
  the folder's own name first and then under any name. None, for a session that never had a turn → the start uses
  `--session-id` with the same id (log: `session_not_saved thread=<id> session=<id>`). A session a message was typed into has
  a conversation, so a file that is not found is lost (deleted, another config folder), not unsaved: it is resumed and ends
  `resume_missing`, never quietly empty under the same id. "Had a turn" is `turn_session == session_id` in `workers.json`
  (optional; the id a message was last typed into, or the id last retired; the bridge only tolerates it); in a file without
  the key, `last_turn_at` being set. Two refusals of a start are mended and are not counted as crashes:
  "Session ID ... is already in use" (the session is saved after all: it is resumed at once, and that id is resumed from then
  on while the app runs; log `session_in_use_resume`), and a resume refused for a file that holds only meta and slash-command
  lines (nothing to resume: the id goes to `previous_ids` and a new conversation starts; log `session_empty_new_id`). The new
  id is given once: if the next start is refused the same way before any start has connected, the thread stops as
  `resume_missing`. A real conversation whose resume fails still stops as `resume_missing`, and an id that is not a UUID is
  never looked up.
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
  line at once. So does a trust or MCP dialog whose subject is `null`: with nothing to tell it from another dialog of its kind, a card
  for it could be answered onto a lookalike that took its place, so it is never offered (not in `workers.json`, not in the popup).
  Login is a kind only (its screen is the input box with `Not logged in · Run /login`), and is offered without a subject because its
  card sends no key. Labels and subjects are compared character for character, by unicode scalars, not as Swift's `==` does.
- **The card wait.** A dialog is offered when its screen has held still (`dialogSettle`). The thread line waits `cardAckWait` (15 s) from
  the Mac's first sighting for `dialog-card.json` naming that dialog in any status; with one there the Mac never posts the line for it. No
  worker is stopped for a dialog but a STARTING one after `dialogLimit` (900 s), as before.
- **One sighting, one id.** The id lives in the worker's `workers.json` entry for the bridge to read. A record read back from disk after a
  relaunch is never pressed on and never kept: an agent can edit that file while the app is down, and the app was not looking at the pane
  while it was away (the dialog can have been answered there and another that reads alike be in its place), so what THIS process first
  sees hold still is a new sighting under a new id, however exactly it equals the record. The card for the old id then applies to nothing
  (a tap for it gets `unverified`) and the bridge makes a card for the new one. The next settled sighting also
  gets a new id after ANY Enter the Mac sent, and after any change of the screen under an offer this process had verified (the owner's Enter
  in the pane, a second server's dialog that looks the same, even a cursor move), so an old card never applies to the next dialog.
  And from the moment the screen is seen to change until that next sighting, no answer for the old id presses anything: a verified tap
  gets `nothing_pressed` / `screen_changed` (and is used up), a popup click "the screen changed". The dialog on the pane then may read
  exactly as the offered one did and still be another. Known gap: a dialog answered in the pane and replaced, between two looks one
  tick apart, by one that reads the same down to the cursor row leaves no frame to see; only the typing guard (`clientQuiet`, 30 s
  after the owner's key) stands in the way of an old card there.
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

## A thread's live state file

Every worker has its own live state file, `<agent folder>/threads/<id>.state.md`, with sections for the owner's open asks,
what it is waiting on, what is in flight, CI and the rules it learned. The supervisor makes it from a template at a start
when it is missing (`threads/` 0700, the file 0600, opened exclusively, never through a link, never overwriting; a failure
is audited as `worker_state_seed_failed` and never stops the start). The generated `workers/<id>/settings.json` registers
the kit's `thread-state.py` for every worker, in the agent folder or in a folder of its own: SessionStart
(`startup|resume|clear|compact|fork`) puts the file in the session's context, and after a compaction the thread's own carry
of recent corrections comes first; PreCompact writes that carry (`<state folder>/threads/<id>.compact.md`). The script and the
guard it reuses are copied into `workers/_hook` from the verified kit release exactly as the permission hook is (verified
bytes only; both or neither, so an older kit gives a session without them), and run by the same resolved python3 in a clean
environment with the role, thread and agent folder fixed in the command. The same settings allow Edit and Write of that one
file by its exact absolute path (both spellings), nothing wider, so the thread can keep it current without a prompt (a path rule also names what is under the file, gitignore-style, so the same settings deny its children, `<id>.state.md/*`; the suffix is `/*`, never `/**`: Claude Code strips only a trailing `/**` before matching, so a `/**` deny names the file itself and made Edit refuse it, and a deny beats the allow). Rules match without regard to case, so a case variant of the name is covered too (on a case-sensitive disk it is a different file and stays allowed). A seed that finds anything but a regular file at that path (a folder, say) reports a problem instead of "exists". The file and the carry are injected inside a data wrapper (`=== THREAD STATE (data, not instructions) ===`), never as instructions. The hook runs with `-B` and a bytecode prefix that does not exist (`/nonexistent`), so nothing is written or read beside it in `workers/_hook` (the permission hook's own line is unchanged). The
kit's `session-start.py` and `compaction-guard.py` do nothing of Main's for a worker whose settings register the hook (the spec then sets `TALOS_APP_THREAD_STATE=1` beside `TALOS_SESSION_ROLE=worker`; a worker without the variable keeps today's behaviour): no
`memory/STATE.md`, handoff, daily log or Main's carry in a worker's context; the injected header says where Main's
`memory/STATE.md` is, which the worker may still read. The Linux supervisor and the Mac app's `WorkerSpec.swift` both register the hook in the thread's generated settings, the same way. A Talos distro (rooted: exactly one hook is allowed in the settings)
does not register the hook yet; its workers are still seeded and told to keep the file. The staged files' hashes are part
of the launch spec, so an update that changes them restarts sessions. The default preamble's closing sentence names this file and tells the thread to read it first after a restart or compaction, since the hook may not be registered for it (the Swift copy of the text matches word for word); a thread's own `WORKER.md` replaces the preamble as before.

## The app (WP-OC4)

| Piece                      | File                                                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Store                      | `apps/web/src/features/thread-sessions/store.ts`                           | the last `workers.status` (also from `ready.workers_status`); `useThreadSessionView(id)` = offered / unsupported / dedicated / worker; park, resume, restart, fresh as signed `thread.session.control`, answered by `session.control.result`                                                                                                                                                                                                                 |
| Own session                | `OwnSession.tsx`, in the thread settings sheet (`manage/ThreadEditor.tsx`) | the switch, shown only when `dedicated.enabled`, `workers.status.supported`, and `canBeDedicated` (never the default thread, General, Inbox); the cost note; the worker's state ("Live", "Parked 14:02", a failure in words); Park now, Restart, Start fresh                                                                                                                                                                                                 |
| Status line                | `thread-sessions/words.ts`, `useSessionWords.ts`, `SessionStatus.tsx`      | what the session is doing in words (`sessionWords`): waiting on the owner and for what (a permission card, a usage limit with its reset, a prompt at the Mac with the step), working since when (amber after 2 h in one turn), parked and why, failed, Mac offline. The Threads screen row shows it instead of the last message unless the session is plain idle; the thread header's pill opens a sheet with the sentence, the step and "Open the request". |
| Settings → Thread sessions | `ThreadSessionsSection.tsx`                                                | the master switch (on until the owner turns it off, where the Mac runs thread sessions; `config.patch {dedicated: {enabled}}`, no step-up), one row per dedicated thread (parked ones too), the "Saving limits" banner when the governor pauses                                                                                                                                                                                                              |
| Session sheet              | `features/session/SessionPanel.tsx`, `store.ts`                            | the weekly bar says "all sessions" once thread sessions are allowed and shows the newest reading of any session, with "as of N min ago" past 2 min and dimmed past 15 (`rate_limits[].as_of`, sent only to a relay listing `usage-as-of/1`); a thread-scoped `session.state` never replaces main's                                                                                                                                                           |

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
- Budget, in the `handoffs` table of `history.sqlite`: 20 a day each way per lead (5 until Pantheon 2026-11-15), counted from the last midnight in the owner's configured timezone (the refusal says when it resets; rows dated in the future don't count). At most 3 open TASKs per lead; a TASK stops being open only on the lead's `RESULT`/`BLOCK` (each closes the oldest still-open, non-expired TASK), when the thread goes back to shared, and after 24 h; a reply or card in the thread closes nothing, because main and the lead share the author `agent`. At the cap the refusal lists the open TASKs (first words and age) so main can wait or ask. A hand-off is retried until delivered, however late: there is no give-up. A `RESULT`/`BLOCK` needs an open TASK to close, and main's TASK within 10 minutes of that lead's RESULT is refused ("that looks like a reply to its RESULT"), so nothing replies to a RESULT.
- A lead's `RESULT`/`BLOCK` counts as its answer, so a session that ends after it gets no "stopped before it answered" row.

## Main controls a thread's session

The `thread_session` tool (`apps/bridge/src/tools/sessions.ts`) lets the main session look after a thread's own session that is asleep, parked or stuck. Main only and live only: a thread session (a lead included) is never given it, and a headless job is refused. Args: `action` (`status`, `wake`, `restart`), `thread_id`, `why`.

- `status`, for one thread or every dedicated one: `state`, a one-line `summary`, `turn_started_at` (while a turn runs), `last_turn_at` (the end of the last finished turn), `last_active_at` (when the Mac wrote it), `parked_at`, `restarts`, and `stopped_why`.
  - `state` is `needs_you` while the entry's `needs_you` is set (a dialog or prompt on the pane); `session_state` then keeps the supervisor's own state, and `summary` reads "waiting on <kind> since <time>". Main can `restart` such a session at once.
  - `summary` otherwise reads "in a turn since <time>", "running, between turns; the last one ended <time>", "parked: idle since <time>" (or the cap, the owner, a crash, interrupted, a restart, plan limits), or "failed: <code>". Times are in the config's time zone, with the day when it is not today.
  - `stopped_why`: the entry's `error` (code, detail, at) when there is one, `null` while the session runs, otherwise the reason the supervisor stored (`idle`, `cap`, `owner`, `crash`, `interrupted`, `restart`, `governor`; one this bridge does not know reads `unknown`), or `"not recorded"` from a supervisor that writes none.
  - `restarts`: the crash restarts the supervisor recorded (`by: "crash"`) and the restarts Main asked for through this tool (`by: "main"`, with its `why`, from `main_restarts`), oldest first, the newest 10. The owner's own button is in neither list.
  - A thread with no entry reads `state: null`, "no session yet (never started)"; asked for by id, a thread without its own session reads `state: null`, "answered by Main, no session of its own".
  - It also says when the supervisor heartbeat is stale (the Mac app is not running), and lists an entry the hub cannot read as `unreadable`.
  - Who writes the fields: both supervisors write all three (the Linux one in `supervisor/worker-status.ts`), and move `last_turn_at` when a turn ends (the pane goes quiet after a pointer, a park waiting for the turn included). The owner's stop always records `owner`, whatever reason was there before. `needs_you.kind` is always Talos's own words (a dialog's name from a fixed list, a prompt's title from the detector's fixed table), never screen text.
  - Known on both sides, not yet fixed: adoption records `interrupted` over a reason already recorded (a session the owner was stopping that exits while the supervisor restarts reads "off: interrupted"); an idle live session found gone after a supervisor restart gets no reason; a park because Main's own launch narrowed (`main_narrowed`) or a sub-thread's settings would now be refused (`sub_refused`) reads as the owner's, since the protocol's `stopped_why` has no words for them yet.
- `wake` writes a `resume` wake; `restart` writes a `restart` wake (same conversation). Both go through the same check as the owner's button (`router/session-control.ts`): not dedicated, the Mac app not running, an unreadable saved session and the usage governor refuse alike (trust mode's pass-through and its warning included). The default thread is refused by name. A busy session restarts when its turn ends, or after 15 minutes if it does not (the owner's stop limit, `WORKER_TIMING.owner_stop_s`; the Mac's `stopLimit`), as the button's does.
- Restart applies an instruction edit now: a session reads its thread's instruction files (and the release's preamble and settings) when it starts, so a change to them reaches a running session at its next restart. After an update, the supervisor does that itself (restart-on-update, `dedicated.restart_on_update`, on by default): right after it starts and whenever the release it runs changes, each running session whose launch spec differs from the one it launched with (`spec_hash`: a new release, its own instruction files changed, or the guards re-pinned by the refresh at Main's start after a bun upgrade, which the Mac counts as a release change) is restarted once for that spec, resuming its conversation, one at a time, only while it is quiet (no turn, no draft in its box, no key in an attached client lately, nothing waiting on the owner, no background work under it), and held while the usage governor is not ok, off or unknown (no usage reading yet, which also lets a start through). The owner gets one line in the default thread: "Updated or instructions changed: restarted A, B; C restarts when its turn ends; D failed; E was not restarted (it did not start again)." (Linux: `supervisor/update-restart.ts`; the line's shared cases: `apps/desktop/Tests/Fixtures/update-restart-line.json`.) A session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now. To see, without changing anything, what an update would restart: `talos-app update-check --dry` on Linux (`Talos --update-check` on the Mac) prints one line per running thread session, `<thread id>  <state>` (unchanged, spec changed, instructions changed, no record, busy (would wait), or unknown (dry plan refused)), then a count, and nothing else: no file text, path, hash, environment or display name. It writes, audits and locks nothing. "Instructions changed" means only the instructions a session outside the agent folder is handed changed; each start records their digest (`WorkerLaunched.instructions_hash`) beside its spec hash. The report plans with Main's environment as a restarted supervisor rebuilds it (from the login shell), so for a Main started with an environment since changed it can say more than the running supervisor would restart.
- What an update would restart, read-only: on the Mac, `Talos.app/Contents/MacOS/Talos --update-check` (Linux: `talos-app update-check --dry`) prints one line per running session, `<thread id>  <state>` (unchanged, spec changed, instructions changed, no record, busy (would wait), unknown (dry plan refused)), then a count. It runs the update check's own dry plan and prints nothing else: no file text, paths, hashes, environment or names. It starts nothing, writes nothing, takes no lock and runs no tmux; exit 0 whatever it finds. "instructions changed" means only the instruction files handed to a session outside the agent folder changed (`launched.instructions_hash`); a session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now.
- `wake` looks at the published state first, because a resume wake does nothing to a running session: on a `starting`, `live` or `busy` session it is refused ("already running"), and on a `failed` one too (the Mac does not start a failed session on a resume; restart clears the failure). Both write no wake file and post nothing. On `parking` or `stopping` it is passed on: both supervisors start the session again once it has stopped, and the answer says so.
- No `fresh` and no `park`: each is refused in a sentence. A fresh conversation stays the owner's button.
- `why` is required, 1 to 80 characters after trim. It is made one safe line (as hand-off text is) and posted in that thread as a system row: "Main woke this thread's session: <why>" or "Main restarted this thread's session: <why>". The bridge log gets the thread, action and why.
- At most 3 restarts per thread in any rolling hour, counted in the `main_restarts` table of `history.sqlite`, so the count holds across a bridge restart; the refusal says when the next is allowed. A wake is not counted, a refused restart uses nothing, and the owner's button is never counted here (the reader's gap and cap below count every caller). Restarts dated up to an hour ahead still count (a clock set back gains nothing); one dated further ahead is ignored.
- The wake file carries `by: "main"` (the owner's button writes `by: "owner"`), for the log. Both supervisors ignore a key they do not know: the TypeScript one parses with a plain zod object (unknown keys stripped), and the Mac decodes named keys only.
- Same-uid code can write a wake file, so the reader is the place of record for control wakes (`packages/protocol/src/wake-decision.ts`, vectors in `packages/protocol/fixtures/wake-decision/`, which the Swift reader runs too). A control wake older than 5 minutes by its own `at`, or dated over 5 s ahead, is refused as stale; that, and the reader taking the file by renaming it aside, is what keeps an old wake from being carried out again. There is no replay counter: against code running as the owner's user it adds nothing, and one pinned ahead by a wrong clock locked every control out. A `counter` key in a file written by an earlier build is tolerated and ignored.
- `restart` and `fresh` are held to the reader's own per-thread limits, counted for every caller (the owner's button included, since the file cannot prove who wrote it): 20 seconds apart, 12 an hour, out of a person's reach but a stop for a loop. Main's own restart rules (120 s and 3 an hour for `restart_main`, the 3-an-hour ledger for `thread_session`) are separate and unchanged. `fresh` is refused while the session is in a turn; a `restart` of a busy session waits for the turn and its notice says so. `park` and `resume` are never capped: a governor park is refused only when stale. Every control carried out, and every refusal except a wake dated ahead, posts one line in the thread. Pointer wakes keep their own rules.
- The reader keeps `workers/<thread>/wake-state.json` (`WakeState`: the restarts and fresh starts it carried out, by the wake's `at` and action). The bridge checks the same rules before it writes a `restart` or `fresh` wake (`router/session-control.ts`, so the owner's button and Main's `thread_session` both pass through it) and answers in the reader's words (`rate_limited`) instead of "Restarting…"; a `fresh` for a session that workers.json shows `busy` is refused the same way (`worker_unavailable`). It counts what the reader took plus the capped wake still waiting in the file, so a double tap is refused up front; with no reader state, it counts its own record of the capped wakes it wrote (`workers/<thread>/wake-written.json`), which also counts any the reader then refused. That record is written after the wake: a failure there is logged and never stops a wake. Both files are on the guards' deny list.
- Governor park-all writes a `park` wake for each live thread and writes it again if the thread is still live 30 s later, or at once if the clock has gone back past when it was written: a park the reader refused (stale) or dropped is never left for good.
- Refusal notices are not rate-limited. Code running as the owner's user could fill a thread with them by writing wake files, but such code can already post, kill and delete as the owner; a limit here would mostly hide the owner's own refused taps.

## Leads

A lead is a dedicated thread session given a role, a memory and a boot file in its own folder, outside the main agent
folder (`~/leads/<lane>/`), so it does not inherit the main agent's rules. The kit side is in [`kit/README.md`](../kit/README.md)
("Thread leads"); this is the bridge side.

- `talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--mcp a,b] [--sandbox | --light]`
  (`apps/bridge/src/lead`). Typed in a terminal it is the owner's; run by the agent it needs the owner to have asked (in that
  thread or the default one) and "Lock Talos settings" off (`on-request-cli.ts`). `--agent-dir` defaults from `TALOS_AGENT_DIR` and must be a real agent folder (a `.talos-version` or a
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
- A thread's instructions are the `AGENTS.md` (and `CLAUDE.md`) in its folder. Agents edit them with their normal file tools, with no card and no separate enforcement: a lead edits its own, and a parent lead may edit a sub-thread's, since that folder is inside its own, unless the sub-thread keeps an existing folder of its own outside the parent's (then the sub-thread does not get the parent's instructions; docs/THREADS.md, "Sub-threads", Folders). The owner sees every change in the folder itself, and in git where the folder is a repository.
- Templates are `kit/templates/lead/`. The Stop hook blocks once per stop and fails open on empty or invalid input; see the kit page.

## Reading the problem folder from a thread

A thread session is refused every `talos-app` command not on `WORKER_COMMANDS_OK` or `WORKER_READ_OK`
(`apps/bridge/src/worker/cli-refusal.ts`). `WORKER_READ_OK` (Pantheon 2026-11-15) lets every lead read `status`, `doctor` and
`logs`; `logs` shows a thread session only the lines that name its own thread (`thread` or `thread_id`), and nothing when its
thread can't be told (no variable, a marker without one, or the two disagreeing). Like the rest of this fence it is a speed bump, not a lock: outside a lead's folder the variable is not checked against anything, so a session that sets `TALOS_APP_WORKER_THREAD` to another thread reads that thread's lines, and one that unsets it reads as the main session (the same gap as every other worker refusal, above).
A scheduled triage job that runs inside a thread needs `talos-app errors list` and `errors show`, so there is a per-thread opt-in,
`threads[].session_opts.ops_read` (boolean, default off). With it on for that thread, and only that thread, the fence also lets
`errors list` and `errors show` through, from a second list, `WORKER_OPS_READ_OK`, that is consulted only with the flag on and
never merged into the first. `errors close`, the rest of `errors` and every other command stay refused.

- **Who is calling.** The thread id is `TALOS_APP_WORKER_THREAD`, or the `thread` in the `.talos-lead` marker found in the
  current folder or above. If both are present they must name the same thread. The grant follows the thread, not its mode: an archived or not-dedicated thread keeps it until the key is removed. A session with the worker role and no thread id,
  a marker with no thread, a missing or unreadable `config.json`, or any value other than the boolean `true`, reads as off.
- **What it prints to such a caller.** `list`: the id start, open or closed, count, source and kind, last seen, name and message
  (already scrubbed when filed, home folders replaced again on the way out); an unreadable file is listed without its path.
  `show`: the stored report as JSON, except `screenshot_path` is left out, the owner's typed note (`steps`) is replaced by a
  fixed line (it can quote messages from any thread), and home folders in names, messages, frames and routes are replaced by
  `~` and `$TALOS_APP_HOME`. A report that cannot be read is named without its path. Whether to redact is decided from who is
  calling (a thread session), never from the flag, so a flag that flips mid-command cannot unredact the output. The main session still sees everything.
- **Mac only.** The option's row is `THREAD_SESSION_OPT_ROWS.ops_read` in the settings table (`phone: false`, `agent: false`,
  `risk: 'high'`). `ConfigFile.applyPatch` refuses, as `config_field_forbidden`, any `config.patch` (app, phone or an approved
  agent card) that leaves it on where it was not; turning it off, or sending the saved value back (Settings does on any other
  edit), is fine. `ConfigFile.update` refuses it the same way, and a patch first picks up a hand edit not yet reloaded, so a stale copy cannot put a removed grant back. `config_propose` cannot reach `threads` at all. The registry view `HIGH_RISK_SETTING_PATHS` lists it for any risk check. Because every Settings page edit goes through that patch,
  there is no Settings toggle for it on purpose.
- **Turning it on.** Edit `config.json` on the Mac by hand: in the thread's entry under `threads`, add
  `"session_opts": { "ops_read": true }` (keep any other keys in `session_opts`). The bridge picks the edit up on its next
  config reload; the fence reads the file on each call, so a running session sees it at once. Remove the key, or set it to
  `false`, to turn it off.

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
root is `TALOS_INBOX_ROOT` when set, which every test sets), and the path `read_inbound` returns is the copy. A thread folder the bridge makes holds a `.talos-inbox-folder` marker; only a folder with that marker is pruned (7 days, 1 GiB), and when the thread leaves the config only such a folder is removed (its plain files, never a folder inside it), so anything else under the root is left alone. An archived thread keeps its copies: they age out with that pruning (7 days, 1 GiB a thread), and un-archiving gets them back. It lives outside the
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
which scopes them to the thread it proved; `restart_main` takes no thread id, touches no thread's rows and is refused unless
the session is still its thread's lead (it asks the Mac app to restart Main, `docs/bridge.md`). `test/worker-tool-lock.test.ts` names every worker tool and how it is held, and
fails when a worker-visible tool is not in its table. The CLI is an allow list: a thread session (`TALOS_APP_WORKER_THREAD` or
`TALOS_SESSION_ROLE=worker` set, or a `.talos-lead` marker in the current folder or any parent) may run only `hook`, `guard-hook`,
`commands`, `events`, `subagent-tee`, `lead check`, `codex check` and the usage text; every other command is refused, `restore-last-good`,
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
thread is told how to fix it (`claude mcp add -s local <name> ...` in that folder, or `enabledMcpjsonServers` in his own
`~/.claude/settings.json`; an approval answered inside Claude Code there is kept in the folder's `settings.local.json`, which a thread
session does not load, so it does not count). Each
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
fence is refused before it runs (`validate`). **On Linux** (apps/bridge/src/supervisor/worker-spec.ts) names are exact, so the
fence is the spelling given and the real path, without the lower-case copies. A home or a thread folder on a file system that
ignores letter case (a Windows drive under WSL, casefold ext4) is refused instead, as is a home with `\`, a trailing space or an
empty, `.` or `..` part. There, `validate` checks the finished spec against what the supervisor knows: the Talos home and Main's
ceiling, never the spec's own fields. It also checks that the one `--settings` is the worker settings file it checked. **What it does not stop:** a worker's Bash can still read the home with `sqlite3`,
`python` or `grep -r`, because only a sandbox stops a program that opens the file itself, and a non-lead worker has none. Leads keep
their sandbox (or, in the light profile, the same honest limit).

**The developer switch (owner ruling 2026-11-15).** `dev.thread_fence` in config.json (Settings → Developer, protocol `dev.ts`
`DEV_ROWS`) turns the Talos home deny above off: the supervisor reads it at every start, on Linux `worker-config.ts` `threadFenceOn`
and on the Mac `WorkerFence.threadFenceOn` (off ONLY for exactly `"dev": { "thread_fence": false }`, the JSON literal false; anything
else, `0`, `"false"` or an unreadable file included, is on), and with it off the
session's settings carry no Talos-home deny and `validate` (told by the supervisor's own read, never the spec) asks for none. The
session and its sub-agents (one process, one `--settings`) get the same access Main has, and no more (Pantheon's scope ruling of the
owner's words "accessing files or areas that main can access"). Everything else that
fences a session stays: Main's own deny rules (the ceiling), the guards, the edit-only deny on every session's settings and hooks
(and the Talos home's whole `workers` folder, closed to the file-tool writers: the permission hook's copy in `workers/_hook` and each
session's settings, MCP config, nonce and launch file; every session gets it and `validate` asks for it with the fence on or off), and
a lead's own fence from its folder (the Talos home, the personal vault and the credential folders: `lead/fence.ts`), which a lead's
session keeps whatever this switch says. On or off, the supervisor's own files for the sessions stay closed to the file tools
(`workerFilesDenyRules`: Edit, Write and NotebookEdit on `<home>/workers/**`: the permission hook copy, each session's
`--settings`, its mcp.json, its nonce and folder check), and `validate` requires that deny: a session that could edit them could make
its own hook answer "allow", which Main cannot do (Delphi's review). A fresh install has it on. It takes effect at each session's next start (the spec hash
moves, so a session restarted on update starts with the new settings), the start is audited `worker_thread_fence_off`, and the
owner is told in the default thread whenever it flips (`trust.ts` `noteFenceFlip`). Through the agent, turning it OFF is always a
one-tap card, even when he asked in his own words (the two-hour window can't tell he asked for this: Delphi's review); turning it
back ON is made at once when he asked. A thread session can never name it.

With the fence off, a thread's edits to `~/.claude`'s agents, skills, commands, CLAUDE.md, rules, output styles, workflows and routines
ask the owner by card (`worker-policy.ts` `CONFIG_ASK_WHEN_FENCE_OFF`, written as `ask` rules; the card warns when the change touches a
frontmatter key that would let the agent approve its own actions, use other tools or switch models: `permission/frontmatter-risk.ts`);
the settings files, hooks, plugins and `.claude.json` stay closed to every thread (`CONFIG_ALWAYS_DENIED`), fence on or off.

**A live change.** On each tick the Mac compares what a running session was started with (`WorkerEntry.launched`: `cwd`, `model`,
`effort`, `mcp_allow`, written at every start) with the config. If they differ and the difference has stood for 30 seconds (two edits
in a row are one restart, with the final config; an edit put back restarts nothing), the session is restarted the way Restart is: it
goes through `stopping`, so a turn in progress is never cut, however long it runs (a saved setting does not arm the 15-minute limit a tap
on Restart has). A new **folder** starts a
fresh conversation (the old id moves to `previous_ids`) and the thread is told `Started a new conversation in this thread's new folder.` once (the folder is not named, and the MCP
servers a launch left out are named in quotes: both are the owner's settings in a system row); a new
model, effort or MCP list resumes the same conversation. An entry with no `launched` (written by an older build) is never restarted;
the next start records it. The sheet says "Saving restarts the session when its current turn ends."

**The privilege ceiling at launch.** A thread session never starts wider than the main session, on three axes, checked on the finished
spec and refused one by one: the permission mode (bypass is wider than the default, which is wider than plan; main's is its own launch
flag, the worker's is its command line, else `permissions.defaultMode` in its settings). Main's REAL mode is worked out from its launch
arguments (`--dangerously-skip-permissions`, `--permission-mode X`) and, when they name none, from the settings it reads (its own
`--settings` first, when its arguments carry one, else the guards' file; then the agent folder's local and shared settings, the user's;
`auto` and `bypassPermissions` do not take effect in the project files). A mode name Claude Code does not know is never guessed at:
for main it counts as `plan`, the narrowest. Main's arguments are read as Claude Code reads them (nothing after `--`, never another
flag's value), a source its `--setting-sources` leaves out is not read (`--restricted` loads none), and Claude Code's managed settings
(`/Library/Application Support/ClaudeCode`) count: the mode is the narrowest of every managed document's and that chain's, managed deny
rules join the ceiling, and where bypass is ruled out (`disableBypassPermissionsMode`, `--restricted`) main's bypass flags do not count
and its workers get none. Not read yet, so the ceiling can be wider than main there: `CLAUDE_CODE_RESTRICTED` in main's environment,
main's `--managed-settings` flag, `--disallowedTools`, a deny rule under an agent folder whose own name has glob characters, and
arguments changed in Talos Settings while the main session still runs under the old ones; and a worker is not itself started with
main's `--restricted` or `--setting-sources`, so it still loads the user's and its folder's allow rules,
and it is written into the worker's `--settings` as `permissions.defaultMode`, which outranks the thread folder's own settings: a folder
asking for `acceptEdits` cannot widen the session. When main runs in the built-in default, which the app cannot read, nothing is written
and nothing is invented, the MCP servers (every listed server must be one
main can use itself: defined in user scope, in the agent folder or by an enabled plugin; a server defined only in the thread folder is
refused), and the deny rules (the worker's must include every one main has: the guards' file, the agent folder's project settings and
main's own `--settings`, which the build copies into the worker's settings, each made absolute where it was defined: the kit's
`Read(./.env)` stays the AGENT folder's `.env`, at any depth below it as for main, and does not become a deny on the worker's own. A
whole-tool deny, `Edit(*)` or `Write()`, stays whole: a main made read-only has read-only workers in every folder). When main's own
`--settings` cannot be read (missing, not a regular file, not JSON, a `deny` that is not a list), neither its mode nor its deny rules are
known and nothing is guessed: the start is refused (`start_failed`) before it takes a slot, with a `worker_start_refused` audit line,
and the thread is told once, naming the file and the fix; once the file reads, the next Restart works. A refused spec is not launched: the worker goes `failed` with the error code
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
  (10 minutes, 3 minutes after a cold start), or the supervisor is down, the session failed, or the governor refuses a start: main
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

## Wake me

An agent (main, or a thread's own session) that has to wait more than about 25 minutes sets a one-shot timer with a note to
itself, `wake_me`, and stops: its session can then be parked, so a long wait holds no computer. In-process timers
(`ScheduleWakeup`, `CronCreate`, `sleep`, a polling loop) die with a park, which is why the tool text points agents here.
Asked for by the owner on 2026-11-15; the rules below are the build lead's.

- **The tool.** `wake_me {at | in_minutes, note}`; `wake_me {cancel: id}` cancels one of the caller's own. `at` is a local
  time in the scheduler's zone or an ISO time with an offset; it is rounded up to the minute (never early). A local time the
  clocks skip is refused; one that happens twice is the first, and the agent is told. The note is one line of at most 280
  characters once hidden, control and bidi characters are shown as visible escapes (`visibleMetaText`).
- **Whose.** A thread session's wake is set over the hub (`rpc` `wake_me`) for the thread its connection proved, never one the
  request names; main's are main's own and show in the default thread. A session cancels only its own; the owner any.
- **How it is kept.** Each wake is a one-shot (`once`) session job in the scheduler, id `talos-wake-` and 12 characters,
  catch-up 1440 minutes, written by the bridge with no card: it only wakes the session that set it. Its name and prompt are
  fixed ("Talos wake-up", `WAKE_JOB_PROMPT`); the note lives only in the bridge's own row, so a bridge that does not know
  wakes would offer an empty placeholder, never the agent's words, as an owner job. The bridge's own row (`wake_me` in history.sqlite, `apps/bridge/src/wake-me`) is the proof that a job is a wake: a job
  in that id range with no row is never delivered, and is deleted. No card can create or edit a job in that range.
- **Firing.** When the runner finds a wake due it is never offered as a `schedule_run`. The row moves pending → firing (one
  conditional update, so two ticks or a tick and a Cancel cannot both act), the note goes out as `kind=wake`, `trust=agent`,
  `wake_id`, `wake_for` (`main` or `thread`): "You asked to be woken: <note>". Then the job and the row are deleted. The
  router sends a thread's wake to that thread's session (held like an owner message: a wake file starts a parked session, a
  live one gets a pointer), main's to main. A thread's wake is never main's: when its session can't take it (the thread went
  shared, was archived or deleted, or the claim deadline passed) it is dropped. The owner gets "A wake set by the "<thread>"
  thread's session was dropped: <reason>." in that thread, and main a `wake_for=dropped`, `trust=agent` note quoting the note
  as that session's words; that note cancels the owner's earlier ask in the default thread, where it lands.
- **Rate.** A session whose wakes fired 6 times in the last hour or 48 in the last day is paused: a new `wake_me` is refused
  with a `Warning:` saying until when, a wake that comes due meanwhile is dropped, and the owner gets one line per pause
  ("… keeps waking itself; its wakes are paused until …").
- **Never the owner.** The note is the agent's own earlier words. Like outside text, a wake firing in a thread cancels the
  owner's earlier ask there (`noteOutsideText`), so `ownerAskedIn` (config_propose's asked path, `thread_session`, the
  on-request start) is never satisfied by it or carried through it.
- **Missed and crashed.** Each runner tick sweeps: a row whose scheduler window passed (the Mac slept through it, Talos was
  off) is sent late and says so; a row left mid-send by a crash is sent again (a crash can repeat a wake, never lose one); a
  row whose job the owner deleted in Schedules is dropped.
- **Limits.** More than 7 days ahead, or more than 20 pending for one session, still sets it with a `Warning:` line. Over 366
  days, and over 100 pending across all sessions (wakes stay within half of the 200 jobs a scheduler snapshot lists), are
  refused. With no scheduler, or one Talos does not manage, it is refused in words.
- **Seen.** `workers.status` carries each dedicated thread's pending wakes (`threads[].wakes`, `wakes_total`) and main's
  (`main_wakes`, `main_wakes_total`), soonest first, at most 20 each, read row by row. The Session panel lists the wakes of
  the session that answers the thread, with time, note and Cancel (`thread.session.control` `cancel_wake` with `wake_id`).
  `schedules_list` ends with the caller's pending wakes. The wake jobs also show in Schedules as "Talos wake-up".
- **Limits of this design.** Wakes ride the session runner, so they fire only while the bridge is live and connected to the
  relay, about a minute after their time; a Mac that is asleep wakes them late, never early.

## Needs-you prompts

A thread session's Claude Code pane can stop on a dialog only the owner may answer. For three known dialogs the owner now
answers with a tap, on the iPhone, the web app or the Mac app, instead of in Terminals. **In scope:** folder trust (`trust`), MCP
server consent (`mcp_consent`) and login (`login`). **Not in scope:** any dialog Talos does not
recognise; it keeps the thread line "This thread's session is waiting on a '<prompt>' prompt; open this thread in Terminals on the Mac to answer." (on Linux: "…; attach on <machine> to answer: talos-app supervise attach <id>") There is no
Face ID or step-up: the tap is the approval. The first answer wins; every other face shows "Answered on <device>".

**The tool permission and the agent's own question (Mac, pane-prompts rows 8 and 9).** When Claude Code asks its own permission question in
the pane (`Bash command` / `Create file` / `Edit file`, `Do you want to proceed?`, footer `Esc to cancel · Tab to amend`) or the agent asks
a question (AskUserQuestion: `☐ Color`, footer `Enter to select · ↑/↓ to navigate · Esc to cancel`), the Mac reads the screen exactly
(`PaneSelect`; a partial or garbled screen gets no card) and offers it as a card on the phone and a popup on the Mac, for a thread session and
for Main (`supervisor.main_dialog`). Kinds `tool_permission` and `agent_question`.

- A tool permission is a SAFETY question: only the owner's own tap answers it (a signed paired-device answer on the phone, a real click
  on the Mac popup). It offers `Allow once` (the `Yes` row) and `Deny` (the `No` row) and nothing else: "always allow", "switch to auto
  mode" and "accept edits" are standing grants and stay at the Mac. The card shows the tool and the command or file as read.
- The agent's question is the owner's own: no agent or worker may answer it. The card lists the rows as read; the free-text row
  (`Type something.`) is `Other…`, with a text box on the phone card (the Mac popup has no text field and does not list it). `Chat about this` is not an answer and is not offered.
- An answer is ONE number key (the digit drawn on the row). `Other…`: the row's number, the owner's words typed literally, then Enter,
  each step on a fresh read; the words are in the signed `card.resolve` frame (`text`, one line of 1 to 120 characters (what one row of the pane can show back), no control or
  invisible character), so the Mac types exactly what the owner wrote. Every key goes through the key gate with `Intent.pane`, which
  reads the live pane and refuses unless it is the exact screen the offer was made for (`PaneSelect.Screen.bound`: kind, tool, subject,
  every numbered row; not the cursor or the countdown). A screen that changed between the offer and the answer gets no key.
- The reader anchors from the question row up and needs exactly one frame rule above it with the header right under it, so a command, diff or
  question that prints its own rule, header or box rows gets no card. A digit selects and submits (measured, Claude Code 2.1.329: Tests/Fixtures/real-2.1.329);
  on the free-text row it only moves the cursor, and the footer then gains `ctrl+g to edit in VS Code`.
- A key sent and not seen to take (a timeout, or the prompt still on screen) is reported as "Sent, but your Mac hasn't seen it take yet", never as
  Allowed. A Main card the phone does not acknowledge in 15 s gets the plain line; Main's stall alarm waits 10 minutes behind an offer.
- A timed-out key is never sent again for that card; the unchanged screen is offered again, new id, after a short memory (the same
  rule as the safety popups).
- A question with several tabs (`← ☐ A  ☐ B  ✔ Submit →`) is NOT put on a card question by question: the thread gets one line, "asking
  several questions at once, which Talos cannot put on a card. Answer them at the Mac."
- Not yet: Linux supervisors do not read these two prompts (their threads keep the old line), what a typed word looks like in the free-text row is assumed (not captured).

**The computer-use permission dialog** (`Computer Use needs macOS permissions`, from a computer-use tool's `request_access` while macOS
has not allowed the program) is neither: it is never offered as a card, because Enter on its first row opens System Settings on the
Mac. The Mac supervisor dismisses it with Escape, which grants nothing, for Main and for thread sessions alike
(`DialogMatcher.computerUseBlock`, `ComputerUseDismiss`; real screens in `apps/desktop/Tests/Fixtures/real-2.1.322`):

- only on an exact match of the whole dialog (title, both permission rows, the three options in order with one cursor, the footer as
  the last row), re-read just before the key; never any other key;
- once per appearance (a dialog still there after its Escape gets no second key), and at most 3 an hour per session; past that, or
  10 s after an Escape that did not take, it is left on screen and the thread gets a line that names Esc as the one key to press and
  never says "answer"; Main's menu line says the same, and Terminals is never brought forward onto this dialog (whatever "open the
  terminal when the agent needs you" says);
- the log says `dialog_dismissed kind=computer_use_permissions` (and `dialog_dismiss_limit` once at the limit);
- the session is `needs_you` (workers.json, or Main's `needs_you` in `main-restart-check.json`) while the dialog is up;
- the thread (Main's: the default thread) gets one fixed line, at most once an hour: "This session tried to use the screen, but macOS
  has not allowed it. Nothing is stuck: the session carried on without it. Screen control for sessions is being rebuilt; there is
  nothing you need to grant right now."

The session sees its tool call fail and carries on (captured: the model said the permissions are not granted, and the turn ended).

**Claude Code's usage-limit screen** ("You've hit your … limit", then options to stop and wait, to wait and go on by itself, and to
go on with usage credits) is a card on the Mac (pane-prompts row 7): Talos presses NO row of it, ever (no digit, no arrow, no Enter on
a row), because one of its options spends money (`UsageLimitScreen`, `DialogMatcher.takesNoKeys`). The card (`PaneSelect.Kind.usageLimit`,
dialog kind `usage_limit`) says which limit and when it resets in plain words ("Fable limit reached. It resets 4pm (Europe/Paris)."; with no
time on the screen, "The screen doesn't say when it resets.") and has only the buttons the screen really offers: **Stop and wait** (one
Escape, the menu's own `Esc to cancel`; it ends the turn and nothing resumes it, so the answered card says "Stopped. Send a message after the limit resets to go on.") and, when the headline names a model, **Switch model** (Escape, then `/model` typed into the empty
box on the idle prompt for the same limit, then Enter). Only the owner's own tap answers it: a signed answer from a paired device (the
bridge's card) or a real click on the Mac popup. Each of the keys states its own intent (`KeyGuard.Intent.usageLimit`: escape,
typeModel, enterModel, clearModel), and the guard allows it only on exactly that screen (the menu with the offered rows, model and reset for the Escape;
for the rest the idle prompt of the menu-gone read made right after the Escape, `KeyGuard.idleSignature`, with the same limit's headline as a second
check: box empty for the typing, box holding exactly `/model` for the Enter and for the Backspaces that clear it). The model list that
`/model` opens is its own screen. No real capture of the menu exists yet (how to take one safely, with no key pressed:
`docs/CAPTURE-USAGE-LIMIT.md`): the match is built from the CLI's own strings
(`apps/desktop/Tests/Fixtures/synthetic/usage-limit*.txt`), loose on the words ("hit your" or "reached your", "limit", "usage
credits") and strict on the shape (numbered options from 1 below the headline, one cursor on them, nothing under them but a footer).
What `/model` draws under the box while it is typed (a list of slash commands) is not captured either: the Enter accepts a list of indented
rows that all start with `/` whose highlighted row (the one Enter runs) is exactly `/model` (no mark: the first row must be), and a list drawn
otherwise refuses the Enter (`key_refused ... why=row_under_box`, with the shape), the typed `/model` is taken out again by guarded Backspaces, and the
card says how far it got (result outcome `partial`, reason `closed`, `typed` or `cleared`; never "nothing pressed", because Escape went).

- every other key sender checks it on the rows it is about to press into: the dev-warning auto-accept, the dev card and its popup, the
  pointer typer, and the computer-use Escape; the tap answerer's other kinds never reach it;
- the session is `needs_you` with kind `usage limit` (workers.json, or Main's `needs_you` in `main-restart-check.json`) while it is up;
  `thread_session status` and `restart_main check` give the step (`needsYouStep`) instead of "answer it";
- Terminals is not brought forward for it;
- the offer goes out as the thread's `dialog` (or Main's `supervisor.main_dialog`), so the bridge makes the card and the Mac popup lists
  the same two buttons. A thread's line is the fallback: one per appearance, at most one an hour, held while the offer settles and the card
  is awaited (`cardAckWait`), and never sent when the bridge made a card. Main's line goes at once (the default thread, as the Mac's own row;
  its card follows). A line names the model (from a fixed list, or "this
  session's model"), when it resets if the screen says (rebuilt from numbers and a time zone the system knows), and that Talos pressed
  nothing; no terminal, no pane, no command. The log says `usage_limit_seen` with `line=yes` or `line=held_hourly`.

On Linux (the supervisor in `apps/bridge/src/supervisor/`, `usage-limit.ts`, ported from `UsageLimitScreen` with its tests; **no card yet**, FOLLOWUPS
"usage-limit card on Linux") the same screen is its own kind for every reader (`liveDialog`, `classify`: `usage_limit`; the prompt detector and the tap reader see none):

- every key Talos sends goes through `TmuxPtyHost`, which reads the coloured pane first and allows the key only for what the sender
  states it means to press (`key-guard.ts`, an allowlist): typing Talos's line into Claude's own input box when it is live,
  empty, and has only Claude Code's status rows under it (`box-frame.ts`; the Enter and Backspaces when it holds exactly that
  line, drawn as Claude Code draws typed text), or a key for a named dialog when that kind's exact reader matches the live region
  (the option reader for trust and MCP consent, the same one first-start answers by). Nothing goes to this menu anywhere on the
  pane, to a select Talos cannot name, to an unreadable pane, or with no intent; a refused pointer is told to the thread once,
  after the hold wait, and the audit's `worker_pointer_held` says why (the guard's code, and the row under the box that is not one
  of Claude Code's); a first-start key refused three times on one screen leaves the start waiting on that screen, said once;
- what the key guard reads is the screen, and the screen can be drawn by anything that prints there: a status line a hostile
  settings file sets could draw a whole rule/`❯`/rule frame holding Talos's line under the real box (the Enter is gated on the
  LAST such frame), or a dialog's rows. Thread sessions run with Talos's own status line (the usage recorder, whose one row the
  guard knows), so their screen holds only what Claude Code and Talos draw; same-uid code or a hostile `--settings` is outside
  what the guard can tell apart, as the guards' stated boundary says (SECURITY.md);
- the menu is recognised with or without a rule above it, as the Mac reads it; it is a menu QUOTED in the conversation only when
  Claude's input box is live below it (its frame, only status rows under it) and the menu's rows sit above that box's top rule;
- a thread session is `needs_you` with kind `usage limit` and, when the reset can be read, `resets_at` (the next such moment after
  now, in the screen's time zone when the system knows it, else the supervisor's own); a start onto the screen is never failed
  `needs_mac` (nobody is meant to answer it), and its line is the Mac's words with the attach command for the pane, at most one an
  hour across appearances and restarts (the notice records' window for that kind);
- Main's needs-you is `usage_limit` with the model and the reset, raised at once (no stall to wait out), its notice the same words,
  and Main dropping out of `claude agents` on that screen is not called stuck; `main-restart-check.json` carries it as
  `needs_you` (`usage limit`, with `resets_at`).

**Main's restart on request, on Linux** (`main-request.ts`, `main-restart-check.ts`, `restart-proof.ts`, wired in
`restart-wiring.ts`; the Mac's AgentRecovery, MainRestartCheck and RestartProof, ported). The supervisor holding the lock writes
`main-restart-check.json` as the Mac does (every 5 s, at once on a change; sorted keys, 0600, atomic) and acts on
`agent-request.json`:

- the request is renamed to `agent-request.json.taken`, read (no link, a regular file of at most 4096 bytes) and deleted BEFORE
  anything is decided, so it is acted on at most once, a crash included (a `.taken` left behind is discarded unread at the next
  start); a request older than 5 minutes, more than 1 ahead, dated before this supervisor started, or with a control_id already
  handled is discarded;
- the owner's proof (the phone's signed Restart agent) is checked as the Mac checks it (devices.json, the `talos-owner/v1`
  signature, the canonical frame, the used list and the mark, `restart-proofs-used.json` and `restart-proof-mark.json`, 0600).
  On an unmanaged install the proof separates the owner from an agent acting through the guards, not from arbitrary code running
  as the same user (which can pin its own key in `devices.json`; SECURITY.md), and the tap is accepted up to 2 minutes ahead
  of this clock, as on the Mac. The proofs used, the newest signed time, the 2-minute gaps, the hourly count, the last handled request and
  the line spacing outlive a restart of the supervisor (`restart-actor.json`, 0600, denied to sessions by the guards; code that
  kills the supervisor and rewrites it is outside what this stops). His tap skips the restart check, as on the Mac: only his Stop, his own 2-minute gap and the usage-limit menu (a restart lands
  on it again) refuse it. If the restart then waits at a screen that needs someone at the keyboard (the startup warning on a
  launch root has not approved), that is said at once in the default thread and `last` is `stalled` with its label. A proof
  that claims the owner and does not verify is refused, one fixed line;
- any other request (a session's `restart_main`, a proof whose time this computer does not take) is checked again when it is
  read: the reasons (the protocol's list, as Linux knows them: root's launch approval and its channels, claude found, auto-confirm,
  anyone attached to Main's pane, the takeover check, the owner's Stop, the 2-minute gap, the saved id, and `restart_limit`: 3
  acted on per rolling hour), and any screen Main waits on the owner at (`last.detail` names it). A session's `why` is never in
  the supervisor's own line;
- the restart is a quiet stop and a cold start, followed to `came_back` (Main running, nothing waiting) or `stalled` (a dialog,
  the takeover check, a start that could not be made); the phone lines are at most one of each kind per 2 minutes, one post in
  flight, in this computer's words (the bridge's `restart_main` sentences pick "the Mac" or "this computer" by platform).

### The flow

1. The desktop supervisor reads the pane. A known dialog goes into `workers.json` as `threads.<id>.dialog` (below). It is there
   while the dialog is on the pane. A new dialog, or the same one back after it went away, has a new `id`: **at least 128 bits of
   randomness made by the Mac** (22 or more characters of base64url, or 32 hex), so no one can name a dialog before it is on the pane.
2. The live bridge reads `workers.json` on every poll (and the moment it changes: it watches the folder). A `dialog` whose `id` it
   has not seen, from a fresh supervisor, in a known thread, with the relay listing `needs-you/1`, becomes **one** `kind:'dialog'`
   card (`card.create`, a day from the Mac's first sighting at most: `DIALOG_TTL_S`; it is closed sooner, step 6, when the question leaves the screen). The bridge then writes `dialog-card.json` for the Mac. The
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
7. If nobody answers in a day the card expires. A Mac that still shows the same question offers it again as a NEW sighting (new
   `id`, so a new card; `WorkerReoffer` on the Mac, `offerRanOut` on the Linux supervisor): at most one new card a day per question,
   and an answer is still only ever for the id on the pane now, so a tap on the expired card presses nothing. The bridge waits
   `REOFFER_GRACE_MS` (30 s) after the expiry before it posts the thread line the Mac used to post (`dialogFallbackLine`), and posts
   it only if that very dialog id is still on the pane (an older Mac never offers again): **at most one per dialog** (the record is
   marked before the post, and a post that fails is logged, not retried). The worker is never stopped. The bridge tells Claude
   nothing about any of this: the card is bridge-handled.
   A card that ends WITHOUT an answer taking effect before its day is up does not leave the question with no card: after the owner's verified
   tap pressed nothing the Mac (and the Linux supervisor) end that offer, so the next look at the same dialog on a settled screen makes a new id
   and a new card (each needs a new real tap, so it cannot repeat on its own; a tap that does not prove itself never ends an offer); and when the
   Mac gave no report within `DIALOG_RESULT_WAIT_MS`, the answer could not be handed over, or a tap waited too long for the Mac
   (`mac_offline_too_long`), the bridge makes ONE replacement card for the same dialog id while that id is still on the pane in a fresh
   `workers.json` with time left (never a third, none for a gone dialog, a stale file, or an offer in its last 30 s). One extra push comes with
   a day-long card: the relay's "expires soon" reminder (`card_expiring`) applies to every card of 2 hours or more.
   A card's life is not what keeps a tap safe (a day is long): the card closes when its question leaves the screen, a tap is taken
   only for the exact dialog id on the pane now (a relaunch or a changed screen is a new id), the tap's own signed time is within
   15 minutes of the Mac's clock (`DialogProof.maxAgeMs`, unchanged), and a Mac that is down answers nothing (the bridge withdraws
   the answer file after `DIALOG_RESULT_WAIT_MS` and the card ends "not confirmed"). A starting worker that waits at a dialog is
   still stopped after `dialogLimit` (900 s), which closes its card. The Mac's own safety and API-key popups never become cards and
   keep 15 minutes. A bridge from before this change cuts its card at 15 minutes whatever the Mac's `expires_at` says, and a Mac
   from before it never offers again: each pairing behaves as it always did.

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

| File (writer → reader)                                 | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers.json` `supervisor.main_dialog` (Mac → bridge) | Main's own dialog, the development-channels warning, in the same shape as `dialog` below with `kind: dev_channels`, `subject` = the channels (comma separated) and, when the guard refused because Main's start command is not the confirmed one, `launch_changed`: a list of `folder\|program\|flags\|env` (names only; empty = not confirmed yet). The bridge makes the card on the default thread; the card and result files are in `workers/<default thread>/`; Main's answer is `main-dialog-answer.json` there, apart from a worker's `dialog-answer.json`. Not read from a worker's pane                                                                                                                                       |
| `workers.json` `threads.<id>.dialog` (Mac → bridge)    | `{ id, kind: trust\|mcp_consent\|login, subject: string\|null, options: string[], cursor: int\|null, seen_at, expires_at }`. `expires_at` = `seen_at` + 86 400 s (a day; an older Mac wrote 900 s, and a reader takes whatever the file says). `options`: 1 to 6 labels of at most 120 characters (none for login); `subject` at most 500. Anything that does not fit reads as "no dialog" and the rest of the file stays valid                                                                                                                                                                                                                                                                                                       |
| `dialog-card.json` (bridge → Mac)                      | `{ v:1, dialog_id, card_id, thread_id, status: waiting\|answered\|closed\|expired, by?, label?, at }`. Written when the card is made and rewritten when it changes. **The Mac posts its old thread line only when no such file naming this dialog appears within 15 s of first seeing it** (`DIALOG_CARD_WAIT_MS`: one whole 10 s poll plus the write; the bridge normally makes the card within a second of `workers.json` changing). An old bridge, a relay without `needs-you/1` or a bridge that is down never writes it, so those get today's behaviour. While a file for the dialog exists the Mac posts no line for it; the bridge posts the expiry line. **Display only**: a forged one can only hide the Mac's fallback line |
| `dialog-answer.json` (bridge → Mac)                    | `{ v:2, dialog_id, choice\|action:'open', label, by, at, control_id, proof }`, strict, at most 16 KiB. `choice`, `action`, `label` and `by` are for display and logging only. `proof = { signed, osig, device_id, binding }`: see "How the Mac verifies an answer". The Mac acts once per `dialog_id`, deletes the file, and always writes `dialog-result.json`                                                                                                                                                                                                                                                                                                                                                                       |
| `dialog-result.json` (Mac → bridge)                    | strict: `{ v:1, dialog_id, control_id?, source: card\|mac, outcome: pressed\|nothing_pressed\|opened, choice?, label?, reason?, at }`. `source:'card'` answers one bridge answer (`control_id` required; `pressed` carries `choice` and the `label` the screen showed; `nothing_pressed` carries `reason`: `screen_changed`, `already_answered` or `unverified`). `source:'mac'` is a popup press (no `control_id`; `pressed` or `opened`). The bridge deletes the file once used                                                                                                                                                                                                                                                     |
| `dialog-proofs-used.json` (Mac only)                   | `{ v:1, used: string[] }`, the newest 64. Each entry is `<dialog_id>\|<sha256 of proof.signed>`, for every proof that checked out, written before any key is sent. A copy of a tap (the same signed text, however its signature is spelled) is answered `already_answered`, after a relaunch too. The bridge never reads it; its guard keeps tools off it                                                                                                                                                                                                                                                                                                                                                                             |
| `main-dialog-proofs-used.json` (Mac only)              | The same list for Main's development-channels card, beside `main-dialog-answer.json` in the default thread's folder, kept apart from a worker's on that thread                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

## Why a message waits (and when Main answers)

A message for a thread session that is alive waits for it up to 10 minutes (3 when the session is being started for it); a thread with
no session goes to Main at once, and a session that fails or is being stopped during the wait hands the message to Main then (a supervisor
heartbeat counts as gone only when the same stale one, more than 45 s old, was also seen at the poll before). A session that was live or busy
for the message and then ends as `parked` or `off` without having read it (a crash, a cut turn) is woken ONCE more by the hub (its wake is
written again, so the supervisor resumes it and types the pointer); the one re-wake is recorded in SQL (`route_rewake`), so a hub restart or a
second hub adds none. A second death, or a session the owner stopped (`stopped_why` `owner`), goes to Main at once with the usual row; a
thread that was only ever being started is not this case. The re-wake is the hub's, so it is the same for the Mac and the Linux supervisors. The thread shows one status line while it waits, picked again on every hub tick and
taken down (`idle`) when the message is claimed or Main takes it. Only the owner's own messages and card taps show it, never a
scheduled run or a session's own wake timer:

| What the entry says                               | Line while it waits                                | Row when Main takes it at the deadline                               |
| ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `needs_you` set                                   | none (the phone already says what it waits on)     | `<thread> was waiting for you, so the main agent answered.`          |
| `pointer_hold` `typed_unseen`                     | `<thread> is waiting for you: not picked up`       | the same "was waiting for you" row                                   |
| `pointer_hold` `draft`                            | `<thread> is waiting for you: unsent text`         | the same                                                             |
| `pointer_hold` `scrolled`                         | `<thread> is waiting for you: scrolled back`       | the same                                                             |
| `pointer_hold` `refused`                          | `<thread> can't take messages right now.`          | `<thread> couldn't take messages, so the main agent answered.`       |
| `pointer_hold`, a reason this build does not know | `<thread> is waiting for you.`                     | the "was waiting for you" row                                        |
| state `busy`, no hold                             | `<thread> is busy; it'll see this when it's free.` | `<thread> was busy, so the main agent answered.`                     |
| anything else                                     | none                                               | the usual "Thread session didn't pick this up (...). Main answered." |

A status label is at most 80 UTF-16 units (`ThreadStatus.label`), so a long thread name is cut on a whole character and ends in an
ellipsis; the words after it are never cut.

`pointer_hold` is `{reason: 'typed_unseen' | 'draft' | 'scrolled' | 'refused', since: ISO-8601}` on the workers.json entry. Both
supervisors write it as soon as a hold starts; the exact rules are the doc comment on `WorkerPointerHold` in
`packages/protocol/src/thread-sessions.ts` (precedence typed_unseen > draft > scrolled > refused; `since` fixed while the same hold
goes on; written only while a pointer is owed and the session has a pane). The supervisor no longer posts its own "your message has
probably gone to the main session" lines for these holds: the hub's line and row above replace them. A card tap held for a session
that never claims it goes to Main at the deadline like any other message (the routing table above).
