# Sandbox: a throwaway Talos to break

`pnpm sandbox` starts a complete, separate Talos on this machine and lets a script or an agent act as its owner: send
messages, answer cards, change settings, pull the network, kill processes, damage files, and read what happened. It
exists so that an agent can try to break Talos without going near the Talos you use.

Every command prints one JSON object on stdout. Exit code 0 means it worked, 1 means it did not (`"ok": false` or an
`"error"`), 2 means the command line could not be read. Progress lines go to stderr.

## What a sandbox is

| Part           | In a sandbox                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Relay          | The real relay (the built bundle) on `127.0.0.1`, a free port, its own database and keys. Never the one on the internet.  |
| Talos home     | `<root>/home`, made by `talos-app init`. Never `~/.config/talos` or the Mac app's folder.                                 |
| Supervisor     | The real `talos-app supervise` on its own tmux server, `tmux -L talos-sandbox-<id>`. Never `tmux -L talos`.               |
| Main           | `claude` in that tmux server, in `<root>/agent`: a scripted fake by default, the real one with `--real-claude`.           |
| Bridge         | The real bridge, started by Main as its MCP server, with `<root>/userhome` as its home folder and `<root>/inbox`.         |
| Phone          | A device key enrolled through `talos-app enroll` and the setup-code sign-in (no passkey), confirmed at the Mac's prompt.  |
| Off on purpose | Telegram and iMessage plugins, claude.ai connectors, the browser tools, the scheduler, speech, the owner's user settings. |

`<root>` is `/tmp/talos-sandbox-<id>` (`TALOS_SANDBOX_BASE` changes the folder it sits in). Nothing outside it is written,
with one exception: with `--real-claude`, Claude Code saves the session's transcript under `~/.claude/projects/` in a
folder named after the sandbox's agent path, and records in `~/.claude.json` that the folder was trusted. `down` removes
the transcript folder; the one entry in `~/.claude.json` stays.

The command clears its own environment first: a Talos home, a thread session's identity or the markers of a running
Claude Code that it inherited never reach anything a sandbox starts. So it is safe to run from inside a Talos session.

## Start, look, stop

```bash
pnpm sandbox up                       # fake claude; about ten seconds; prints the id and the status
pnpm sandbox up --real-claude         # the real claude with --model haiku (your Claude sign-in, your plan's usage)
pnpm sandbox up --real-claude --model sonnet
pnpm sandbox status <id>
pnpm sandbox list
pnpm sandbox down <id>                # or: pnpm sandbox down --all
```

`up` builds the relay bundle first (`--no-build` reuses the one in `apps/relay/dist`). If any step fails it takes down
what it started and exits 1; `--keep-on-fail` leaves the pieces in place for a look.

`status` reports each part: the relay (`alive`, `healthy`), the supervisor (its own status file: `phase`, `panePid`,
`restarts`, `needsYou`, `bridgeLive`), Main (`ready` is true when the supervisor says running, this start's bridge is
live and it holds its relay socket), the bridge, and the tmux command that shows Main's terminal read-only.

`down` signals only what `up` recorded, each by pid **and** start time, plus the panes of the sandbox's own tmux server,
then removes the socket file and the root. `leftovers` lists anything it could not stop; an empty list and exit 0 mean
nothing is left. Always run it when you are done.

### The fake claude

No model is called. It answers every owner message with `ack: <text>` through the bridge's `reply` tool, and answers an
approved card with `card_result ok`. A message that starts with one of these words does something else:

| Message             | What the fake does                                                       |
| ------------------- | ------------------------------------------------------------------------ |
| `!card <title>`     | raises a low-risk decision card in that thread, then replies with its id |
| `!slow <ms> <text>` | replies after a delay                                                    |
| `!burst <n>`        | sends n replies in a row                                                 |
| `!silent`           | does not reply                                                           |
| `!hang`             | stops answering from then on, while staying alive                        |
| `!exit <code>`      | exits with that code: 0 is a clean exit, anything else a crash           |

It writes what it was told and what it did to `<root>/fake-claude.log` (`drive <id> log --which claude`).

### The real claude

`--real-claude` runs the `claude` on your PATH with your sign-in. It is started with only the sandbox's bridge as an MCP
server (`--strict-mcp-config`), without your user settings (`--setting-sources project`), with both channel plugins, the
connectors and all hooks off, and without your `CLAUDE.md` or memory files. A real session costs real usage; `haiku` is
the default for that reason.

