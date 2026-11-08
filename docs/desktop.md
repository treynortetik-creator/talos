# The Mac app (Talos.app)

A small menu-bar app for your Mac. It is optional: everything in [`SETUP.md`](SETUP.md) works without it. What it adds:

- **It runs your agent for you.** Talos starts `claude` inside a tmux session, presses Enter on the development-channel
  dialog, and starts it again (resuming the conversation) if it crashes. Without tmux the agent still runs, but it stops
  when you quit Talos.
- **A menu-bar icon that tells you the truth**: the session, the bridge and the relay each report separately.
- **Windows**: the Talos web app in its own window, the agent's terminal, and a quick-compose panel you can open from any
  app with a hotkey (default Control-Option-Space).
- **Notifications** with fixed text only ("New reply in General"), never message content.
- **A desktop companion** (off until you turn it on): a small figure that shows when the agent is working or needs you. When idle it breathes, blinks, fidgets and takes short walks along its line, and nine times a day, spread across the whole 24 hours (quiet hours included, at least 40 minutes apart), it goes on a longer round; "Rounds and little moments" in settings turns the fidgets, walks and Rounds off; the breathing, blinks, ember, direct reactions, dozing off and waking stay.

It is built from source on your Mac. There is no download.

## What you need

- A Mac on macOS 14 or newer, with the Swift command line tools (`xcode-select --install`). You do not need Xcode.
- The bridge installed and working: [`SETUP.md`](SETUP.md) steps 1 to 4. Use the bridge from this same checkout.
- `claude` (Claude Code) on your PATH.
- Optional but recommended: `tmux` 3.2 or newer (`brew install tmux`), so the agent keeps running when you quit or update
  Talos.

## Build and install

From the repository folder:

```bash
apps/desktop/scripts/make-signing-identity.sh   # once, optional: a free local certificate (one password prompt)
apps/desktop/scripts/build-app.sh               # builds apps/desktop/.build/app/Talos.app
apps/desktop/scripts/install.sh                 # copies it to ~/Applications and opens it
```

- The certificate matters because macOS ties its privacy grants (Desktop folder, microphone, and so on) to how an app is
  signed. An unsigned (ad hoc) build looks like a new app after every rebuild, so macOS asks again each time. Set
  `TALOS_SIGN_ID` to use a different identity.
- `build-app.sh` ends by verifying the signature and running the app's self-test; if either fails, so does the script.
  `--release` builds the optimised version.
- `install.sh` installs for you only (it refuses `/Applications`, `/System` and the other system folders). It replaces an
  existing Talos, and refuses to touch any other app called `Talos.app`. If Talos is running it asks it to quit first (a
  tmux agent keeps running) and reopens the new copy. `--dest <folder>` picks another folder, `--no-open` and `--no-quit`
  do what they say.

## First run

1. Open Talos. With no settings yet it shows the **Set up Talos** checklist: green rows for what is installed, one line of
   fix for the rest. Nothing blocks. Menu, **Setup checklist** reopens it.
