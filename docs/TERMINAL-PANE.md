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

## No remote path to the shell

The claim: nothing in the page, the relay, the bridge, any message or any screen tool can put a byte into the shell, read what it prints,
choose what it runs or its environment, or move the owner's typing into it. What a shell reads is what the owner types or
pastes into the native view, and the terminal's own answers to a program that asks it something (where the cursor is, what
kind of terminal it is). What holds it:

1. The only messages about the pane are the two above, and they carry geometry and a thread id. The decoder refuses any
   other field (`ShellPaneTests`, `packages/protocol/test/native.test.ts`, `scripts/native-fixtures.ts` MUST_REJECT).
2. The bridge accepts a message only from the main frame of the relay's own page, never from an agent page under `/media/`
   or an iframe (`NativeBridge.accept`, unchanged).
3. `OwnerShellPane.swift` has no call that writes to a pty, reads a terminal's screen, evaluates JavaScript, or opens a
   network or process connection. The window's only calls into it place, hide and close the pane, and the pane object is
   never handed on under another name. The hooks tests use to reach a shell's view are compiled out of the app that ships
   (`ShellPaneReachTests`, a scan of the source that runs in the default suite).
4. There is no native-to-web message for the pane, no relay route, no bridge tool, no protocol frame
   (`ShellPaneReachTests`).
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
  is about to land, or hide the pane and take the keyboard back to a look-alike it draws itself. It could not type into a
  shell or read one.
- It could change where a dedicated thread's next shell starts, the same way it can change where that thread's agent
  session starts: the folder is a thread setting, saved through the thread patch the bridge checks, and the pane reads the
  folder the bridge wrote. The pane adds no second way to name a folder. A folder is only where the shell starts, but the
  owner's own prompt tooling (a git prompt, direnv, mise) may read files in it.
- The agent runs as the same macOS user as the owner and writes files in the thread's folder, so this feature is not a
  wall between the agent and the owner's processes. It only guarantees that Talos itself adds no path to the shell.