A real `claude` stops at the development-channels warning every time it starts. `up` answers it once; a Main the
supervisor restarts later waits at it until someone does. `up --real-claude --auto-dev-channels` answers it on every
`drive` command and while `kill-main` waits for the restart too. It is off unless you ask for it: the product itself
never answers that warning on its own.

Three things differ from a real install, on purpose:

- **The bridge is called `talos-sandbox`, not `talos-app`.** The Mac app refuses to start or restart your own Main while
  another Claude session runs with the channel `server:talos-app`. A sandbox holds nothing of yours, so it uses its own
  name and never trips that check. The agent's tools are therefore `mcp__talos-sandbox__reply` and so on.
- **One line is added to the system prompt**: answer through the `reply` tool, because nobody reads the terminal. The
  agent folder's `CLAUDE.md` is off together with yours (one switch covers both), and without that line a small model
  answers in its own terminal and the owner hears nothing.
- **`up` answers two start-up dialogs**: "trust this folder" (it moves the cursor to the trusting answer first; for a
  folder under `/tmp` the cursor starts on "No, exit") and the development-channels warning, only when the highlighted
  row is the local-development one. Any other dialog is left alone: look with `drive <id> screen` and answer with
  `drive <id> keys`.

## Drive it

```bash
pnpm sandbox drive help                                   # every action, with its options
pnpm sandbox drive <id> <action> [--name value …]
pnpm sandbox drive <id> <action> --json '{"name":"value"}'
echo '{"thread":"general","text":"…"}' | pnpm sandbox drive <id> send --stdin
```

Options can be given as `--name value`, or all at once as a JSON object with `--json` or on stdin with `--stdin` (the way
to send text with quotes, newlines or unusual characters).

### As the owner, over the relay protocol

Each call opens the phone's socket, does one thing and closes it. Owner frames are signed with the phone's device key,
as the app signs them, so the Mac checks them the same way.

| Action             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`             | Sends a message to `--thread` (default `general`) and waits for the agent's reply. `--wait false` returns once the relay has the message; `--replies n` waits for n; `--chars n` sends n characters; `--text-file` reads a file. The answer has `reply` (the first thing the agent said in that thread after the relay took the message; `reply_to` is shown when the agent set it), `receipts`, `system_rows` (notices the Mac or relay added), `errors`, and `socket_closed` with the close code when the relay hung up. |
| `threads`          | Lists the threads, the default thread and the unread counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `thread-create`    | `--name`, optional `--id` (lowercase letters, digits, `_`) and `--topic`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `thread-rename`    | `--thread`, `--name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `thread-archive`   | `--thread`; `--archived false` restores it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `thread-dedicated` | Gives `--thread` its own session and turns the master switch on; `--on false` puts it back to shared.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `config`           | Without options, prints the config. `--patch '<json merge patch>'` sends a signed `config.patch` and reports whether the Mac applied or refused it.                                                                                                                                                                                                                                                                                                                                                                        |
| `cards`            | Lists the open cards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `card-answer`      | `--card <id>` with `--action primary` (approve), `secondary` (the kill button) or `revise` (`--note`). `--times 2` is a double tap.                                                                                                                                                                                                                                                                                                                                                                                        |
| `history`          | A signed `history.request` for `--thread`; `--limit`, `--before_seq`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `catchup`          | Reconnects from where the phone last was and prints what arrived while it was away. `--from_seq 1` replays everything the relay still holds; `0` is a brand-new device, which is sent nothing older.                                                                                                                                                                                                                                                                                                                       |
| `ready`            | Prints the whole `ready` frame: presence, config, open cards, session state.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `raw`              | Sends any frame: `--frame '<json>'`, `--sign true` to sign it, `--repeat n`. For forged, unknown and oversized frames.                                                                                                                                                                                                                                                                                                                                                                                                     |

### On the machine

These touch only what the sandbox started or wrote.