2. **Agent folder**, the first row: type or Browse to a folder, then press one of three.
   - **Create** runs this clone's `install.sh` for a new Talos agent (the folder must be new or empty, or already a Talos
     agent, which is left as it is; it refuses a folder that is not empty and not a Talos agent, and a cloud-synced one; it
     never deletes). If it stops part-way it says so and
     leaves the folder for you to move aside.
   - **Adopt** connects a Claude Code folder you already use. A card shows what would change; **Connect** changes only the
     folder's `.mcp.json` (your other servers stay) and, if you have MCP apps, their hooks in `.claude/settings.local.json`.
     CLAUDE.md, `memory/`, `wiki/` and your skills are never touched. Invalid JSON changes nothing, and a `talos-app` entry
     that runs another clone is replaced only if you say so. A kit 1.x folder also gets a card offering to show what
     `kit/scripts/upgrade.sh --into <folder> --dry-run` would change.
   - **Choose** uses a Talos agent folder you already have. It refuses a folder that is gone, unreadable, a link, part of the
     agent folder Talos already uses, or not connected to this Talos yet (use Adopt, which asks before it points a folder wired to another clone or home at this one). A file, or an empty box, is refused too.

   On first setup each one saves your folder, flags and environment in `~/Library/Application Support/Talos/desktop.json`
   (readable by you only) as its last step, then starts the session unless Claude is not signed in. After setup they change
   only the folder, which applies the next time the agent starts. Adopt runs `talos-app adopt` through the
   same small terminal Sign in uses, because it only runs in a real terminal. Create, Adopt and Choose need the whole clone Talos
   was built from (install.sh, the bridge and the Talos mod); if it has moved or is partial, the row says so. A different
   agent folder starts without the old folder's session id and first-start confirmation.

   Your own launch command still works: **Session**, paste the whole `claude ...` line (including your existing flags) and
   press Import; it saves and starts the session. **Find a running session** reads the folder, flags and session id of a
   session that is already running in Terminal; it cannot read environment variables, so Import the command first if
   yours sets any.
3. **Permissions**: press each **Ask now** and approve; add Talos to Full Disk Access, Accessibility and Screen Recording
   if you want the agent to use them.
4. **Sign in**: menu, **Sign in...** pairs the Talos window with your relay as another device. It runs
   `talos-app enroll --label "Mac app"`, shows four words, and you type `y` in the small terminal pane when they match
   (the same check as [`SETUP.md`](SETUP.md) step 5).
5. Quit the Terminal session, then Start session in Talos. The first time, the pane shows the development-channel warning;
   Talos presses Enter for you from then on (after you confirmed it once yourself).

