# The Terminal pane (Mac app)

The Terminal pane is the owner's own shell, shown beside a thread in the Talos window of the Mac app. It is a native view
(SwiftTerm) laid over a slot the web app reserves. On every other device the slot shows "Terminal is available in the Talos
Mac app".

It is not the agent's terminal. The agent's terminal is the Terminal _screen_ (`terminal_view`, `docs/desktop.md`), a viewer
on the agent's tmux session. The pane is the owner's login shell on a pty the Mac app owns. It never attaches to
`tmux -L talos`, and there is no tmux socket behind it.

## Who does what

| Side                                  | Does                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Web app (`apps/web`)                  | Lays out the pane column and the pane toolbar, reserves the Terminal slot, reports where the slot is.     |
| Mac app (`apps/desktop`)              | Starts the shells, draws them and their tab strip over the slot, takes the owner's keys, ends the shells. |
| Relay, bridge, agent, protocol frames | Nothing. They do not know the pane exists (`ShellPaneReachTests`).                                        |

## The contract (web app to Mac app)

Both messages go over the existing bridge, `window.webkit.messageHandlers.talos.postMessage(obj)`, and are defined in
`packages/protocol/src/native.ts` (`NativeShellPane`, `NativeShellPaneClose`). Both schemas are strict: a field that is not
listed here makes the Mac app refuse the whole message. There is no message from the Mac app to the page about the pane.

### Does this app have the pane?

The Mac app lists `shell-pane` in its user agent: `… TalosDesktop/<version> TalosFeatures/pick-folder,shell-pane`
(`SHELL_FEATURE_SHELL_PANE`; `shellFeatures()` in `apps/web/src/lib/native/shell.ts` reads the list). When it is absent (an
older Mac app, a browser, the phone) the page sends neither message and shows its own placeholder text in the slot.

### `shell_pane`: where the slot is

```json
{ "type": "shell_pane", "thread_id": "trip", "rect": { "x": 760, "y": 420, "width": 520, "height": 360 } }
{ "type": "shell_pane", "thread_id": "trip", "rect": null }
```