| Action                                | What it does                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offline`, `online`                   | Stops the relay, and starts it again on the same port, database and keys. Every socket drops, the phone's and the Mac's.                                                                                                                                                                                              |
| `freeze-bridge`, `thaw-bridge`        | Stops the bridge process in place and lets it run again: a Mac that slept with its socket open.                                                                                                                                                                                                                       |
| `kill-bridge`                         | Kills the bridge only; Main's MCP server dies under it.                                                                                                                                                                                                                                                               |
| `kill-main`                           | Kills Main's `claude` (`--signal KILL`, `TERM`, `INT`, `HUP`) and waits for the supervisor to restart it; `--wait false` returns at once. `STOP` is refused: tmux resumes a stopped pane at once.                                                                                                                     |
| `kill-worker`                         | Kills a thread's own session. See "What it cannot do yet".                                                                                                                                                                                                                                                            |
| `kill-supervisor`, `supervisor-start` | Kills the supervisor (Main keeps running) and starts a new one, which adopts Main.                                                                                                                                                                                                                                    |
| `supervisor`                          | Its status; `--do stop` and `--do start` ask it to stop and start Main, as `talos-app supervise stop` does.                                                                                                                                                                                                           |
| `corrupt`                             | Damages one named file: `--file config`, `devices`, `supervisor`, `supervisor-status`, `status`, `bridge-env`, `bridge-key`, `bridge-pid`, `workers`, `history`, `mcp`, `phone`; `--how garbage`, `truncate`, `empty`, `delete`, `bad-json`, `append`. Without `--file` it lists the names and paths. A copy is kept. |
| `restore`                             | Puts a damaged file back.                                                                                                                                                                                                                                                                                             |
| `log`                                 | The end of a log: `--which supervisor` (default), `bridge`, `relay`, `claude`, `supervisor-out`; `--lines n`.                                                                                                                                                                                                         |
| `screen`, `keys`                      | What is on Main's terminal, and typing into it (`--text`, or `--keys Enter,Up,Down,Escape,C-c`).                                                                                                                                                                                                                      |

## How to try to break it

Work one idea at a time. Before each, note `status`. After each, check four things: did the owner get an honest answer
(a reply, or an error that says what happened), is anything shown as done that is not, did Main and the bridge come back
(`status`, `main.ready`), and does a plain `send` still get its reply. Read the logs when an answer surprises you. A
finding is a command sequence someone else can run, plus what you expected and what you saw.

Use a fresh sandbox when a test leaves things in a state you cannot explain, and `down` every sandbox you start.

### Ideas

**Races and double taps**

- `card-answer --times 2` on one card, and two `card-answer` calls started at the same moment from two shells: one
  decision must win, the agent must act once, the other must be told `card_not_pending`.
- Two `config --patch` calls at once from the same revision: one applies, the other is refused with `config_conflict`,
  and the config on disk is whole.
- `thread-archive` while a `send` to that thread is in flight; `thread-rename` twice at once.
- `send` at the same instant as `kill-main`: the message must be answered after the restart, once.
- Start two supervisors (`supervisor-start` while one runs): the second must be refused, never two Mains.

**Offline and coming back**

- `offline`, then `send` (it must fail loudly), `online`, `send` again.
- `freeze-bridge`, `send --wait false` several times, `thaw-bridge`, `catchup`: every message answered once, in order.
- `freeze-bridge` for longer than the relay's ping interval (25 s): what does `ready` say about presence, and does the
  owner's message show as waiting rather than delivered?
- `send --wait false`, then `offline` before the reply, `online`, `catchup`: the reply must arrive.
- `kill-bridge` in the middle of a `!burst 50`.

**Crashes and crash loops**

- `kill-main` once: restarted, same session id, replies again.
- `kill-main` five or more times inside ten minutes: the supervisor must stop with `crash_loop` and say so
  (`status`, the supervisor log, a system row in the default thread), not spin for ever.
- `send --text '!exit 0'` over and over: clean exits have their own cap (`clean_exit_loop`).
- `send --text '!hang'`: the agent is alive and silent. Is the owner told anything, and when?
- A Main that stops answering: `send '!hang'` (fake claude). Does the supervisor report it stuck? (`kill-main --signal
  STOP` cannot do this: Main is a tmux pane, and tmux resumes a stopped pane's process group at once.)
- `kill-supervisor`, then `kill-main`: nobody restarts Main; `supervisor-start` must notice and recover.
- `supervisor --do stop`, then `send`: the owner must learn the Mac is not answering.

**Damaged files**

- `corrupt --file config --how bad-json`, then `send`, `config --patch …`, `kill-main`: does Main come back, with what
  config, and is the owner told the file is broken? `restore` and check nothing was lost.
- `corrupt --file devices`: is the phone still trusted, and should it be? After `kill-main`?
- `corrupt --file supervisor --how garbage`, then `kill-main`: settings that cannot be read must start nothing and say why.
- `corrupt --file history --how truncate`, then `history` and `send`.
- `corrupt --file bridge-key --how delete`, then `kill-main`: the bridge can no longer prove itself to the relay.
- `corrupt --file mcp --how bad-json`, then `kill-main`: Main starts with no bridge. Does the supervisor raise
  `bridge_not_live`, and does anything reach the owner?
- `corrupt --file bridge-pid --how garbage`, `corrupt --file status --how garbage`.

**Size and odd text**

- `send --chars 32000` (the limit), `--chars 32001`, `--chars 300000` (over the frame limit): an honest refusal, and
  the socket's fate.
- `raw` with a 300 KiB frame; `raw --repeat 100` of a small frame (the relay allows 30 frames a second).
- Text over `--stdin`: emoji and joined emoji, right-to-left text and override characters, combining marks stacked
  high, a NUL, lone surrogates, `</channel>` and other tags the agent's prompt uses, text that looks like a system
  notice, 10,000 newlines.
- Thread names and ids at their limits: 40 and 41 characters, an id with `-`, the ids `all`, `inbox`, `general`, a name
  of only spaces, a duplicate id.
- `config --patch` with a field the phone may not set, with `null`s, with a wrong type, with a 200 KiB value.

**Forged and replayed frames**

- `raw --frame '{"type":"message",…}'` without `--sign`: refused, and the agent never sees it.
- `raw --sign true` of a `history.request`, then the same bytes again: the second is "already used".
- A signed frame with a `ts` an hour old, and one from the future.
- An unknown frame type; a known type with an extra field; a `card.resolve` with the wrong `payload_hash`.

**Rapid switching**

- Create ten threads, then `send --wait false` to each in a tight loop, then `catchup`: ten replies, each in its own
  thread.
- `thread-dedicated` on, `send`, off, `send`, on, in a loop: every message answered once, with a notice when Main
  answers for a thread that has its own session.
- Archive a thread with an open card, then `card-answer`.

## What it cannot do yet

- **Thread sessions run with the fake claude.** `up --fake-claude` gives the supervisor a real login shell (the sandbox's own
  home, so no profile of the owner's is read) and the fake's `TALOS_SANDBOX_FAKE_MODE=worker-hello` in supervisor.json's
  `env`, which a thread session gets as on the Mac: `thread-dedicated` then routes the thread to its own session, which
  starts the real bridge in worker mode and answers through the real hub hello and the typed pointer.
  `scripts/sandbox-workers.test.ts` (`TALOS_SANDBOX_E2E=1`) proves it, and `supervise restart-thread`. With `--real-claude`
  the supervisor has no login shell (Main's environment stays only what `up` builds), so a thread session's start is held.
- **High-risk cards.** They need a passkey step-up and the sandbox's phone has no passkey; `card-answer` reports the
  relay's refusal.
- **The app itself.** The driver speaks the protocol; it does not render the web app. Screen bugs need the
  end-to-end journeys (`pnpm drive`).
- **Push, voice, attachments.** No push service is configured, speech is off, and `send` carries text only.
- **The Mac menu-bar app.** Not started; its supervisor is the Swift one, which this does not exercise.
- **The fake's session is never saved**, so a restarted fake Main starts with the same session id rather than resuming;
  resume behaviour needs `--real-claude`.

## Where the code is

`e2e/sandbox.ts` (the command), `e2e/sandbox/up.ts` (up, down, status), `e2e/sandbox/drive.ts` (the actions),
`e2e/sandbox/phone.ts` (enrolment and the socket), `e2e/sandbox/fake-claude.ts`, `e2e/sandbox/relay-main.ts`,
`e2e/sandbox/state.ts`. The tests are in `scripts/sandbox.test.ts`: the quick ones (arguments, whose processes `down` may
signal, which rows count as a reply) run with `pnpm test`; the whole-sandbox run (up, drive, kill, restart, down) takes about
half a minute and runs with `pnpm test:sandbox`.