While the same agent is still running in Terminal, Talos refuses to start a second one ("another session holds the
channels"), so a chat channel does not lose its connection by accident.

## What the menu bar shows

| Icon                 | Means                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| Talos's head         | The session is up, the bridge is connected and the relay answers        |
| Head with pulse arcs | The agent is working                                                    |
| Head with a dot      | Something needs you: a dialog in the pane, or a card waiting in the app |
| Head with a slash    | The session, the bridge or the relay is down                            |
| Faint head           | The session is up but the bridge or relay cannot be confirmed           |

The icon is Talos's helmeted head, drawn in one colour so macOS tints it for light and dark menu bars.

The first lines of the menu spell it out: `Session: busy`, `Bridge: ...`, `Relay: reachable`, `Needs you: N`.

The Bridge line is read from `$TALOS_APP_HOME/status.json`, which the live bridge rewrites every 15 seconds and whenever
its connection changes (see [`bridge.md`](bridge.md), "status.json"). It says healthy only if the file is under 45 seconds
old, the process in it is still running, it is the live bridge, and it is connected to the relay. **A bridge that was
already running before you updated never wrote that file: restart the agent once** (Quit and stop the agent, Start session)
and the Bridge line leaves "unknown". `talos-app status` and `talos-app status --json` show the same facts from a terminal.

## Everyday use

| I want to...                                                   | Do this                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Open the app in a window                                       | Menu, **Show Talos**. Closing the window only hides it.                                                          |
| Read Help                                                      | Menu, **Talos Help** (or Help, Talos Help at the top of the screen). It opens the Help page in the Talos window. |
| See or type into the agent                                     | Menu, **Terminals…**. It is the real session; closing the window does not stop the agent.                        |
| See the agent or a thread's session in the Talos window        | Sidebar, **Terminal** (Mac app only), then the tabs across the top (below). Leaving it ends only the view.       |
| Send a quick message from any app                              | The compose hotkey, type or dictate, Command-Return. Esc closes without sending. Change it in Hotkeys.           |
| See a thread's own session, or answer a question it stopped on | Menu, **Terminals…**, then pick the thread in the sidebar (below).                                               |
| Stop or restart the agent                                      | Menu, **Stop session** / **Restart session**. **Quit and stop the agent** also ends the session.                 |
| Start Talos when I log in                                      | Settings, General. Off by default.                                                                               |
| Turn the companion on                                          | Settings, **Talos on screen**, or the menu.                                                                      |
| Update Talos                                                   | Build again and run `install.sh`; a tmux agent keeps running through it.                                         |
| Go back to running it in Terminal                              | Menu, **Copy Terminal command**, then **Quit and stop the agent**, then paste the command in Terminal.           |

## How a new reply reaches you

With the companion on, a new reply in a thread comes from him, not from a macOS banner:

- His bubble shows the thread name in capitals with "new reply" ("WORK · new reply"), the first line of the reply (cut with "…"), and two buttons. **Open**, or a click on the bubble, takes you to that thread. **Later** puts it away; the reply stays in Talos.
- It stays until you press Open or Later, or for 30 seconds. A pointer on him or on the bubble holds it, and a new reply restarts the clock.
- Several replies at once make one bubble, such as "3 new replies: Work, OC Test…". Open then goes to Home, which shows them all.
- **What is on screen.** The first line is asked of the Talos page when the reply lands, shown in his bubble, cleared when the bubble goes, never put in a notification and never stored. The bubble is a window on your screen like any other: a screenshot, a screen share or a mirrored display can show it. The app asks macOS to leave it out of captures, but does not rely on that and does not promise it. If the text of a reply must never be seen, turn him off or snooze him.
- **While you work in the Talos window**, the page decides. A reply it would have shown as its own jump banner (another thread than the one on screen, a thread that notifies, a fresh reply; a card page counts as its thread) is held for him instead. He is told what is held, takes each one into his bubble, and tells the page which ones he showed, so you get one delivery, not two. A reply that lands while its thread is mid-turn waits for the turn to end, so the first line is the real one. He ignores the 60 second pause the plain bubble has. A drag does not lose it: it shows when you drop him.
- **A reply is never lost.** Every reply the page holds ends as exactly one of: his bubble, a macOS banner he posted, or the page's own jump banner. When he stops (snoozed, hidden, off, a call, quiet hours, the setting off, something that needs you, no feed, or the app quits), the page shows one jump banner, the newest, for what it still holds. If Talos is not in front when he stops, he posts the macOS banner for what he had taken instead. In quiet hours he posts no banner, and the page keeps the reply for its own banner. A reply held longer than 15 minutes (a very long turn) is posted as a macOS banner. A reload of the page forgets what it held (the unread count stays). A browser, the phone and an app with no companion see no change.
- **When Talos is in the background**, the page's banner comes as a macOS banner, as before, and he takes it only when he can say it: on screen, awake, not in quiet hours, no call, a live feed, and not showing something that needs you. A reply in a thread whose turn is running keeps its banner (his Done waits for that turn). A reply in the thread on screen gets nothing only while Talos is the window in front; a window that is merely visible does not count as read.
- Quiet hours (Settings, quiet window) hold his bubble back and add no banner. They never change how he looks or moves: he idles, reacts to clicks and drags and walks as he does by day. Only Reduce Motion, Low Power, a running mic, Mini mode and a hidden panel hold his animation still. The app does not read macOS Focus, so Focus silences the macOS banner but not his bubble, as with every other bubble of his; turn him off or snooze him to silence it.
- Settings, Companion: **Mini Talos delivers thread replies** (on by default). Off gives the short one-line "New reply in <thread>" bubble and the page's own banners. **Also show reply banners** (off by default) also posts the macOS banner when Talos is in the background; it does nothing while you are working in the Talos window.

## The Terminals window: Main and every thread session

**Terminals…** (menu bar item, or Window → Terminals…; it has no key, because ⌘K is Search in the Talos window) is one window. The **Sessions** tab has a sidebar listing Main and
every thread session, each with a state badge: Working, Idle, Parked, Stopping, Failed or Needs you (Main shows Live, Starting,
Stopping or Not started). Click an entry, or press ⌘1 to ⌘9 while the window is in front, and the terminal beside the list
switches to that tmux session. The list follows the sessions live. Switching ends only our own viewer: every session keeps
running. The tab appears with the tmux host; with the owned-pty fallback the window shows Main's screen as before.

- **Live, idle, working or starting:** the terminal is that session's real pane.
- **Needs you:** the pane is waiting on a Claude Code prompt (such as "trust this folder"). Answer it in the terminal; Talos
  types into a dialog only for a tap on a card (folder trust, MCP consent: Up or Down and Enter, see OPTION-C "Needs-you prompts"),
  never otherwise. The thread also got one plain line saying so, unless the bridge made a card for it.
- **Parked or not started:** nothing is running, so a **Resume** (or **Start**) button stands in for the terminal. It asks the
  session to start, resuming the same conversation.
- **Failed:** the error in words, no terminal.

## The Terminal screen: a tab for every session

Sidebar, **Terminal** (Mac app only; a browser or the phone app has no shell and `/terminal` goes Home). Across the top is a strip
of tabs: **Main**, then every thread that has its own session, each with a state dot and a word: working, live, parked, needs you,
failed (also starting, stopping, not started). The picked tab is underlined; the raw Claude CLI terminal is below it. The list is
the same one the Terminals window shows, so the two always agree.

- **Switch:** click a tab, use the arrow keys, Home and End on the strip, or press **Ctrl+1 to Ctrl+9** (Main is 1). On this screen
  those chords pick tabs instead of opening thread 1 to 9. A number with no tab does nothing. This holds after you click into the
  terminal too: the Mac takes Ctrl+1 to Ctrl+9 before the terminal does and tells the page, so no control byte (Ctrl+3 is ESC, Ctrl+8 is
  DEL) reaches the session. The chord is the physical key (digit row or keypad, Caps Lock on or off, any keyboard layout); Ctrl+Shift+digit is another chord and goes to the terminal. After the switch the new terminal has the keyboard, so typing and the next Ctrl+digit work. Every other key goes to the terminal untouched. The tab you picked last is
  remembered for that window.
- **Switching is safe:** the Mac re-points only its own `tmux attach` at `=agent` or `=t-<thread>` on Talos's tmux server. No key is
  sent, and no session is detached or killed. The page names only "main" or a thread id; the session name is worked out on the Mac
  from the id (`WorkerSpec.tmuxName`) and an id that is not in the list attaches nothing.
- **Parked or not started:** a Resume (or Start) button stands in for the terminal. It asks the thread's worker to start through the
  same request as the Terminals window, only for a thread that is parked or off right now, and shows the Mac's answer.
- **Failed:** the error in words, no terminal. **Needs you:** the terminal shows the prompt; answer it there.
- The terminal needs room for 80 columns by 24 rows. Click inside it before typing: the page never moves your typing into it.
- **Older Mac app or older page:** no list is sent, and the screen is the single Main terminal it was before.

The messages behind it are in `packages/protocol/src/native.ts`: `terminal_view` carries `session`, the page sends `terminal_resume`,
the page sends `terminal_leave` when the screen is closed (a null room only means "no terminal to show right now", so the list keeps
following the sessions), and the Mac sends `terminal_sessions`, `terminal_resume_result` and `terminal_select` (a tab it switched itself). The page lists `terminal-tabs/1` in `ready`; the Mac sends the
list only to a signed-in page that says so.

The **Thread sessions** tab is still there for the one case below.

- **Needs attention because it stopped at a question only this Mac can answer** (a session from before a prompt was kept for
  you, or one nobody answered for 15 minutes): nothing is waiting in a pane. The tab shows what the dialog said and a button,
  **Open claude in this folder**, which starts a plain `claude` in the thread's folder in the tab. You read the dialog and
  answer it yourself. Closing the window ends that claude. Then open the thread's settings in the app and press **Restart**:
  that resumes the same conversation. (A message alone does not start it; while the thread shows Needs attention, main
  answers. **Start fresh** begins a new conversation.)

## When something is wrong

- **"Blocked: another session holds the channels".** The agent is still running somewhere else (Terminal). Stop that one
  first.
- **The menu says the Bridge is "unknown".** The bridge has not written `status.json` yet. Restart the agent so it runs this
  version of the bridge.
- **The Bridge shows down, but the agent is running.** Run `talos-app status` and `talos-app doctor` in a terminal;
  `talos-app logs` shows the bridge log.
- **Sign in cannot find `talos-app`.** Run `apps/bridge/scripts/install.sh` again (it puts `talos-app` on your PATH), or
  type the command in Settings, Window, for example `bun run <repo>/apps/bridge/src/cli.ts`. Talos also finds the bridge
  folder from the agent folder's `.mcp.json`.
- **The agent restarted itself.** That is the crash restart working. The log says why: `~/Library/Logs/Talos/supervisor.log`
  (event names and ids, no text).
- **The menu says Talos put back the last good setup.** The agent crash-looped, or the bridge stayed down for five minutes
  (counted while the Mac is awake, after the bridge was up in this start); the line names the files it wrote and the date of
  the version. It happens by itself once, then waits for ten healthy minutes. If the restore failed, nothing was restarted: run
  `talos-app restore-last-good --list` in a terminal. Restoring by hand stays in the Mac menu and Terminal; the phone can
  only restart the agent. The same line is posted to your default thread on the phone, also when the restore failed (not when it
  changed nothing, and not when your `talos-app` can't be found).
- **A phone restart is ignored while you have stopped the agent at the Mac** (the menu says so): your Stop wins. A Stop pressed
  while a restore runs also wins: the restore finishes, the menu says so, and nothing restarts. The app acts on one phone
  request per two minutes (only a restart the phone asked for counts; menu, crash and restore restarts do not); one that comes
  sooner is ignored and the menu says so, but not while the menu says Talos needs you at the Mac. A request dated before the app
  launched is deleted and not acted on, so your Stop, or "Start the agent when Talos opens" off, still holds after you quit and
  reopen the app. The phone is not told what the Mac did with its Restart tap: it says "sent to your Mac" and that the app
  decides (nothing happens if the app is not running). A restore cut off by quitting the app tells nobody, because the quit ends
  the process. After a phone restart or an automatic restore, if Claude Code stops at the dev-channel warning
  (cold start), the app posts "press Enter at the Mac" to your default thread.
- **macOS asks for the Desktop folder again.** The app was signed differently from last time. Use the local signing
  certificate above, or grant it again.
- **A bug report.** `talos-app report --out report.txt` bundles doctor, status and the log with keys, tokens and your home
  folder removed. Read it first.

## Files

| Where                                              | What                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `~/Applications/Talos.app`                         | The app (by default)                                      |
| `~/Library/Application Support/Talos/desktop.json` | Your session settings (0600)                              |
| `~/Library/Logs/Talos/supervisor.log`              | What the supervisor did: event names and ids only         |
| `$TALOS_APP_HOME/status.json`                      | The bridge's health, written by the bridge, read by Talos |

## Tests

`apps/desktop/scripts/test.sh` runs the Swift suites; `apps/desktop/scripts/ci.sh` is what CI runs. Tests that starve the process-wide dispatch pool would fail the suites running beside them, so
`scripts/test.sh` skips them and `apps/desktop/scripts/starvation-tests.sh` runs them alone (CI runs it after the main run). The by-hand list for
things a test cannot check (the real dialog, a real crash, real Spaces and displays) is
the manual desktop smoke list.