| Field       | Type                                            | Meaning                                                                                                                                                                      |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_id` | thread id (`^[a-z][a-z0-9_]{0,31}$`, not `all`) | The thread whose pane this is. Required. For Main, the id of the thread Main is showing.                                                                                     |
| `rect`      | `{x, y, width, height}` or `null`               | Required. The slot in CSS pixels from the top-left of the page (`getBoundingClientRect()`, rounded to whole numbers, each 0 to 20000). `null` = the slot is not visible now. |
| `cwd`       | absolute path, at most 512 characters           | Optional, and unused: the page's idea of the thread's folder. It is checked for shape and dropped. See "Where the shell starts".                                             |
- Visible is `rect !== null`. Send `null` when the Terminal tab of the pane is not in front, a dialog or sheet covers it,
  the column is collapsed, or the route leaves the thread. The shells keep running while hidden.
- Send it again whenever the slot moves or changes size (`ResizeObserver`, scroll, window resize, layout change), and once
  after every `ready`: the Mac app forgets the slot when a new document loads.
- Switching threads is one `shell_pane` with the new `thread_id`. The other thread's shells stay as they were and come back
  when its id is sent again.
- The first `shell_pane` with a rect for a thread that has no pane open starts that thread's first shell.
- The slot must be at least 20 columns by 4 rows of terminal text plus a 26-pixel tab strip (about 180 by 110 pixels).
  Smaller, and the Mac app shows nothing, so keep readable placeholder content in the slot.
- The native view covers the slot completely and is opaque. Anything the page draws inside the slot is hidden while the
  pane shows; anything the page draws over the slot (a menu, a tooltip) is hidden too, so send `rect: null` while one is open.

### `shell_pane_close`: the owner closed the pane

```json
{ "type": "shell_pane_close", "thread_id": "trip" }
```

Ends every shell of that thread's pane, whichever thread is on screen. Opening the pane again (`shell_pane` with a rect)
starts a new shell. Send it only for the owner's own close action, not for a route change or a hidden tab.

### What is deliberately not in the contract

No field for input, keys, a command, arguments, an environment, a tab, or focus, and no message that returns anything a
shell printed. Tabs (the `+`, selecting, closing one) are native controls inside the slot, so the page never needs to name
one. Which panes are open for a thread is the web app's own layout state; the Mac app keeps each thread's shells alive
while its pane is open, which is the native half of "the layout is remembered per thread".

## What the Mac app does

- **The shell** is the owner's login shell: the account's shell (`pw_shell`), else `$SHELL`, else `/bin/zsh`, started with a
  leading dash in `argv[0]` so it reads the owner's profile. No command or argument is passed to it.
- **Where the shell starts** is read from this Mac, never from the message: for a thread that has its own session
  (`session: "dedicated"`), the thread's folder in `$TALOS_APP_HOME/config.json` (`session_opts.cwd`; a sub-thread that sets
  none takes its parent's); for every other thread, Main's among them, the agent folder (`agent_dir` in `desktop.json`);
  home when neither exists. A folder that does not exist falls through to the next. `ShellPane.folder`. A `cwd` on a thread
  without its own session is not used: the bridge checks a folder (refused roots, on disk) only for a thread with its own
  session, so nobody ever checked that one.
- **The environment** is the Mac app's own, without what a Claude Code session or a Talos session leaves behind
  (`ClaudeEnvScrub`, the same scrub the agent's launch uses, and then every `TALOS_` variable and
  `MCP_PROTOCOL_NEGOTIATION`) and without `desktop.json` `env`, which is the agent's. The login shell reads the owner's
  profile on top, so what the owner exports there is present. `ShellPane.environment`.
- **Tabs.** `+` starts another shell in the same folder, up to 6 per thread and 16 in the app. Closing a tab ends that
  shell. A shell that exits by itself (`exit`) removes its tab; the last one leaves a note and the `+`.
- **How often the page may start a shell.** The first shell of a pane starts on the page's `shell_pane`, and each start
  runs the owner's login profile, so those starts are held to 12 a minute across the app. Past that the pane shows a
  sentence and the `+`, which is the owner's own and is never held back.
- **The keyboard** goes to a shell when the owner clicks in it, selects its tab, or presses `+`. Nothing the page sends
  moves the keyboard into a shell. When the page hides a pane whose shell held the keyboard, the keyboard goes back to
  the page, as it does for the agent's terminal.
- **The clipboard.** What a shell prints cannot set the Mac's clipboard or have the clipboard typed into the shell: the
  pane refuses the terminal escape sequence for it (OSC 52 and the Kitty clipboard protocol, `ShellClipboardGuard`). Copy
  and paste with the owner's own keys and menu work as in any terminal.
- **Hide and end.** Hidden (shells keep running): `rect: null`, a window that is closed to the menu bar, a page that
  reloads or says it is signed out. Ended: `shell_pane_close`, closing a tab, Sign out and Forget this Mac in the Mac app
  (after either, no pane opens until a new page has loaded), and quitting the app (the ptys close with the process, which
  hangs the shells up; there is no code for this and no test). Ending sends a hangup to the shell and to the terminal's
  foreground job, then kills a shell that is still there two seconds later; until then it still counts toward the 16.
- **Failure.** A shell that cannot start, or ends with an error within a second of starting, leaves a sentence in the pane
  that says so and names the shell. Reaching a limit says so too.

## No remote path to the shell, but one owner-clicked Run

The claim: nothing in the page, the relay, the bridge, any message or any screen tool can put a byte into the shell, read what
it prints, choose what it runs or its environment, or move the owner's typing into it, with ONE exception: a Run the owner
clicked in this Mac app's own window (below). What a shell reads is what the owner types or pastes into the native view, that
Run, and the terminal's own answers to a program that asks it something (where the cursor is, what kind of terminal it is).

**Run in Terminal (owner, 2026-11-18).** In the Mac app, the ▶ on a shell block in an agent message opens this thread's pane
and runs the block there, one click, no second ask (the owner's rule: a tap is the approval; a script with characters beyond
plain ASCII still asks twice, as every Run does). It is the signed Run of `docs/SECURITY.md` ("Run button") with
`run_where: 'pane'`, and it reaches the shell only along this path:

- The bridge consumes it exactly like any Run (its shape, `run_block`, its ages, once per tap's message id), then, instead of
  handing it to the agent, hands `{thread_id, script, client_msg_id}` to the Mac app over the app's own local channel. It is
  never re-routed to the agent if the app refuses.
- The Mac app writes into that thread's pane only if it holds a **witness** for exactly that `thread_id`, `client_msg_id`
  and the sha256 of the script's UTF-8 bytes as received: the page sends `run_witness` right after the Run, and the app
  records it only if a real human click, Return (the keypad's Enter too) or Space reached the page's web view in its key window within
  `RUN_PANE_CLICK_MS` (2 s), told apart from synthetic input as in item 7 below; keys typed into the Terminal pane itself and
  the click that only makes the window key do not count. Neither does a mouse press within 0.5 s of the app becoming active
  or the Talos window becoming key; that is the press that brought it forward. One activation
  mints at most one witness; a witness is used once (a hash that does not match burns it too), lives 30 s, and the table
  holds 16 at most, in memory only, refusing a new one when full. A Run that arrives before its witness waits 1.5 s at most.
- The app refuses (`bad_script`) a script with ESC or any other control character but line feed and tab (so nothing can end
  the paste early), a bidi control or zero-width character, an empty script, one without a final line feed, and one over 4000
  characters.
- The app writes only when the shell is at its line editor: the terminal's foreground process group is the shell's own and
  the shell has turned on bracketed paste (mode 2004). A shell that is still reading its startup profile, is in a builtin
  such as `read`, `vared`, `wait` or `select`, or has a program running (vim, ssh, a REPL) is not at its line editor. Such a
  Run waits up to 5 s, re-checking, and is then refused `pane_busy` with nothing written (`not_started` if the shell never
  started). So nothing, not even the Ctrl+C below, reaches a program the owner has running.
- Once the shell is at its line editor, and before pasting, the app sends Ctrl+C to discard whatever is already on the
  shell's line, a half-typed command or an open continuation, so a script is never appended to someone else's input. It
  then pastes only once the shell has answered it, that is, it has printed something since, been quiet for 50 ms and is
  back at its line editor, within 3 s; otherwise the Run is refused `pane_busy` and nothing more is written.
- The write is always one bracketed paste of the script (one trailing line feed dropped) and then exactly one Return; there
  is no typed path, so a tab in a script is pasted, not completed, and is allowed.
- One pane Run at a time per shell. A pane Run has 10 s in all from when the app takes it; the app never writes after
  that. The bridge waits 12 s for the app's answer; on a timeout or an answer it cannot read, the thread says "Talos.app
  didn't answer in time; check the terminal pane before running it again" (not "Nothing was run": the write may have
  happened).
- Every pane Run that reaches the app ends in a `run_result` from the app to the page (no text: ran, or refused and why;
  never a reason beside ok), so the screen never says a refused Run ran. One the bridge refuses itself (too old, a reset history) leaves its line in the thread, and the page stops waiting after 30 s and points there. The page sends a pane Run only while the Mac is connected: it is never queued to arrive after its
  witness has gone. The bridge never hands a pane Run to the agent instead, whatever the app answers. A pane Run is accepted
  in a dedicated thread too (no agent is involved); an ordinary Run there is still refused.
- So a Run signed on a phone or in a browser (never witnessed here), or by a script with no click in this window, never
  reaches the shell; it fails with a visible line.

What this Run adds that the agent's Run does not have: the block runs in the owner's own login shell, without the agent's
action rules, ask rules or permission cards, and without the agent's judgment; the owner's click is the only check.
**Residual risk, accepted by the owner (2026-11-18):** a relay that turned hostile, or a script in the page, inside the Mac
app's own window, can send a witness right after a genuine click of the owner's on anything in that window, for a Run it
signs itself or for any pane Run it can see (one signed on a stolen phone included), and so run one script of its choosing
in the shell per such click. Closing that would take a confirmation the page cannot draw (a native
sheet), which the owner declined: one click.

1. The only messages about the pane are the two above, and they carry geometry and a thread id (`run_witness` carries an id and a
   hash, never text). The decoder refuses any
   other field (`ShellPaneTests`, `packages/protocol/test/native.test.ts`, `scripts/native-fixtures.ts` MUST_REJECT).
2. The bridge accepts a message only from the main frame of the relay's own page, never from an agent page under `/media/`
   or an iframe (`NativeBridge.accept`, unchanged).
3. `OwnerShellPane.swift` writes to a pty in one place only: a Run from the app's local run channel that passed the witness
   check above (Run in Terminal). It has no other call that writes to a pty, and none that reads a terminal's screen,
   evaluates JavaScript, or opens a network or process connection. The window's only calls into it place, hide and close the pane, and the pane object is
   never handed on under another name. The hooks tests use to reach a shell's view are compiled out of the app that ships
   (`ShellPaneReachTests`, a scan of the source that runs in the default suite).
4. There is no native-to-web message for the pane, no relay route, no bridge tool, and no protocol frame other than the signed
   Run's `run_where: 'pane'`, which the bridge only routes (`ShellPaneReachTests`; the run channel is the one way in, and
   it writes only with a witness).
5. The shell runs on a pty file descriptor held by the Mac app, not in tmux, so there is no socket for `send-keys`.
6. With real ptys, every message in the bridge fixtures plus a list of hostile ones is driven through the real decoder into
   the real window controller, and the shells' input stays empty; a line typed through the view then arrives, which proves
   the check can see input. Every one of those shells also prints the clipboard escape sequences, and the clipboard neither
   changes nor arrives as input (`ShellPaneGuiTests`, needs `TALOS_GUI_TESTS=1`).
7. The screen tools (`screen_click`, `screen_key`, `screen_type`) may be allowed to drive Talos itself (`docs/SECURITY.md`, "An
   agent in Talos"), and that is no path to the shell: a synthetic click or key aimed at any terminal view, this pane's
   included, is dropped before it is dispatched (an event monitor, the window's `sendEvent` and the view's own mouse handlers),
   and the tool answers `protected_prompt`. The owner's own keys, through the same window, still arrive
   (`ShellPaneGuiTests.nothingAnAgentTypesOrClicksReachesTheOwnersShell`, `SyntheticInputTerminalGuiTests`).

What this does not claim:

- The relay serves the page, so a relay that turned hostile, or a script in the page, could show or hide the pane, pick
  which thread's shells are in front, open up to 16 idle shells at 12 a minute, slide the opaque view under a click that
  is about to land, or hide the pane and take the keyboard back to a look-alike it draws itself. It could not read a shell. It
  could type into one only through Run in Terminal, right after a real click of the owner's in this window (the residual risk
  above).
- It could change where a dedicated thread's next shell starts, the same way it can change where that thread's agent
  session starts: the folder is a thread setting, saved through the thread patch the bridge checks, and the pane reads the
  folder the bridge wrote. The pane adds no second way to name a folder. A folder is only where the shell starts, but the
  owner's own prompt tooling (a git prompt, direnv, mise) may read files in it.
- The agent runs as the same macOS user as the owner and writes files in the thread's folder, so this feature is not a
  wall between the agent and the owner's processes. It only guarantees that Talos itself adds no path to the shell.
