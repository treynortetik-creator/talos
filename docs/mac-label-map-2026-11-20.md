# Mac app label map, 2026-11-20

Old words to new words for the Mac app (menu bar menu, top menu, Mac settings). The web Help quotes these labels word for word.
Source of the new words: the owner-approved "Plain words" board and the five settings mocks. Shared words with the web and iPhone
apps: the agent is "your agent", the relay is "the Talos server", the bridge is "your Mac" (or "Talos on your Mac").

Engineer words (relay, bridge, tmux, session, Terminal, token, MCP, launch command) now appear only in Advanced (the Advanced tab and
the Advanced submenu). `MacWordsGuardTests` fails if one reaches any other Mac screen.

## 1. Start / Stop / Restart (menu bar menu)

| Old                                 | New                |
| ----------------------------------- | ------------------ |
| Start session                       | Start your agent   |
| Stop session                        | Stop your agent    |
| Restart session                     | Restart your agent |
| Try again, Start a new conversation | unchanged          |

The Your agent tab also has a Restart button (same action as Restart your agent).

## 2. Status lines at the top of the menu bar menu

| Old                                                                                                                              | New                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Session: not started / starting / running / restarting / stopped, plus "· tmux" or "· owned pty"                                 | Agent: not running / starting / running (also: not set up, stopping)                                        |
| Bridge: connected / unknown / not running / not reporting / replaced by another session / headless / running, relay disconnected | Your Mac: connected / not connected (also "checking" while the agent is coming up and has not reported yet) |
| Relay: reachable / not reachable / checking / not set (Mac settings → Connection)                                                | Talos server: connected / can't reach / not set up (also "checking")                                        |
| Needs you: N                                                                                                                     | unchanged                                                                                                   |
| Session: blocked, another session holds the channels                                                                             | Agent: not running (the notice line says why, see 5)                                                        |

"If the Bridge says unknown": this sentence is not in the Mac app. It is web Help text (apps/web/src/features/help/content.ts) about the
old "Bridge: unknown" status line, which is now "Your Mac: checking" (agent running, nothing reported yet) or "Your Mac: not connected".

Notices shown under the status lines:

| Old                                                                                               | New                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Talos restarted after a crash and resumed                                                         | Your agent stopped and was restarted. It carried on.                                                              |
| Talos stopped restarting (crash loop)                                                             | Your agent keeps stopping, so Talos paused it. Open Talos to look.                                                |
| Main is running but its Talos bridge didn't start                                                 | Your agent is running but Talos on your Mac didn't start                                                          |
| Talos bridge is running but can't reach the relay, so your phone gets nothing (last close code N) | Talos on your Mac can't reach the Talos server, so your phone gets nothing right now. Talos keeps trying (code N) |
| Open Terminals… (in a thread's notice)                                                            | Choose Show my agent's screen.                                                                                    |
| the Sales session is waiting on …                                                                 | the Sales agent is waiting on …                                                                                   |

## 3. Settings tab names, and the Relay address field

Window title stays "Mac settings".

| Old tab     | New tab                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Session     | Your agent (permission picker, start, restart, problems thread, keep working) and Advanced (everything technical) |
| Connection  | Phone & Mac (this Mac, Claude account) and Advanced (Talos server address, talos-app command, sign-in command)    |
| Permissions | Privacy & access                                                                                                  |
| Hotkeys     | General, card "Quick message"                                                                                     |
| Companion   | General, card "Companion" (and Advanced for "Also show reply banners with the Companion")                         |
| General     | General                                                                                                           |
| (new)       | Advanced                                                                                                          |

Where each existing setting went:

| Setting (old label)                                                                                    | Old tab       | New tab and label                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Permission mode (Auto (recommended) / Ask me / Bypass all)                                             | Session       | Your agent, "How much your agent asks before it acts": Auto / Ask me / Bypass                                                                                                                                |
| Start the agent when Talos opens                                                                       | Session       | Your agent, "Start my agent when Talos opens"                                                                                                                                                                |
| (Terminal host: Automatic / tmux / own terminal)                                                       | Session       | Your agent, "Keep it working when I quit Talos" (on = automatic, off = Talos's own terminal); the full three-way picker is in Advanced as "Terminal host"                                                    |
| Restart the agent after a crash                                                                        | Session       | Your agent, "Restart it if it stops by itself"                                                                                                                                                               |
| Thread for crash posts                                                                                 | Session       | Your agent, "Tell me about problems in"                                                                                                                                                                      |
| Restart to apply banner                                                                                | Session       | Your agent, one caption "Changes apply the next time your agent starts." with "Restart now"                                                                                                                  |
| Launch command                                                                                         | Session       | Advanced, "How your agent starts" (field named "Command that starts your agent")                                                                                                                             |
| Agent folder                                                                                           | Session       | Advanced, "Agent's folder"                                                                                                                                                                                   |
| Press Enter for me on the development-channel dialog                                                   | Session       | Advanced, "Answer Claude's start-up question for me"                                                                                                                                                         |
| Open the terminal when the agent needs you                                                             | Session       | Advanced, "Show my agent's screen when it needs me"                                                                                                                                                          |
| Unstick the agent when it stops answering                                                              | Session       | Advanced, "Unstick my agent when it stops answering"                                                                                                                                                         |
| Find a running session / Import your launch command / Copy Terminal command / Copy tmux attach command | Session       | Advanced: "Take over an agent that's already running… (Look for one)", "Take over or import" section, chips "Copy Terminal command", "Copy tmux attach command"                                              |
| Relay address                                                                                          | Connection    | Advanced, "Talos server address" (the mock said "Talos online address"; the shared word is "Talos server")                                                                                                   |
| talos-app command                                                                                      | Connection    | Advanced, "talos-app command"                                                                                                                                                                                |
| Sign this device in / Sign in… / Or run it yourself in Terminal                                        | Connection    | Phone & Mac, "This Mac": "Connect this Mac…"; the run-it-yourself command is in Advanced, "Connect by command"                                                                                               |
| Sign out                                                                                               | Connection    | Phone & Mac, "This Mac" (when connected)                                                                                                                                                                     |
| Forget this Mac…                                                                                       | Connection    | Phone & Mac, "This Mac": "Disconnect this Mac…"                                                                                                                                                              |
| (sign in to Claude again)                                                                              | menu bar only | also Phone & Mac, "Claude account": "Switch account…"                                                                                                                                                        |
| (new, no old label)                                                                                    | menu bar only | Phone & Mac, "Your devices": "See and remove your devices" with an "Open" button; opens the Talos window at Account, devices part; greyed with "Set up the Talos server first" until a server address is set |
| Permissions list (Grant, Open System Settings, Ask now)                                                | Permissions   | Privacy & access: groups Allowed / You said no / Not asked yet; "Grant" is now "Allow…"                                                                                                                      |
| Apps your agent may control                                                                            | Permissions   | Privacy & access, "See and use the screen"                                                                                                                                                                   |
| Quick compose hotkey (Record, Reset)                                                                   | Hotkeys       | General, "Quick message": "Change shortcut", "Reset"                                                                                                                                                         |
| Show Companion, Size (Standard / Mini)                                                                 | Companion     | General, Companion: "Show the Companion", "Size" (Standard / Small)                                                                                                                                          |
| Rounds and little moments                                                                              | Companion     | General, Companion: "Let it wander now and then"                                                                                                                                                             |
| Mini Talos delivers thread replies                                                                     | Companion     | General, Companion: "It brings me new replies"                                                                                                                                                               |
| Also show reply banners                                                                                | Companion     | Advanced, "Also show reply banners with the Companion"                                                                                                                                                       |
| Start Talos when I log in                                                                              | General       | General, "Open Talos when I log in"                                                                                                                                                                          |
| Show a Dock icon                                                                                       | General       | General, "Show Talos in the Dock"                                                                                                                                                                            |
| Keep this Mac awake while plugged in                                                                   | General       | General, "Keep my Mac awake while it's plugged in"                                                                                                                                                           |
| Update Talos automatically                                                                             | General       | General, "Update Talos by itself"                                                                                                                                                                            |
| Open the Talos window at launch                                                                        | General       | Advanced, "Open the Talos window when Talos starts"                                                                                                                                                          |
| Version line                                                                                           | General       | General footer "Talos <version> · <update status>"; Advanced also shows the build                                                                                                                            |
| Show the Mac app's log / Show desktop.json                                                             | General       | Advanced, "Show the Mac app's log", "Show settings file"                                                                                                                                                     |

## 4. Menu bar menu: the Advanced submenu

Path: menu bar item → Advanced ▸.

| Old (top level of the menu)  | New (inside Advanced)                                       |
| ---------------------------- | ----------------------------------------------------------- |
| Terminals…                   | Show my agent's screen…                                     |
| Copy Terminal command        | Copy Terminal command                                       |
| Copy tmux attach command     | Copy tmux attach command (only when the agent runs in tmux) |
| Find a running session…      | Take over an agent that's already running…                  |
| Use a folder I already have… | Use a folder I already have…                                |
| Open Log                     | Show problem report                                         |

Other menu bar renames: Quick compose… → Quick message…; Compose hotkey… → Quick message shortcut…; Permissions… → Privacy & access…;
Sign in… → Connect this Mac…; Forget this Mac… → Disconnect this Mac…. In the top menu bar's Window menu: Terminals… → Show my agent's
screen…, Quick compose… → Quick message…, Sign in… → Connect this Mac…, Permissions… → Privacy & access….

## 5. "Another session holds the channels"

| Old                                                                                                  | New                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Another session holds the channels (and "Blocked: another session holds the channels")               | Another agent is already using this account                                                                                       |
| Another session is holding <name>'s channels (banner)                                                | Another agent is already using this account, so <name> did not start                                                              |
| Another session holds the channels, so the agent did not start. Close it, then choose Start session… | Another agent is already using this account, so yours did not start. Close it, then choose Start your agent in the menu bar item. |

## 6. Terminal window sidebar

| Old                                                                       | New                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Thread sessions (tab)                                                     | Thread agents                                                                             |
| No thread sessions yet. A thread that runs its own session shows up here… | No thread agents yet. A thread that runs its own agent shows up here once it has started. |

## 7. Quit

| Old                              | New                                   |
| -------------------------------- | ------------------------------------- |
| Quit Talos (agent keeps running) | Quit Talos (your agent keeps running) |
| Quit and stop the agent          | Quit Talos and stop your agent        |
| Quit Talos (stops the agent)     | Quit Talos (stops your agent)         |

## Not changed (still engineer-worded, outside the settings and menu pass)

The Terminal window itself, the setup checklist "Use a folder I already have" window, the first-run checklist rows and thread posts
that quote "This thread's session…" still use the old words. They are Advanced-level screens or posts that go to the web app.
