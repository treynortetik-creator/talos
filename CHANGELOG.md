# Changelog

## A list of named events, and a richer commands list

- `talos events` (and `--json`) lists the named events the app emits, who emits each and the fields it carries (ids only, never a path or text). Nothing runs on them yet. The app now refuses to log an event that is not on that list.
- `talos commands --json` gains `schema`, `app_version` and per-row `args`, `who`, `effects` and `risk` (today's keys stay), and the `talos-app` help text is built from the same list, so the two cannot drift.

## A keyboard palette: Cmd+K, and the same search on the phone

- **Cmd+K (Ctrl+K)** opens a palette from any main screen, also while you type. It jumps to a thread, searches all messages, opens Schedules, Settings or Memory, starts a new thread, runs a `/` command in the thread you are in, and opens the top Needs-you card. Each item shows its shortcut.
- New shortcuts: **Cmd+J** the Needs-you list (arrows and Enter open a card), **Cmd+F** search this thread, **Cmd+.** the Session panel, **Cmd+/** the list of shortcuts, and in the Mac app **Cmd+[** and **Cmd+]** for the previous and next thread. In a browser those two stay Back and Forward, and New thread has no key (Cmd+N is the browser's and the Mac app's Quick compose). The list is in Settings > Keyboard shortcuts.
- Nothing here answers a card. The palette and Cmd+J only open it; the card's own buttons (and the approval sheet's scroll to the end) are still the only way to answer.
- On a phone: a search button in the thread header, and a pull-down from the top of the thread list or Home, open the same palette with no shortcuts shown.
- Every chord now comes from one table (`apps/web/src/lib/keymap.ts`) of shipped defaults, with a resolver for your own overrides later. Rebinding itself is not built yet; nothing changes your keys.

## The Schedules page is short again, and you can edit a job yourself

- Jobs are grouped by thread, each group shut until you open it. A group's line shows the thread, how many jobs it has, when its next one runs, and a red dot if a job failed. A group with a failed job, or a job waiting for you, opens by itself.
- The next job to run sits at the top with a countdown. One-time jobs have a group of their own. Each job is one line: name, when, a status dot and its on/off switch.
- Filter with Failed, Paused or One-off. Once you have more than 15 jobs, a search box appears.
- Every job has an **Edit** button that opens the form with the job filled in. Saving shows the same approval card as before, with the same risk rating (turning memory on still asks for your approval). Nothing new is written without your approval.

## The Mac app presses Enter on the development-channel warning at every start

- Restarting or resetting your session no longer leaves the agent waiting at "WARNING: Loading development channels". The Mac app now presses Enter for you at every start, not only after a crash, when the screen is exactly that warning and lists only the one channel the app itself adds (`server:talos-app`), launched with only that channel. If the launch command changed since you last pressed Enter (another program, flag or environment variable, or a first start after set-up) the first start after the change waits for your Enter once. If the screen differs in any way (another or an extra channel, the cursor on Exit, a second warning, more than a minute after the start, or you are typing in the pane) it presses nothing and the menu says it needs you, as before. Each time it presses Enter it writes one line to the app log. The setting is still "Press Enter for me", and turning it off means you press Enter yourself.

## Choose a thread's folder instead of typing it

- The Folder box in a thread's own-session settings now shows the real folder in words ("Working in ~/Projects/alpha", or "Working in ~/talos-agent, the agent folder" when it is empty), with `~` for your home. A **Choose…** button next to it picks the folder: in the Mac app it is the Mac's own open panel (folders only, nothing can be created); in the browser and on the iPhone it is a small folder browser that starts at your home, with a path across the top, dot-folders hidden unless you tick "Show hidden", and "Use this folder" for the level you are on. The last five folders you used on this device show as buttons under the box. Whatever way you choose, the folder is saved the same way as a typed one, and your Mac still checks that it exists and may be used. Typing `~/…` works too.
- The browser asks your Mac for the names of the folders inside one folder at a time, and nothing else: never a file, a size or a time. Only your signed-in device can ask, and the agent has no way to. Your Mac will not list `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.config/talos`, `~/.claude`, `~/Library`, the Talos folder, the agent folder, the per-thread inbox folders, your private vault, or anything inside them, nor anything outside your home. A folder that is a link to somewhere else is not shown at all. A list is cut at 500 folders ("37 more not shown"). A folder name with a hidden or direction-changing character is shown with the character spelled out.
- A thread's folder can no longer be one of those folders however it is set (typed, chosen in the browser, or returned by the Mac's open panel): the Mac says "That folder can't be opened." The list also covers `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.azure`, `~/.codex`, `~/.gemini`, `~/.password-store` and `~/.local/share/keyrings`. A folder macOS won't let Talos open says "macOS hasn't given Talos access to this folder.", and one that is slow to open says so.
- When a thread's folder is set, changed or cleared, the Mac records a `thread.folder_chosen` event (the thread's id, never the path) for future hooks.

## Bundled scheduler updated

- Talos now ships Chronos 0.5.0, including upstream support for job memory.

## Background jobs can remember between runs too

- A job that runs in the background now keeps its last 3 results and a small notepad (up to 2 KB) like a session job does, when "Remember between runs" is ticked. It needs a Chronos that supports memory (the copy shipped with Talos does); with an older one the approval card says plainly that a newer Chronos is needed, and nothing is kept. A job with full permissions runs unattended, so its card says "runs unattended, with full permissions". A read-only (restricted) job reads its past results but cannot keep notes, and a run started by an event gets no memory at all. Switching the box on still needs your approval on a card, and changing the job's text, switching it off or deleting the job clears it, as before. A command job can have it too: the command gets the last results and the notepad as files in a private folder for that run, and may write a new notepad to the file named in `TALOS_MEMORY_NOTEPAD_OUT`; its result is its last output line with the exit status.

## A scheduled job can remember between runs

- Each scheduled job now has a "Remember between runs" box, off by default. Tick it when you make the job or edit it later (or ask Claude to propose it), and each run is shown that job's last 3 results and a small notepad (up to 2 KB) it can rewrite when it finishes. The card says when a job has it on. Only that job sees its own memory; it is marked as notes from earlier runs, not as something you said, and anything in it that came from an email or a web page stays labelled that way. Turning it on always asks for your approval on a card, because it changes what every later run sees. Changing the job's text, moving it to another thread, switching the box off, or deleting the job clears it. It works for jobs that run in your session (background jobs: see the entry above).

## A small popup on the Mac for a thread session's trust, MCP and login questions

- When a thread's own session stops on its folder-trust, "new MCP server" or login question, the Mac app now also shows a small popup with the same question in plain words and the session's own buttons, in the same order. You can answer there or on your phone; the first answer wins and the other says "Already answered". The popup never takes the keyboard, and keys never reach it, so Return or a stray key cannot answer it; only a real click on a button does (not an Accessibility or AppleScript press), and a click in the first moment after it appears or moves is ignored. The close button just hides it. It stays away in quiet hours (and shows if the question is still waiting when they end), and it goes when the question goes. A click is checked against the screen first, like a tap from the phone: if the session's screen changed, or you were typing in it, nothing is pressed and the popup says so. The phone and web card and the popup now use the same words for each question ("sign in", never "log in").

## A tidier app: search in the thread list, one Session panel, and a message row that stays out of the way

- Search is now in the thread list. A magnifier sits beside + and the pencil; tap it and that row becomes a search box, and the results (the same search as before) take the place of the threads until you press Esc or the cross. The "Threads" label and the bottom "Search" row are gone. On a phone the menu has the same row, and the card at its top (the thread's name, its description and "Search this thread") is gone: the thread you are in is an ordinary row of the list.
- The thread header is lighter: the status ("Idle", "Working") is a small pill beside the thread's name, and the search icon, the Greek-key line and the description line under it are gone. The description (the "what goes here" text) is still in the thread's ⋯ menu, and so is "Search this thread".
- The usage readings (week and context) are one small, quiet chip in the top-right corner of the screen (a small dot on it means the Claude Code mod has lapsed). Tap it to open the Session panel. On a computer the panel sits beside the chat, never over it: you can keep typing and clicking in the chat while it is open, and it closes only on its cross or on the chip. It remembers on each device whether it was open. On a phone it is still a sheet.
- The Agents panel on the right, its narrow strip and its "3 agents" chip are gone. What they showed is a section of the Session panel: Context (with Compact), Usage, and Agents in two groups (this session's helpers, shells and monitors, or "No agents running."; then each thread's own session and its state). Commands, MCP servers and plugins moved to Settings → Session; the panel links there.
- Under each message there is now one row: the time, Copy, Listen and the ⋯ menu. On a computer Copy, Listen and the ⋯ show when you point at the message; on a touch screen they are always there. The ⋯ no longer sits on top of the first line of the message.

## Every thread session is fenced from the Talos folder, and the MCP list and the restart rules are applied

- The Mac app now blocks every thread's own session from reading or writing the whole Talos folder (messages, keys, databases) with the same file-tool rules the leads have, in the settings it writes for the session and for "Open claude here". It is added after the optional guards' settings so it is never lost to them. It stops the file tools and Bash `cat`, `head`, `sed`, `tee` and redirections; a Bash `sqlite3`, `python` or `grep -r` can still open the folder, because a non-lead session has no sandbox. A session whose settings lack the block does not start.
- The "Limit MCP servers" list is now applied when a session starts: only `talos-app` and the servers you name, copied from where you defined them (your user config, the thread folder's `.mcp.json`, an enabled plugin), with the claude.ai connectors and Chrome off. A listed server that exists nowhere is skipped and the thread is told once. No value from a server's setup is ever printed or logged. No list still means no change. `lead init` no longer writes the list as block rules, and a re-run removes the ones an earlier version wrote (and only those).
- Changing a running thread session's folder, model, effort or MCP list restarts it once the change has stood for 30 seconds, after its current turn ends (never in the middle of one). A new folder starts a fresh conversation there and the thread is told; the other changes resume the same conversation. The sheet now says "Saving restarts the session when its current turn ends."
- One thread's failure code this version does not know no longer makes the whole thread-sessions file unreadable; that thread shows "stopped for a reason this version doesn't know" and the others carry on.
- The MCP list now handles servers defined in the thread's own folder safely. A `.mcp.json` the folder ships can no longer replace a server you defined yourself. A server you defined for that folder (local scope) is used. A server from the folder's `.mcp.json` is used only if you approved it for that folder; otherwise the session does not start and the thread is told how to approve it. Messaging plugins can never be on a list, and every plugin not on the list is switched off for that session. Servers from your config no longer carry a Telegram or iMessage token into a thread session.
- A thread session now starts in the same permission mode as the main session, and the folder's own `.claude/settings*.json` cannot widen it. When main's mode cannot be found, the thread session explicitly uses the default permission mode. The kit's relative rules such as `Read(./.env)` keep protecting the agent folder in a session started elsewhere.
- Saving a setting that restarts a running session never cuts a turn short, however long it runs.
- `talos-app lead check` lists the old MCP block rules an earlier version wrote, and `lead init <thread> --remove-stopgap` removes them on request. A plain `lead init` re-run no longer removes any block rule, so your own rules are safe.
- A thread session can no longer start with more access than the main session: a wider permission mode, MCP servers the main session cannot use, or fewer block rules. It does not start, its status says it was not started for that reason and which one, and the thread is told once. Messages go to the main session until the settings are narrower.

## Permission cards explain themselves in plain words

- Every permission card now fills in, a second or two after it appears, one or two plain sentences saying what the command does and a tag (reads files, changes files, deletes, sends over the internet, installs); the command itself sits behind "Show the command". If Claude's own description leaves something out, the card says so, the tag reads "... · Doesn't match", Deny becomes the main button and Allow reads "Allow anyway". It never makes you wait: Allow and Deny work at once, and if the explanation can't be made the card says "Couldn't explain this one". The explanation is written by your own Claude on your own plan (no key, no bill), sees only the command and Claude's description, and can't lower the tag below what Talos itself reads in the command. Turn it off with `TALOS_EXPLAINER=off`. It needs the Mac to be updated; older apps show today's card.

## A thread session parks after its idle time even when its status line keeps repainting

- A thread's own Claude Code session was never parked for being idle if your Claude Code status line (the line under the input box, such as "Sonnet 5.5 | 20% | 7d: 38%") redrew now and then, because any redraw of the pane counted as activity, and the status line redraws when usage changes, including usage from your other sessions. The idle time now counts from the last message, the last change on the screen above the input box (a turn, or text typed in it), or the last key from a Terminals window attached to the session, so the status line and the footer no longer matter. A session that is busy, waiting on you, or still owed its message is never parked, as before. A status line set to refresh more often than every 15 seconds still keeps a session from parking. The last activity is saved with the session's status, so after the Mac app relaunches the idle time carries on from it.

## Thread leads get a lighter fence by default, and a choice of MCP servers

- `talos-app lead init` now makes a "light" lead by default: it keeps the read and write blocks on the main agent folder, `~/.claude`, the whole Talos folder, your vault, anything you `--protect`, and now also `~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.npmrc` and `~/.netrc`, but runs without the macOS sandbox, so `git push`, `gh`, tmux and `SendMessage` to the builders work. Light stops accidents, not a determined program: a command like `sqlite3` or `python` can still open a blocked file, and the network is open. Add `--sandbox` for the old behaviour (the sandbox, no `SendMessage`); a re-run keeps a folder's profile and changes it only when you pass `--sandbox` or `--light`. `lead check` accepts both, prints what each does not stop, and flags a lead made before the new folders were added.
- Files you send to a thread that has its own session are now copied to `~/.talos-inbox/<thread>/` and the session is given that path, so it never reads the shared media folder. That folder is not blocked: other thread sessions can read it. Copies are removed after 7 days (or past 1 GiB), and a thread's folder is removed when the thread is archived or deleted.
- A thread's own session may run only `talos-app commands`, `lead check`, `codex check` and the hook entries; every other `talos-app` command is refused to it (it already was for `digest`, `post` and `inbox`).
- Each thread's own-session sheet has a "Limit MCP servers" list. Off keeps today's behaviour; on means only the servers you name, plus `talos-app`. `lead init --mcp a,b` sets it (it replaces `--disable-mcp`); a claude.ai connector cannot be on a lead's list. An older app that does not know the list no longer wipes it when you edit a thread.

## The Mac app presses the answer to a thread session's trust and MCP questions

- The Mac app now shows a thread session's folder-trust, "new MCP server" and login questions to the bridge, and presses Up or Down and Enter for a tap on the card, but only when the tap carries the signature of a phone paired in `devices.json`, the screen still shows the same question, and nobody is typing in it. Login's "Open on the Mac" brings Terminals forward and presses nothing. When the bridge makes no card, the thread gets the same "open Terminals" line as before, now after a 15 second wait.

## The "can't be resumed" notice appears together with the stopped status

- When the last conversation could not be resumed, the menu's notice and its session status changed at slightly different moments: the notice could show next to "Session: restarting" while the old session was being cleared, or stay hidden for up to a second after the session had stopped. They now change together.

## Answer a session's start-up question with a tap

- When a thread's own session stops on its folder-trust question, the "new MCP server" question or a login prompt, the app can now show it as a card with the same buttons the session shows, in the same order, and you answer with one tap on your iPhone, the web app or the Mac app. The Mac presses the key for you only after it checks your signed tap came from one of your paired devices, that the card is exactly the question on its screen, and that the screen still shows it, and says so ("Answered on <device>") on every device. The first answer wins. If the screen has changed, nothing is pressed and the card says so. If nobody answers in 15 minutes the card expires and the thread gets the same one-line note as before. Login only offers "Open on the Mac"; the bypass-permissions question and anything Talos does not recognise are unchanged. This part is the phone and web side and the bridge: it stays off until the Mac app side lands, and until your relay is updated nothing changes.

## Typing in the Terminals window no longer stalls while a thread session is slow to answer tmux

- When tmux was slow to answer, the Mac app's regular checks (on the thread sessions, and on the agent's settings every few seconds) piled up behind it, and typing in the Terminals window, or the window itself, could lag or stall. The app now reads the last known state and settings without waiting. A few setup actions (choosing a folder, Adopt, Check again) can still wait for a slow tmux.

## An unsent line for a thread's session is never "finished" onto an empty box

- When the app had typed a thread's pointer line but not yet pressed Enter (after a relaunch, or within one session while the Enter was held up), clearing the input box at the wrong moment (a redraw caught with no box showing) could make the app press Enter on nothing, so the message silently went to the main session. The Enter is now sent only when the box holds exactly the app's own line, looked at just before it is sent; if the box is empty, the line is typed again.

## The Terminals note for unsent text no longer promises the message waits

- When a thread's session had unsent text in its input box, the Terminals window and the thread's notice said "your message is waiting". When a session's input box wasn't showing yet, the Terminals window said so too. Those lines only appear after 90 to 120 seconds, and by then Talos has given the message to the main session. They now say the message has probably gone to the main session.

## A message for a thread's own session survives the Mac app quitting

- If the Mac app quit, crashed or relaunched for an update just after a message arrived for a thread with its own session, the line telling that session to read it was lost, and the thread sat idle until the message went to the main session. It is now saved, and the app types it when it comes back if the message is probably still waiting for the session (the app estimates this from when the message arrived). If the app went after the line was typed but before it was sent, it finishes with Enter alone, and no longer mistakes its own line for your unsent text, which used to hold every later message from that thread. If the message has probably already gone to main, nothing is typed, and the app's own line is taken out of the box, but only when it is the only thing there and nobody has Terminals open on that session. Otherwise the app leaves the box alone and the thread gets one line asking you to clear it.

## A heartbeat that was off and then could not check anything still skips the backlog

- If the heartbeat had been off for days and every source then failed, you only saw "Heartbeat check failed", and the next run, no longer counted as off, could post the whole backlog of a source that came back. Now that run also says "Heartbeat was off for N days", the heartbeat stays in its start-over state (a new `cold_since` mark in its state file), and the first run where a source answers skips the backlog as usual. A source that is down while the heartbeat keeps running is unaffected.

## The menu's "needs you" line matches what is on screen

- When one start-up dialog gave way to the dev-channel dialog (straight away, or after the screen went blank for a moment), the menu could keep saying "folder trust on screen" while the dev-channel dialog was the one waiting. The menu line now describes what is waiting now, as the Terminals row does, and still disappears when nothing waits.

## The cold-start question comes back

- If the agent's screen went blank for a moment between two start-up dialogs, the question about confirming the dev-channel dialog could be lost, and later you were only told "a dialog needs you". The question now comes back when that dialog is up again.

## A thread session's message line waits for Claude's input box

- A thread session that connected to Talos before Claude had drawn its input box (a blank pane, a banner, or a dialog still being drawn) could get the "new message" line typed into it. The line is now typed only once the input box is on the screen. If the box still isn't there 90 seconds after the message is due, the thread gets one line, "<thread>'s session isn't showing its input box yet. Open Terminals → <thread> to see what it's waiting on.", and the thread shows as **Needs you** in Terminals. The session is left running, and the line is typed when the box appears.
- Tests cover a session that stays blank and then draws its box, one that never draws it (including a later hold telling the thread again), and an Enter still owed when the box leaves. They also check the saved screens of Claude's trust, MCP, bypass and permission dialogs and its question prompts, none of which counts as an input box.

## A phone that drops an upload no longer files a problem report

- When a phone closed a connection partway through a request (such as an upload), the relay filed it as a problem, "Error: aborted", and it reached the Mac. Nothing was wrong on the relay, so it is now only a debug line. Every other relay error is still reported.

## The "session is stuck" check no longer waits for a free thread

- The Mac asks `claude agents` every few seconds whether the agent is still listed, and two misses in a row raise "stuck". That check now has its own queue, so it is answered even when all the app's own shared threads are busy; before, the warning could come late.

## An agent argument that ends in a semicolon now reaches Claude as typed

- An agent argument in the Mac app's config (or an environment value, or a session's folder) that ended in `;`, such as `be brief;`, was read by tmux as the end of its own command, so the agent did not start. The Mac now escapes these for tmux, on a first start and a restart (a thread session's own arguments were never affected; only a folder name ending in `;` was, and that is escaped too). A `;` in the middle of a value was never a problem.
- Tests start the agent through a real tmux with such arguments (`be brief;`, `;` alone, `a\;`, `two;;`) and check that the agent receives each one exactly, on the first start and on a restart.

## A conversation that can't be resumed is told as that, even when the agent exits at once

- When the agent's last conversation is gone, Claude Code prints its error and quits immediately. If that happened before the Mac could read the agent's process (a slow or busy Mac, or just a fast exit), the menu said "The agent couldn't start: the agent exited immediately." and did not offer **Start fresh**. It now reads the dead screen and says "The last conversation can't be resumed." with **Start fresh**, the same as when the exit is seen a moment later.
- The Mac also no longer clears a restarted agent's screen history in a separate step after the restart, which could wipe the line a quick exit had just printed; it is now one step with the restart.

## One web-address check, now in the kit too

- The kit's two URL fetches, the update source (`talos update`) and a calendar's ICS address (the quiet check-ins), now refuse any address Talos will not contact: the same list as the app (private, loopback, link-local, cloud metadata, and every IPv6 form that carries one). It is checked on the address the connection really uses, for the first request and for every redirect, so a name that points inside your network or a redirect to one is refused. Only http and https are fetched: a redirect to `ftp:`, `file:` or `data:` is refused. An update source or calendar on your own machine (`localhost`, `127.0.0.1`, `::1`) still works, on its own port only.
- Environment and system proxy settings are ignored for these two fetches, because a proxy hides where the request really goes; a failed fetch says so.
- The kit's copy cannot quietly drift from the app's: `kit/scripts/test-address.sh` runs the shared address list (now including every blocked range's first and last address and its neighbours, and the IPv4 addresses carried inside IPv6: mapped, compatible, NAT64, 6to4, Teredo) against it, and `scripts/address-parity.test.ts` runs both checks over about 100,000 generated addresses and spellings and fails on any difference.

## Terminal prompts reach you

- When the main session or a thread's own session stops on a question that waits for a keypress (a tool permission such as a Bash command or a new file, the agent's own multiple-choice question, any other choice list), you now get one line: the main session's goes to the default thread, a thread session's to its own thread. It names the kind and the question ("Do you want to proceed?") and says to answer it in Terminal on the Mac. The Mac waits until the prompt has held still for 5 seconds, sends one line per prompt (a relaunch of the app does not send it again), and never types into it. The folder-trust, MCP-consent, bypass and login screens keep their own lines.
- Found from the shape of the screen, checked against captures of the real Claude Code 2.1.318 (the idle input box, a finished turn and a reply that quotes a prompt are not prompts). A thread session that opens on such a prompt now stays up for you instead of being given up as "never connected".
- Review fixes: a resize, a cursor move or text typed into "Type something." no longer makes a prompt look new (the notice is keyed to the prompt itself, not to its layout); the dev-channel warning is never also announced as a generic prompt; a picker you opened yourself (/model, /config, a slash menu) does not send a notice while you are typing in it; the agent's own "Chat about this" row, the Edit permission and the tab header of several questions are recognised; and Claude Code's own "Dangerous rm operation" prompt, whose countdown ticks every second, is announced once and says that Claude Code blocks it automatically in about two minutes.
- A fresh thread session whose input box shows Claude's grey suggestion ("Try …") is no longer taken for one with unsent text: the colours of the row decide (the suggestion is dim, your own text is not), so its first message is typed instead of waiting for ever.
- Both wordings of the "that conversation can't be resumed" error are covered by tests in the main session and in thread sessions, and the process-group kill (what a killed session leaves behind) is pinned by tests.

## Mini Talos delivers thread replies

- With the Mac companion on, a new reply in a thread now comes from him: a bubble with the thread name ("WORK · new reply"), the first line of the reply, and Open and Later. Open, or a click on the bubble, jumps to that thread; Later puts it away. It stays until you answer it or 30 seconds pass, and a pointer on it holds it. Several replies at once are one bubble ("3 new replies: Work, OC Test…"), and Open then goes Home.
- While you work in the Talos window, the page now decides what is a new reply: one it would have shown as its jump banner is held for him, he shows it in his bubble and tells the page, and the page forgets it. When he stops (snooze, hidden, a call, quiet hours, the setting off, the app quitting) the page shows its own jump banner for whatever he did not show. Every reply ends as exactly one of his bubble, a macOS banner he posts, or the page's banner; a reply that waits more than 15 minutes mid-turn is posted as a macOS banner. The page reports the thread on screen (a card page counts as its thread) and what it holds in `companion_state` (`viewing`, `held`), and he answers in `companion_replies` (`on`, `shown`).
- With Talos in the background it works as before: the macOS banner, taken by him only when he can say it. A reply in the thread you are reading gets nothing only while Talos is the window in front. Quiet hours add no banner.
- The bubble's text is shown on your screen; the app does not promise to keep it out of screenshots, shares or a mirrored display.
- A new setting, **Mini Talos delivers thread replies**, is on by default; off gives the old one-line bubble. **Also show reply banners** adds the macOS banner when Talos is in the background.

## Terminal tabs show on a normal launch

- The Terminal screen's tabs did not appear unless you had opened the Terminals window first: the main window's terminal read its sessions through that window, and nothing attached them on a normal launch. The app now creates its controller at launch and the Terminal screen reads it directly, so the tabs (and Main's terminal) come up the first time you open Terminal.

## Session switcher: the MCP, bypass and login prompts checked against real Claude Code

- The Terminals window's "Needs you" detection for Claude Code's MCP-server consent, bypass-permissions disclaimer and "not logged in" screens is now tested against screens captured from the real Claude Code 2.1.318, not invented ones. The MCP and bypass prompts were already recognised. A session that is not logged in was not: Claude Code shows no question there, only "Not logged in · Run /login" in the footer under the input box, and the Mac read that as a normal idle screen. It now shows Needs you with the login line. The same words in ordinary output do not trigger it. The "login expired" error of a running session could not be captured safely and is still tested with a written-out screen.

## Terminal screen: a tab for every session

- **Terminal** in the Talos window's sidebar now has a strip of tabs across the top: Main, then every thread that has its own session, each with a state dot and a word (working, live, parked, needs you, failed). Pick a tab and the raw Claude CLI terminal below switches to that session. Switching only ends the app's own viewer: no key is sent and no session is stopped. Ctrl+1 to Ctrl+9 switch tabs while the screen is up (on this screen they no longer open thread 1 to 9), and the arrow keys, Home and End move along the strip. The tab you picked last is remembered for that window. Ctrl+1 to Ctrl+9 also work after you click into the terminal: the Mac takes them before the terminal does, so Ctrl+3 (ESC) never interrupts a session. The tab states keep updating while a Resume panel is showing, so a resumed session turns live in its tab.
- A parked or never-started thread shows a **Resume** (or **Start**) button where the terminal would be, and what the Mac answered ("Asked to resume the session…", or why it could not). Press it and the Mac asks the thread's worker to start, the same way the Terminals window does; it only does so for a thread that is parked or off right now. A failed thread shows its error. The list follows the sessions live. A Mac app from before the tabs keeps showing the one terminal for Main, with no strip; a page from before the tabs gets no list.
- **Terminals…** (the separate window) stays, but it no longer takes ⌘K: in the Talos window ⌘K is Search, and the two collided. Choose it from the menu bar item or Window, Terminals…. Help's shortcut list and docs/desktop.md say so.

## Bridge hardening: restart overlap, slow ps, PR checks, schedule rows

- A bridge that starts while an older one is still shutting down no longer kills the older one's running heartbeat sources or overwrites its saved state: the startup sweep now runs inside the schedule queue, skips any source whose recording bridge is still alive, and reads the store again right before it writes so a record added meanwhile is kept. A group that is already gone is cleared even if its bridge is alive. Sources recorded by an older build carry no bridge marker and are judged as before.
- Starting a heartbeat command source no longer freezes the bridge for up to 2 seconds while `ps` answers: the lookup is asynchronous with a timeout, and a source that ends before it answers is simply not recorded, and the time `ps` takes is not charged to the source's own limit.
- The GitHub heartbeat's PR checks now stop together: after one lookup fails, when the run's deadline passes or when the run is stopped, every `gh` call still running is killed instead of left to finish.
- The small records the bridge keeps for a thread session's schedule work (which session proposed a waiting card, which session started a run) are now removed when the card is approved, declined, replaced or expires and when the run closes, and a start-up sweep removes any left over from a crash or older than 7 days. A card for a job that runs in a thread session is now refused at approval, with nothing changed, if the record of who proposed it is missing.

## Thread row menu and trust mode toggle

- Each thread in the sidebar (and each row of the Threads list on a phone) now has a "..." at its right end that opens that thread's settings: name, icon, color, notifications and, where it applies, Own session with Park now, Restart and Start fresh. It shows on hover or keyboard focus with a mouse and always on touch; it never opens the thread, and Schedules (not a thread) has none. General and Inbox get settings without an Own session section. The pencil at the top of the list stays for reordering and renaming.
- Trust mode is now a switch in Settings, Account. Turning it off needs nothing. Turning it on asks for your passkey (the same step as permission settings), checked by the relay, and the relay asks even if it believes trust mode is already on. The agent still cannot change it. `talos-app trust on|off` still works on the Mac, and the note the Mac posts in your thread on every change now also names Settings as a way back. An older relay or Mac that does not know the setting refuses it in words and nothing changes; an older app is unaffected.

## Terminals window: switch between sessions

- **Terminals…** (menu bar item and the Window menu, ⌘K) is now one window with a sidebar: Main and every thread session, each with a state badge (Working, Idle, Parked, Stopping, Failed, Needs you). Click an entry, or press ⌘1 to ⌘9 while the window is up, and the terminal beside it switches to that session. A parked thread shows a Resume button instead of an empty terminal, and a failed one shows its error. The list follows the sessions live as they start, park and stop. It replaces "Show Terminal".
- A thread session that stops at a Claude Code prompt (such as "trust this folder") no longer waits unseen. Its entry shows Needs you and its own thread gets one plain line saying which prompt and where to answer it. The session stays up so you can answer it in the Terminals window, and a prompt nobody answers for 15 minutes still ends the start as before.
- A thread given its own folder shows Claude Code's trust prompt once, the first time it starts there. The Terminals window shows that thread as Needs you, and you answer the prompt in it. Talos does not pre-trust folders: Claude Code applies a folder's trust to everything under it, for good.

## Thread schedules

- A thread with its own session now owns its schedules: its jobs fire in that session (waking it if it is parked), its session can propose, change and delete jobs for its own thread only (each one an approval card in that thread that reads "<Thread>'s session wants to schedule …", with Approve / Not now), and Schedules is grouped by thread with a line saying who runs each group; a job whose session is down falls back to Main with a plain note, and the heartbeat and every other job stay Main's. See docs/OPTION-C.md "Thread schedules".

## Heartbeat test

- Your Mac now answers the Heartbeat test: it acks at once, really runs the sources (a dry run that writes, posts and wakes nothing, with the same time limits and the same kill of anything left running), and sends back what each source found and what would wake the agent or post. It lists `heartbeat/1`, so the app's Test sheet and Turn on work. Settings that fail the strict check are refused in plain words, testing "with the agent" is refused until it exists, and one test runs at a time. In shadow mode the test says the heartbeat would only record and shows what live mode would do, and a test that breaks partway still reports the sources that answered.
- A heartbeat can no longer be turned on without a passing test of those exact settings, under 24 hours old, whichever way it is asked for (the agent, the app, an adopt, or `talos-app schedules adopt` at the Mac), and the Mac checks again when you approve the card. A heartbeat saved off needs no test, turning one off never does, and a rename, a thread move or a mute on one that is already on does not either. A slot that cannot start because the last wake is still open now shows as Busy in the app. Heartbeats that were already on keep running, and only a changed setting needs a test; if the current job cannot be read, a change to it is refused rather than let through.

## Heartbeat wake

- A heartbeat that finds something for the agent to act on now wakes it with a private run pack file (its path and the item counts are all the notification carries, never a subject or body, and the pack marks every outside word as untrusted), a read-only `heartbeat-triage` agent summarises it, anything outward still needs your card, items show as handled only after the agent reports the run done, a wake that fails or is killed twice falls back to plain lines, and nothing is woken (and you are told once to install talos-app-mod) when the triage agent is not there. A heartbeat now needs a thread of its own, and every card made in that thread is a background card that expires within a day, with at most three waiting at once (the next is a plain line); a card can only replace a pending card in its own thread. A long backlog is capped and summarised in one line, a gap over 72 hours skips the backlog only when the heartbeat itself was off, a slot that cannot start because an earlier run holds it shows as Busy, an ended wake's pack is deleted and a card or done naming it is refused, and the agent's `read_thread` shows heartbeat rows as outside text. Shadow mode still never wakes. See docs/HEARTBEAT.md.

## Heartbeat runner

- A heartbeat job's slot is now checked by the bridge itself, with no agent turn: it runs the job's sources (GitHub PRs and CI, failed scheduled jobs, the shared inbox, or your own command) with a time limit each, kills any that hang, and posts one quiet digest row for fyi items, nothing at all when there is nothing new, and a plain line asking for your reply for items that need you (the agent wake itself comes later). It follows the quiet hours, stops at the daily wake limit, shows work items only if you allow them in Integrations ("Heartbeat (work items)", with a passkey), draws its digest under a fixed "Heartbeat" label so a title from outside can't pass as a Talos notice, can't post the same digest twice after a crash, and in shadow mode only records what it would have posted. See docs/HEARTBEAT.md.

## Heartbeat contract

- Schedules now vendors Chronos 0.4.0 and has the Heartbeat contract (items, sources, a shadow or live mode, config in the job's meta, results), so a heartbeat job's approval card lists its mode, slots, sources, each command's exact argv, mutes and wake cap in plain words, says `(new)` or `(unchanged)` only when that is true, and a change to its sources or wake cap is high risk (only a short mute of one exact item is low). A heartbeat Talos can't read in full, or on a job without several fire times, is refused before any card is made, whether the agent or the owner's form proposed it. The runner that checks the sources comes later.

## Heartbeat in the app

- The Schedules tab now has a pinned Heartbeat row that says how the last check went in words and colour (a failure never reads as "Nothing new"), a Heartbeat choice in [+ New], a setup form, a test sheet, and per-source detail with mutes you can add or remove, every change going through an approval card; Turn on stays disabled until a test passes for exactly those settings, and the relay passes the new test frames without storing them. Needs a Mac that lists `heartbeat/1` (see "Heartbeat test" above).

## Set Talos up from one guide

- New `SETUP.md` in the repository root: one ordered path from prerequisites to the phone, with `[YOU]` marks for the steps only a person can do and a check after each step. `CLAUDE.md` and `AGENTS.md` now start by pointing an agent that is setting Talos up for a user at it.
- The root `./install.sh` passes the kit's flags through (`--with-vault`, `--with-memory-search`, `--notify talos` and the rest), `--with-chronos` now adds Chronos to an agent that already exists, and `--relay-url https://<host>` also sets up the bridge. The agent folder is `~/talos-agent` everywhere.
- The web app on the Home Screen is the default phone path. The free Personal Team build steps moved to `docs/ios.md`, and `scripts/testflight.sh` now passes the relay host to a push build (`TALOS_RELAY_HOST` is optional; taken from `TALOS_RELAY_URL`, and if you set it, it must match) (the throwaway checkout has no `Local.xcconfig`).
- `talos-app update` also prints the kit upgrade step. The public export fails if a setup doc names a file the export leaves out.

## Lead kit

- New `talos-app lead init <thread> --folder <dir>` makes a thread lead's own folder (standing brief, board rewritten at every stop, append-only decisions) with a privacy fence that keeps it out of whole folders (the main agent folder, the whole Claude Code config folder and `~/.claude.json`, the Talos folder, your vault and any `--protect` folder), enforced by Claude Code's own OS sandbox (Seatbelt) for Bash and everything it starts, locked on so claude refuses to start without it, plus deny rules for the Read tool, and switches off the browser, computer use, account connectors, every plugin's MCP servers and every MCP server your main agent has off; a lead can now read and list only its own thread, cannot send files from the Talos folder or any protected folder, cannot edit your shell start-up files, launch agents, ssh or git config or the folders on your PATH, and cannot run `digest`, `post` or `inbox`.

## Telegram removed

- Telegram support was removed: the mirror, its Settings page, the per-thread "Copy to Telegram" switch and the kit's Telegram setup are gone, and an old config that still holds the `mirror` settings loads without them. For one release the app and relay still send `mirror: {telegram: "off"}` inside config frames, because the previous web bundle and relay require the field; it is never stored and nothing reads it (to be dropped after the next release).

## Thread hand-offs

- The main agent can now hand a short TASK (100 words at most) to the own-session lead of a thread, and that lead answers with a RESULT or BLOCK; each hand-off shows in the thread under its own label ("Talos → Trip lead: TASK"), wakes a parked lead, reaches the other session as an agent note that is not your word and approves nothing, comes back to the main agent if the lead doesn't pick it up in 15 minutes, and is limited to 5 a day each way per lead (resetting at midnight in your timezone) and 3 open TASKs.
- Hand-offs: one that could not be delivered is now retried until it is, however late (there is no one-hour give-up); a TASK closes only on the lead's RESULT or BLOCK, a switch to shared, or after 24 h, not when the lead says anything in the thread; at 3 open TASKs the refusal lists them; and the note when a lead hasn't picked up a TASK names the TASK and comes from "Talos (the bridge)".

## Clock on every owner message

- Every note that carries something you did (a message, a voice note, a Run tap, a card decision, a spoken question on a call, a config or schedule card) now has `local_time`, your own clock with its offset, from the timezone in Settings (Settings requires one). Only a typed message, a voice note and a Run tap also have `since_last`, such as `4m` or `2h 10m`, since your previous message of your own words in that thread (a share does not count); the first one has none, and card, call, config and schedule notes never carry it. `ts` stays UTC.

## Self-map in the agent's instructions

- The main agent's instructions now say which Talos is live (the bridge's folder, relative to your home, and its commit, and whether the checkout has uncommitted changes) and how a change reaches your phone: the relay serves web code after a Railway deploy, the iPhone app takes web changes on its next launch (native iPhone changes, in apps/mobile/ios, the share extension and entitlements, need a TestFlight build), the Mac app needs a rebuild and install, and the bridge needs a session restart. The relay's version is left out, because the relay reports it only on `/healthz`, not in hello or ready.

## Agent themes

- The agent can draft a theme and propose it with `config_propose`; you preview it on a card (a thread, the composer and a card in its colours) and tap Apply or Keep current. The bridge refuses a draft outside the token allowlist or under the contrast minimum and names every problem; `talos-app theme reset`, Settings > Default theme and `?theme=default` all go back to talos.

## Recovery follow-ups

- When the Mac app puts back the last good setup by itself, it now also posts the menu's line to your default thread on the phone: the files written and the date of the version when the command's result line is recognised, a generic line when it is not. It posts when the restore failed too, but not when it changed nothing, and not when your `talos-app` can't be found.
- The phone's Restart agent reply now says "Sent to your Mac" and that the Talos app there decides, instead of promising a restart within seconds: it skips one if you stopped the agent there or it restarted for a phone request in the last 2 minutes, and nothing happens if the app is not running.
- A restart request refused for coming within two minutes of the last one now shows a line in the Mac menu (not while the menu needs you).
- Building the Mac app from a clone whose path has a quote or space now stamps the path exactly.

## Recovery tidy

- A restart request written before the Mac app launched is now deleted and not acted on, so your Stop, or "Start the agent when Talos opens" off, still holds when you quit and reopen the app. Requests written after the launch are unchanged.
- The menu and phone line for an automatic restore that did not restart the agent no longer says you had stopped it: the app may also have quit or detached while the restore ran.
- Docs: they list every request that gets no menu line, say the too-soon line is hidden whenever the menu says Talos needs you at the Mac, and the restart line can be replaced by the press-Enter line.
- Tests: three worker stop-limit tests and the dialog test wait for what they need instead of a sleep, one fake session gives up after a minute, and `gui-tests.sh` lists the recording suite as skipped instead of failing.

## Copy button on every message

- Every message with text now has a small Copy button beside its time, always visible on phone and desktop (44 by 44 to tap on touch); it shows Copied, or says it could not copy. The long-press menu and hover button are unchanged.

## The Talos zone as a plugin

- A new agent's skills, agents and scripts now live in a read-only release under `~/.local/share/talos/kit` that Claude Code loads as a plugin from a local-folder marketplace; the hooks and guards stay registered in the agent's own `.claude/settings.json` (so a never-trusted folder or a broken `current` link still runs them, failing closed when unattended); `hooks/` and `scripts/` in the agent folder become links into the release, `talos-migrate up|down` moves an existing agent (first migration: plugin-move, reversible, refuses to guess the agent folder), a second install leaves a shared `current` alone, and the hooks find the agent folder from `CLAUDE_PROJECT_DIR`.

## First run follow-ups

- After Choose into another folder, the session still running in the old folder can no longer write its session id or first-start confirmation into the new folder's setup.
- Adopt refuses a `.claude` that is a file, and says "is a folder, not a file" for a `.mcp.json` or `settings.local.json` that is a folder, before changing anything.

## First run on the Mac

- The Set up Talos checklist has an Agent folder row with Create (a new agent from `install.sh`), Adopt (connect a Claude Code folder you already use; only its `.mcp.json` and MCP-app hooks change) and Choose (a Talos agent folder you have). Each says what went wrong and changes nothing when it refuses; a kit 1.x folder is offered the update as a preview. Choosing a different agent folder now drops the old folder's session id and first-start confirmation.
- New owner-only `talos-app adopt --agent-dir <dir>` (runs in Terminal only, like `enroll`); the Mac app runs it through its terminal.
- Import now starts the session and says so; the First start confirmed row can show, and the sign-in and terminal hints name real menu items.

## Small follow-ups

- The agent can no longer create a thread whose id starts with `talos__` (the app uses those), the wildcard guard message now names `agent-request.json`, the session-start hook's identity and setup code moved to `hooks/_talos_session.py`, and the unused `consumeStepupTokenNow` is gone from the relay.

## Optional setup interview

- The setup interview is now an optional skill the agent offers once, one wave at a time, and Settings > Agent has "Set up my agent" to start or resume it in a Setup thread.

## Agent identity from Settings

- The agent's name, the owner's name, timezone and quiet hours now reach it at session start from the app's settings, so a rename needs no CLAUDE.md edit.

## One install script

- `./install.sh` in the repo root sets up a working agent from a fresh clone (kit, MCP server, a launch script that loads the Talos mod with `--plugin-dir`, and the Mac app on macOS); `--no-app` for terminal only, `--dry-run` to preview, and a second run changes nothing. On a Mac it also writes the app's `desktop.json` (agent folder plus the mod and channel flags, other keys kept, old file backed up, a different agent folder left alone with instructions), never quits a running Talos, and refuses to move an agent that belongs to another clone unless `--repoint`. A half-finished kit copy or a first commit that failed is resumed on the next run; an existing agent's verify-install problems are warnings. Without `--yes` and without a terminal it stops and asks for `--yes`.

## Saved setup versions

- The agent's file tools are now denied writes to the saved setup versions that `restore-last-good` uses (re-run `talos-app install-guards`). This is a speed bump, not a lock: it does not cover every spelling (`unlink`, `find -delete`, `tar` or `unzip` extraction, relative paths, interpreters), and the agent runs as you, so the saved versions are not protected from a determined agent. The protection is that a restore shows you what it will change and keeps a backup, and a restore the agent asks for goes through you.
- A restore only picks versions saved after a healthy start; a pre-restore backup is restored only by `--version N`, with a note saying what it is.
- A restore through a link to a file outside the agent folder warns even with `--yes`.
- A made-up version folder with a far-future name can no longer stall saving.

## Menu-bar icon

- The Mac menu-bar icon is now Talos's head instead of a flame and a bell, with a pulse, a dot, a slash or a faint look for working, needs you, down and unknown

## Theme picker

- Settings: pick one of three themes

## Agent session environment

- The agent session no longer inherits another Claude session's markers, which turned off transcript saving.
- The same holds for "open claude here" and the Copy Terminal command (which now unsets the markers in the shell you paste it into); the bridge finds a polluted Claude session by walking up its process tree.

## New agents work right away

- New agents work right away: the setup interview is optional.

## Themes

- Themes: three stock themes and safe theme tokens

## Mascot idle animation

- The Mac companion no longer stands as a still picture: Idle and Needs you play real body animation (breathing, weight shift, head and arms in Idle; rocking, glancing, a beckon and a toe tap in Needs you), and every 3 to 10 seconds he moves on to a different clip (a look around, stretch, scratch, tinker, sit) with his base loop between them. Reduce Motion and Low Power still hold one pose.

## Tool prompts as cards need a restart

- Turning on tool-prompt cards now says it needs a session restart, instead of showing On while prompts still go elsewhere.

## Settings history

- Talos keeps the last 20 versions of config.json in config-history/.

## Download or share any attachment

- Every file the agent attaches (HTML, PDF, audio, images, documents) has one Share or Download control, and a file chip is that control. In the iPhone app it opens the iPhone share sheet (Save to Files, AirDrop, Mail) through the app itself; install the new app build for this, an older build opens the file in its viewer instead. In an installed web app on a phone the file is prepared before you tap, and if the browser refuses the share sheet you are told to open the file and use Safari's share button. On desktop and in the Mac app it saves the file under its own name. A file the relay no longer has says so instead of failing.

## Doctor checks Claude Code

- `talos doctor` (and `--json`) now lists the Claude Code mods you have installed, warns when the Talos mod is older than this checkout's, names any shipped kit file you edited, and points you to `claude doctor` in Terminal for Claude Code's own checks. A `claude` that is missing or takes over 5 seconds is a warning.

## Mac app restarts the agent when asked, and restores once when it keeps failing

- The Mac app now acts on `agent-request.json` in the Talos home folder, which the bridge writes when you tap "Restart agent" on the phone. A request is acted on once per `control_id` and at most one per two minutes; one older than five minutes, or dated more than a minute ahead, is ignored; a file that is not exactly the agreed format is deleted and never acted on. Restore is not a phone action: it stays in the Mac menu and Terminal. The menu shows a line when it restarts ("Restarted the agent: asked from your phone"), so a request you did not make is visible. `control_id` may be only letters, digits, `_` and `-` (up to 64), and a link or a file over 4 KB is ignored.
- Separately, the app puts back the last good setup by itself, once, when the agent crash-loops (the point where it already stops restarting) or when the bridge has been down for five minutes while the agent runs, then restarts it. It runs `talos-app restore-last-good --yes --newest-start`, taken from your `talos_app_command` or the login PATH, never from the agent folder. The menu line says which files it wrote and the date of the version; a quiet banner says it happened. If the restore fails, it stops there: no restart, no second try. The one-restore limit resets after the agent has run ten minutes with the bridge up.
- New `talos-app restore-last-good --newest-start`: uses only the newest version saved after a healthy start (never an older one, never a restore backup), says "Nothing to do" if the folder already matches it, and prints one `restore-last-good: restored <files> from the version saved <date>` line. It cannot be combined with `--version` or `--file`.
- Your Stop at the Mac wins: a phone request while you have stopped the agent is ignored (the menu says so), and a Stop pressed while a restore runs is not restarted over. The five-minute bridge-down count only runs while the Mac is awake and after the bridge was seen up in this start, so waking from sleep or an old `status.json` does not restore. If a phone restart or an automatic restore lands on the dev-channel warning, the app posts "press Enter at the Mac" to your default thread.
- Security: the agent can also write `agent-request.json`, so it can make the app restart the agent (at most every two minutes), and it can write the saved versions the automatic restore reads. See "The agent as the attacker" in `docs/SECURITY.md`.

## Restart or restore the agent from your phone

- Settings → Agent has a new Restart agent button that asks your Mac to restart a stuck agent without going through the agent; with the Mac offline the screen says recovery needs the Mac app running. Putting back the last good setup is done at the Mac (the Talos menu or Terminal), and the screen says so: the Mac cannot tell a restore the phone asked for from one the agent asked for. An old app that still sends a restore gets a plain "this needs the Mac now". A success message means the request was handed to the Mac app through a request file (the file's rules are in docs/bridge.md); the Mac app's side of that file is not part of this change. The guards deny the agent a write to that file. Update order: the relay first, then the bridge, then the apps (an older relay refuses the new frame and nothing happens).

## Apps ask before sending a message

- A message an app wants to send, or its request to go full screen, now waits for your tap on a sheet fixed to the bottom of the screen that names the app and shows the text, with Send (or Allow), Dismiss and Stop asking; nothing behind the sheet takes taps, the main button ignores presses for the first 600 ms, and an app's write always gets its card, even in trust mode.
- Update order: the relay and the bridge read `app.request` strictly, so update the relay first, then the bridge, then the apps. An old relay or old bridge refuses a message from the new app (it fails closed: the message is not sent) instead of sending it unconfirmed.

## Locks and tripwire

- Commands that approve devices or change keys (`enroll`, `devices`, `rotate`, `trust on`, `memory init`, `apps scan`, `install-ask-rules`) now run only in Terminal, `talos-app install-guards` adds opt-in guards that stop the agent editing the never-change list, and the Inbox warns you, naming the fields, if the device list or security settings change outside Talos, or if the tripwire's own record is tampered with. These are speed bumps against a careless or misled agent, not a wall against one set on getting through; `docs/SECURITY.md` lists what still gets past them.

## Tool prompts on the phone by default

- New installs (`talos-app init`) start with tool prompts as approval cards ON, and existing installs keep their setting, even if it was never set.

## Mac app microphone

- Mac app: dictation, voice notes and live calls can use the microphone in the Talos window (the web view refused it before). Only the Talos page gets it; a refused microphone now points at macOS System Settings.

## Mascot fixes: Quick Compose and going home

- Opening Quick Compose (the hotkey, the menu bar or the app menu) now stops the mascot's walk first, so the compose box opens beside him where he stands instead of beside a spot he is about to leave.
- If a walk is cut short while your pointer rests on him or on his home spot, he used to stay up to 176 points off it. Now, once the pointer is away from both places and nothing is open (no bubble, tray, reply card, controls, right-click menu or compose box, no drag, no call), he goes home on the next 2-second refresh. He never moves while the pointer is on him or on his home spot, and a Dock or Space change alone never sends him anywhere.
- Checked with unit tests only; none of the Mac window tests were run for this change.

## Mac polish 3: Quick Compose lines

- Quick Compose no longer says "Your text is kept." over an empty box. If the page refuses your Send after you emptied the box, it still says "Talos didn't take that (is it open and signed in?)." without the second sentence. "Talos went away before answering" also still shows over an empty box, because that message may have gone.
- Quick Compose keeps its short lines when the page changes while it is open: "Sent. Your newer text is kept.", "Pick a thread." and the other lines a Send leaves. A thread that is gone, no threads listed, or being signed out still replaces them. Opening the panel again clears those short lines, but the warnings stay across a reopen: "didn't take that" until you type or send again, "went away" until you empty the box or a Send is taken.
- `node scripts/size-report.ts --refresh-budget` now also drops listed files and functions that are at or under their limit, as AGENTS.md says, instead of keeping them at the lower number.
- Checked with unit tests and the fake-session tests only; none of the Mac window tests were run for this change.

## Review follow-ups, batch 5

- A note that something can't be shown by this version now stops at three per conversation; when only one dictation recording is too big for what is left of today's limit, the app works out from a number the relay sends how much is left and says so, and "used up" is kept for when none is. `talos-app restore-last-good` writes through a setup-file link (say, into a dotfiles folder), keeps the link, and prints the real file it wrote; it refuses a `.claude` folder link that leads outside the agent folder, and a broken file link whose target is outside (it names the saved copy to copy by hand). When the push check runs out of time on the type check, it still prints the type errors it found and says the push continues.

## Setup file follow-ups

- Running `install-mcp` again keeps env keys you added to the `talos-app` entry in `.mcp.json`; `talos-app restore-last-good` now refuses, and says what to do, when `.claude` is a link to a folder outside the agent folder; and the 3 newest saved start versions are always kept, however many restore backups pile up.

## Run, dictation and note follow-ups

- A Run the relay dropped now says it did not reach your Mac instead of "Sent to your Mac"; dictated words no longer move focus into the message box on a phone or tablet in a browser or Home Screen (so the keyboard does not pop up); and the "update the app" note only goes into a thread in the thread list.

## Mac follow-ups: Rounds, Quick Compose and the start question

- The longer Rounds walk no longer sets off while the mascot cannot be seen (screen asleep or locked, or its panel covered by another window). A Rounds walk that comes due then is skipped, not put off until later.
- Quick Compose stays current while it is open: when the thread list changes, you sign in or out, or the page reloads, the thread picker and the line under the box update, and a draft keeps the thread it was written for.
- Quick Compose keeps "Talos didn't take that" through a refresh while you are signed out, so it is still there when you sign back in. Typing or the next Send ends it.
- The Mac app puts back its question about the dev-channel warning ("press Enter", or why a restart was not confirmed) when that warning returns after the start had been reported as stalled, instead of a general dialog warning.
- Checked with unit tests and the fake-session tests only; none of the Mac window tests were run for this change.

## Thread names that clash with built-in names

- A thread named "Constructor" now gets the id `constructor_thread`. Before, its id was a name every object already has, and the thread list could crash on it. The same goes for threads the agent creates.
- A thread already saved with the id `constructor` keeps working: the bridge starts, the app opens it, and its unread count stays right. Only new threads avoid such names, whether made from the app, by the agent or by a settings change.
- When the daily dictation limit is used up, the message says so and suggests sending a voice note; when some is left it still says to try a shorter one.
- A note about a card this version cannot show now lands in the card's own thread on the first connect, not in the default one.

## Undo a broken customization

- New `talos-app restore-last-good` (also `talos restore-last-good`): after each clean start the bridge saves the agent folder's `.mcp.json` and `.claude/settings.json` / `settings.local.json` as a new version in `$TALOS_APP_HOME/last-good/` when they differ from the newest one, and keeps the last 10. Only files that parse and have the right shape are saved (regular files up to 1 MB), so a broken file never replaces an older good version. The agent folder comes from `TALOS_AGENT_DIR`, which `install-mcp` / `install.sh` now write into the `.mcp.json` entry (run the installer again on an existing setup; without it nothing is saved and the bridge log says so). The command lists the versions with their dates and files and restores the newest one that differs from what is there now, or `--version <n>` / `--file <name>`; it writes into the agent folder recorded in the version, saves the files it is about to replace as a new version first (so a restore can be undone), refuses a file that changed while it waited, names the files it wrote even when one fails, moves aside (after the y/N) a setup file that exists now but is not in the chosen version, keeping its content in that backup, and asks y/N unless `--yes`. `doctor` warns when the `.mcp.json` entry has no `TALOS_AGENT_DIR`. Owner only; the agent is asked about it on the phone like `rollback`. Tested with unit tests and the real server process; not tried against a live Claude Code.

## Dictation limit message and update notes

- When a recording does not fit in what is left of the 24-hour dictation limit, the message now says that recording is too long for what's left today and suggests a shorter one or trying later, instead of saying the limit is used up. The "update the app" note is now capped at 20 per session, is placed in the default thread when the thread is not one this app knows, and a reload no longer adds a second note for the same card. A thread named like `constructor` can no longer stall catch-up. Checked with unit tests only.

## Mac mascot and Quick Compose follow-ups

- The mascot no longer sets off on a short walk while it cannot be seen (screen asleep or locked, or its panel covered by another window); it waits and tries again later, as it does for other things in its way.
- If you return while it waves to nobody, the wave now stops, like its other small things.
- When a walk stops because the pointer is over where it stands, it stays there instead of jumping home, so the pointer does not stay stuck "inside" it after the window moves away. If the pointer is over its home spot instead, it also stays, as before.
- Waking the Mac starts the wait for the next short walk over, as it already did for the small things.
- Quick Compose: Send is now off for a message that is only spaces or too long, and the line under the box says why. The line for a draft whose thread has gone now also says to pick a thread to send it. A reason left from a refused Send no longer stays in front of the "Talos went away" warning while you type; that warning still stays until the box is emptied or you send. A message the page did not take keeps saying your text is kept even when Send is off for another reason.
- The Mac app puts back its earlier question ("press Enter on the dev-channel warning", or why a restart was not confirmed) instead of a general dialog warning when that dialog comes back after another dialog was dealt with.
- Local CI: a cancelled run of the iPhone job now shuts down the simulator it had to start, as a finished run does. Tested with stand-in tools only.
- Checked with unit tests on a fake clock only; none of the Mac window tests were run for this change.

## Bridge follow-ups

- A card queued while the relay was unreachable and then refused by an older relay now tells the agent to update the relay, not just to send it again. `memory reindex` now refuses when the memory browser is off and swaps in the new index in one step, so a live search never sees it empty. The docs now say plainly that the ask rules are a speed bump, not a boundary: an agent that tries can get past them with other spellings, and rollback stays safe because it shows what it will do, keeps a backup and can be undone. A `memory reindex` that fails partway now keeps the old index and exits 1. Checked with unit tests only.

## A newer card or message type is no longer dropped without a word

- When the app meets a frame type or card kind it does not know (a newer relay or Mac), it now adds one plain note to the thread: "Something arrived that this version of Talos can't show. Update the app to see it." Once per item, and no more than one per thread for the same kind in a session, so a reconnect does not repeat it. A malformed card of a kind the app does know is still refused with no note. If an older relay refuses a card kind it does not know, the agent is now told the relay needs an update. Checked with unit tests only.

## Map and cleanup

- Added `docs/CUSTOMIZE.md` (where to change a theme token, a setting, a card kind and an agent tool), `docs/protected-paths.txt` (files a customization must leave alone) and a short `CLAUDE.md` that points to `AGENTS.md`.
- Removed the reference copies under `third_party/hermes`, `third_party/openclaw` and `third_party/claude-plugins`; their licence text and attribution now live in `THIRD_PARTY_NOTICES.md`. Removed unused screenshots from `docs/screenshots`.

- New `talos` command, a front door over `talos-app` (which keeps working as before): `talos commands --json` lists each command, what it does and whether the agent may run it (a mark only; nothing enforces it yet), `talos doctor --json` returns the doctor checks as rows, and `talos status` and the rest run the same handlers as `talos-app`. There is no `talos` on your PATH yet, so for now run it through bun: `bun run apps/bridge/src/talos.ts <command>`. Tried with unit tests only.

## Local CI runs only the jobs a change can affect

- A push or pull request now runs only the CI jobs its change can reach. Web, docs and `CHANGELOG.md` changes skip the Mac app and iPhone jobs; bridge and relay changes skip them too; a desktop-only change skips the browser job and the iPhone job; a mobile-only change skips the browser job and the Mac app job. A change to the protocol, testkit, scripts, the lockfile or root config, or to any path the table does not name, runs everything.
- A skipped job is posted as `local-ci/<job>` success with the words `skipped: no affected files`, never `passed on`. The change is compared with the last commit whose jobs were all green (the inner commits of a push have no status, so it is not just the parent); if that commit was red, partly reported, or cannot be found, or GitHub cannot be read, every job runs. `ci-runner.sh verdict` counts those words (and only those, never for `check`) as a green commit and lists the skipped jobs apart.
- A manual run of the runner (`workflow_dispatch`), `--full`, `--jobs` and `--no-status` never skip, and neither does a run with `TALOS_GUI_TESTS=1` or `TALOS_CI_FORCE_DESKTOP=1`. A rerun of a commit that already has `local-ci/*` statuses (the GitHub re-run button, `ci-local.sh --ref <sha>`) runs every job, so a skip can never cover a failure the first run found. There is no nightly full run yet.
- The mobile job's simulator time limit is now 600 s instead of 900 s, so its worst case (2880 s, the simulator steps only) is under the 3600 s a run waits for the `suites` lock; before, a run waiting behind a hung simulator could give up first (worst case 4080 s).
- Looked into the browser job's length: a 3.5-minute run with 9 workers was a red run that stopped before the end-to-end suite, not a faster one. No change; the findings are in `docs/CI-LOCAL.md`.
- Tested with a fake `gh` and throwaway repositories only; not yet seen on the real runner.

## The Mac mascot is no longer just standing there

- While idle and awake the figure now moves all the time: it rises and settles a point every few seconds, blinks every 3 to 8 seconds (it was every 8 to 20), and does a small thing every 12 to 35 seconds (stretch, scratch, tinker, sit, a little wave, a look around), never the same one twice in a row. That used to be once every 1 to 3 minutes. It no longer naps or stumbles as one of these; it still dozes off only when really asleep after 30 minutes untouched. Left alone, the pauses get longer: 1.5 times after 5 minutes, 2 times (the most) after 15.
- Every one to three minutes it also walks a few steps along its line and back, using the running clips. It never sets off with the pointer near it, with the tray, compose box, controls, a bubble or a reply card open, while you drag it, during a call (the microphone is in use), while it talks, or in the quiet window; hovering, clicking or dragging stops it where it stands, and any other reason to stop (a call, a new state, a screen change) sends it home unless the pointer is over it or over its home spot. Rounds are unchanged.
- "Rounds and little moments" off in Mac settings (on by default) now stops the small things, the walks and Rounds. The rise and settle, the blinks, the ember, his direct reactions (a hop for a reply, a click, being dragged) and dozing off and waking up all stay. Reduce Motion and Low Power Mode still show a still picture, as before.
- Only the Mac app was changed. The timing is checked with unit tests on a fake clock; the real motion and its CPU use were not watched on a Mac yet. The figure's idle bob steps twice every few seconds in time with the glow, with no smooth animation, to keep WindowServer quiet.

## Bridge follow-ups before going public

- A scheduled session job is now timed out at Chronos's own `timeout_min` (read from its config file, with Chronos's own defaults of 40 and 45 minutes for anything missing or unreadable, a leading `~` in the path expanded, numbers written as text accepted, never below one minute), held a minute under `stale_claim_min`. Before, a fixed 60 minutes let a healthy run on the default 40/45 settings show "A background run is stuck" at 45 minutes.
- The rollback ask rules catch the spellings an agent can use (`"talos-app" rollback`, a quoted path to `cli.ts`, `pnpm cli rollback`, extra spaces, a quoted `"rollback"`) and no longer ask on a `git add` of rollback.ts or a commit message that mentions it. `talos-app doctor` now also reads `.claude/settings.local.json`, counts the older `Bash(git push:*)` spelling, and says when rollback has no card rule.
- `talos-app rollback` tells you when recorded versions exist but are not in your branch's history (after a rebase), refuses, changing nothing, when any file or folder of yours (ignored by git or not, including odd names and dangling links) sits where the older version has a tracked file, and puts a branch back with `git switch` so a tag of the same name cannot leave you detached.
- More than ten files sent together now all reach the agent (the rest are named in the text), and a long backlog after the Mac was offline is split into several notifications of at most about 256 KB each (a guess at a safe size), each marked read only after its own part is handed over.
- The note shown after a damaged history is set aside now says a message waiting for a thread's own session, not yet read by it, is lost and should be sent again.

## Cards and page leaving: clearer failures, no hidden characters

- A card error with no details from the relay now says "Didn't hear back. Check whether it ran before trying again." instead of "Something went wrong (internal)".
- Card button labels, the title of a collapsed, sending or altered card, a card's result and note, and its Details pane now show invisible or direction-changing characters as visible tokens, like the rest of the card.
- A download link no longer makes the app think the page is leaving, so a replaced app file after an update still reloads by itself.
- Checked with unit tests only. The other parked findings were not done, or were already fixed; see the branch notes.

## Quieter after a declined device, steadier digests, and truer card updates

- A browser or Home Screen app the Mac declined no longer gets push notifications; its subscription is ignored until the device is approved. A digest batch that fails to send no longer holds back the batches behind it, and a failing step in the relay's periodic work no longer skips the steps after it.
- An approved card whose note to the agent is still being written no longer ends up showing "resolved" after it was already marked failed. A card cut off by a restart while an app was running it now says it may not have run, instead of pointing to Schedules.
- Tried with the relay and bridge test suites; no real phone or Mac.

## One-tap dictation in the message box

- A new dictate button sits next to Send and the voice note mic whenever your relay has `OPENAI_API_KEY` set. Tap it, talk, tap stop (it stops by itself at 10 minutes, with a warning in the last minute). The words appear at the end of the box, after anything you had typed. You edit them and tap Send yourself; dictation never sends.
- The recording goes through your relay to OpenAI (`TRANSCRIBE_MODEL`, default `gpt-transcribe`). The relay keeps no audio and no words: they exist in memory only for that request, and logs hold sizes and status codes only. Limits: 40 dictations an hour and `DICTATE_DAILY_MAX_MB` (100) a day. See `docs/voice.md` and `docs/SETUP.md`.
- If it fails (offline, over a limit, OpenAI down or slow) the recording stays on the phone with Try again and Send as voice note; it is dropped when you leave the thread or are signed out.
- Tested with a fake OpenAI server on the relay and with the composer in jsdom. Not tried against the real OpenAI service, on an iPhone, or with a real microphone; the button's fit at phone width was not checked on a device.
- Fixed after review: the relay waits for OpenAI up to its own deadline instead of cutting off at 15 seconds, and cancels the call when you leave. The daily cap is kept in the relay's database and counts a call as soon as it is sent. Words are always added at the end of the box and never overwrite anything. A failed recording blocks Dictate, the voice note mic and the call button until you pick Try again, Send as voice note or Discard. A recording that stopped by itself keeps what it captured and says so. A signed-out answer ends the session in the app.

## The Talos window opens when the Mac app starts

- Starting Talos on the Mac used to show nothing but a menu bar icon, and it was easy to think the app had not opened. It now opens the main Talos window once each time it starts, including when it starts at login, as long as a relay address is set up. If you would rather it stayed in the menu bar, turn off "Open the Talos window at launch" in Mac settings, General (it takes effect the next time Talos starts).
- The decision logic and the setting are tested; actually opening the window at launch was not tried on a real screen.

## The Mac menu bar no longer flickers while the terminal window is open

- With the terminal window open, the Window and Help menus at the top of the screen kept jumping. Once a window exists, macOS adds a "Close All" item in the middle of the Window menu; Talos did not expect that, took the menu for a replaced one, rebuilt it, and macOS added the item again, over and over. Talos now only rebuilds the menu when items of its own are really gone, and rebuilds at most three times a minute (it writes one line to the log if it ever hits that).
- Checked with the real menu code and a pure-data test; the live app's menu bar was not watched.

## The iPhone app no longer reads past crash reports at launch

- At launch the iPhone app also asked the system for crash and hang reports it had already been given. Apple's documentation says that list leaves out earlier launches, so the read was not needed and is removed: the app takes a report only when the system delivers it. Whether the read ever sent an old crash a second time was never seen, and is not proven.
- Not tried on a real phone: the simulator never produces system crash reports. The iPhone shell's tests that only read the Swift source now check what each part does, and the ones that could not fail are fixed.

## The Mac app has a Terminal item that shows the agent inside the Talos window

- In the Mac app, the sidebar now has **Terminal**, next to Search, Memory and Settings. It shows the agent's live terminal inside the Talos window, so you can watch it and type to it without opening **Terminals…**. It is the same session: leaving the item or closing the Talos window ends only the view, and the agent keeps running in the background. The item does not exist in a browser or on the phone, and the Terminal screen is not a relay route: nothing the terminal shows or types goes to the relay.
- The separate **Terminals…** window works as before. If both are open they are two views of one session, and the agent's screen takes the size of the view you opened, resized or typed in last. If the agent is starting you see the same note the window shows until it is up; if it stopped you see its last screen. A Mac without tmux 3.2 or newer says so in the view and points to **Terminals…**.
- The view shows only when the window has room for 80 columns and 24 rows, so it never squeezes the agent's own screen (tmux keeps the size a viewer gave it, and a very narrow screen hides the dialog the app needs to confirm a restart). Below that, the page says so. A page message never gives the view the keyboard: you click in it to type. The view closes while a sheet or dialog is open, and when you sign out. A page the relay controls could still show the view; it cannot read or type into it (`docs/SECURITY.md`).
- Needs the matching Mac app. An older Mac app shows the Terminal item with a line saying to update it, and nothing else.
- Tried: the page and its messages in tests and a browser, and the Mac app's rules for where the terminal goes. Not tried on screen: the terminal over the real window, typing into it, resizing it, or two views at once.

## Error reports: honest times, no muting, and the Mac names its own version

- A report held for days (the phone was offline) now shows when it happened, not when the Mac got it. The hash in a built file's name is left out of an error's identity, so an unchanged chunk's new hash no longer opens a new problem (renamed functions in a rebuilt app still can).
- The relay and the Mac keep an hourly cap on their own errors that rolls, and say how many it held back (a warning in the relay log; one line in the Mac's daily notice). A superseded bridge stops filing, so two bridges never write one folder.
- Reports now carry the relay's version and the Mac's version. "Report a problem" starts a new report after each one is sent or saved on the phone (before, a second send could be dropped as a replay of the first, or replace the one waiting), stamps it with the time you press Send, and says when older queued reports were dropped. A report that failed before it was saved keeps its note and time for the retry.
- Tried with the unit and integration suites; not tried on a phone.

## Trust mode leftovers: longer sign-in records, the upload budget, and honest wording

- A sign-in longer than 45 days (`SESSION_TTL_DAYS`) kept its "why it ended" record for only 45 days, so a phone coming back after that wiped its unsent messages. The record now lasts 365 days, the longest a sign-in can be set to, so lowering `SESSION_TTL_DAYS` later cannot bring the wipe back.
- Files sent through a share link now stop at the daily upload budget you set (`MEDIA_DAILY_MAX_MB`), not a fixed 200 MiB; share uploads keep their own budget too.
- With trust mode on, a message that wakes a stopped thread session while limits are close (the 80 to 85 percent band) now says so in the thread, once, on the message that starts the session, as the Resume button already did. Settings → Thread sessions no longer says sessions are "paused" in that band; it says limits are close and sessions still start.
- Corrected wording: Pass through keeps nothing once the Mac has taken an event into Claude (an event collected in the quiet window waits for the digest, then an hour). The relay also kept a sealed copy of the event's frame (title, summary, sender, link) in its replay buffer for up to 7 days after that, and did not remove it when the hour ran out; it now drops the copy when the Mac reports the event or digest consumed, or within about two hours. A Mac that dies after taking a frame but before using it still gets it again; in trust mode the bridge may apply a settings proposal directly; archived threads still count toward the 40-thread limit; a sign-in's end moves forward each time it is used; the schedule and security docs now say schedule cards skip Face ID in trust mode. `docs/SECURITY.md` now states that an offline Mac leaves the relay on its last synced trust setting.

## The relay stops its background timers when it shuts down, and the end-to-end journeys cover more

- A relay that was stopped (a redeploy) left its once-every-30-seconds hooks check running on a closed database, so a later tick could log a false "hooks tick failed" error. With voice switched on it also left the hourly voice-usage sweep armed (first run 60 seconds after start). Both are now cleared with the relay, through the same stop hook every other module uses, and a test starts a relay with voice on and off, stops it, and counts the timers left (none).
- Quiet hours (Settings, Notifications): a time typed into the other box while a save was still running was thrown away when the save finished, so End snapped back and the saved window was wrong. The box you typed in is now kept and saved when you leave it.
- `pnpm drive` now says why a run is empty (a journey that fails to load, a `--grep` that matches nothing), refuses several journey names or flags it does not know instead of quietly running one, refuses extra words after `list` or `help`, repeats a flag's value in its hint (`-- --repeat-each 3`), treats a short flag (`-g`) as a flag, and puts the journey name on every line.
- New journey checks: the Chat notifications and Quiet hours switches change the config and whether a reply is pushed (the Quiet hours check waits for both times to be saved, and was run at 07:30 in the config's timezone, where the leftover 22:00 to 07:00 window cannot cover "now"); a tap held for a Mac that comes back after the card expired is not acted on; an approved card with no result stops saying "Working on it"; a revoked device is signed out and refused a new socket. A few existing checks that could not fail were fixed.
- Not reproduced: the Safari-only flakes in the Settings browser tests ("interrupted by another navigation"). A helper added earlier to wait for the router did not change the outcome in 360 runs and was removed, so no cause is claimed. If a CI test fails this way again, its full error text is what is needed.

## An altered card now shows its title with hidden characters spelled out

- A card the app judged "altered in transit" showed its title as received, so a direction override or an invisible character in it was obeyed instead of shown as a token. It now shows them as visible tokens. This covers the title of an altered card only; the other lines of a card (the Details pane and the labels) are handled on a separate change. The permission card and Home's card rows had no test for this; they do now.
- Test-only: the stand-in relay used by the app and bridge tests now refuses what the real relay refuses (an expired card, a wrong hash, a second tap on a decided card, a card whose hash is not its content, a media fetch with the Mac offline, a rotate signed by the wrong key, a device that is not the session's or not pinned), puts a card the Mac refused back to pending or expired and tells the apps, and does not reopen a decided card when the Mac re-sends its creation. Those cases now live in the shared relay contract, so they run against the real relay as well as the stand-in, and the real relay's answer is the reference. The stand-in is split into several files so none passes 1,000 lines. Tests of the Mac's own refusals (a wrong hash, a second approval) send the frame past the stand-in's checks, so the Mac is what says no. Other tests were tightened so they can fail: the push-failure card branch, the raw-payload wipe after the Mac takes a work event, push secrets in logs, the dead-Mac report running once, the unreadable-row digest note, `secure_delete` being on before a row is rewritten, and the failed-storage recovery screen. The health test button now reports a push subscription that no longer opens as a failed send instead of "nobody to alert". Unused imports and variables were removed.

## Mac app: warnings no longer vanish or repeat as the screen changes, and Quick Compose keeps its guard

- If a login or other dialog covered the "looks stuck" or "has not finished starting" warning and you answered the dialog, the warning was lost for good. It now comes back while the cause stands, and you are not told a second time.
- A dialog that replaces another one on the screen (login expired, then a folder-trust question, then login expired again) is now told as its own question each time. Before, the second login question raised nothing.
- A screen the Mac could not read for a moment (tmux timing out under load) no longer counts as "no dialog": it used to end the warning and raise it again a moment later. A screen that cannot be read at all no longer hides a start that never finishes or a session that dropped out of the agent list: those warnings still come. A read outage also no longer stops a healthy restarted session for "no registration notice": it cannot tell, so it warns instead.
- When Talos refuses to press Enter for you on a restart, the reason shown now follows the latest clear look at the dialog. Before, a screen caught half drawn could leave "two dialogs" as the reason for good. Nothing more is pressed, and you are not told twice.
- The old development-channels title left on screen after you pressed Enter no longer keeps the "press Enter" question open; the dialog counts only with its choices showing. In a pane too short to show the title, the dialog is reported as a question Talos does not know, so you are told and nothing is pressed for you (a row of text that only quotes the dialog is never taken for it).
- Quick Compose: when you send "a" and, while it is sending, type a second line, the second line is kept and only the sent text leaves (before, the whole box stayed, sent text included, when what you sent ended in a line break).
- Quick Compose: the line "Talos went away before answering. Check the thread before sending again." now stays while the box has text. Typing, closing and reopening the panel (also while the page reloads and lists no threads), picking a thread, and a Send that is refused or not taken no longer clear it; such a Send says why on a line above it. Sending again on purpose still works.
- Not covered: the "has not finished starting" time still counts from when the session started, so answering a question late can show that warning for a moment; and a page that stays open but never answers a send leaves Send off, because there is no signal for how long saving may take.
- Tried with the real supervisor against a fake Claude on a private tmux server and an owned terminal, and with the real compose panel against a web view that is never shown. Not looked at on screen.

## A Run button under shell code blocks

- A shell code block (or one with no language) in your agent's message now has a Run button. Tapping it is your approval of that script: it sends your own signed message, and the Mac, not the agent, checks it before your agent hears of it. It must be that one block and nothing else, signed within the last day (so it can arrive up to a day late), not from before a history reset, and for a block that has not run. A Run never joins a backlog note. Your agent runs exactly those bytes once and replies with the exit code and the output.
- One block, one Run, enforced by your Mac, from any device or screen. The Run names its block (the agent's message and the block's place in it), and the Mac remembers that block as run for 8 days; a second tap, from another device, a search result or after a reload, gets a plain line in the thread. A block whose message is over a week old is refused too ("That script is over a week old. Ask me to post it again."), so a block that can run is always one the Mac still remembers. A script your agent posts again is a new block and can run once. After a tap, a screen shows what its own tap did and no Run; after a reload it may show Run again, and the Mac refuses. A history reset forgets which blocks ran.
- A thread that has its own session gets no Run button, and the Mac refuses a Run for one with a plain line in the thread, whether or not its session is running.
- Run takes one tap only for a script of plain printable ASCII with at most 6 lines and 300 characters. A longer script, or one with look-alike letters, special spaces or accents, asks a second time. Hidden or direction-changing characters (blank-looking ones too) show as `⟦U+XXXX⟧` and turn Run off; so does a script over 4,000 characters. Words that merely say "Run exactly this:" are only words.
- The Mac does not check that the script came from your agent: the tap is what approves it. There is no Face ID on Run, by your choice: a thief holding your unlocked, signed-in phone could ask your agent to post a script and tap Run, past cards and Face ID. That phone can already message your agent as you.
- Run needs a Mac with this update; older Macs show no button. The Copy button on code blocks now sits above the code instead of over its top right corner. Your own typed messages are plain text, so a fenced block you type gets no Run button.
- Tried with real bridges and signed frames, and in a browser at phone width in both themes; not tried against a real Mac and agent.

## A thread session's decision that never got acted on is no longer silent

- When a card was raised by a thread's own session, your tap was passed to that session first and counted as told. If the session never picked it up and the Mac's main session then could not be told either, an approved card stayed approved and you heard nothing. It now ends as failed ("Your agent didn't get this, so nothing ran. Ask it again when it's back."), and a Kill or Ask for changes gets a note in the thread ("Your Kill didn't reach your agent. Nothing was running."). The same happens when the thread's own session is switched off while the tap waits. Nothing is sent later.
- If the session read your approval and then stopped before finishing (it crashed, was parked or restarted) without reporting a result, the card used to stay "Working on it" for good. It now stays open while the session is still running, and when the run has ended it ends as failed with "It may have run. Check before asking again.", and you get a note in the thread.
- A session that sent its result and then died before the Mac recorded it keeps the card as done; it is not failed afterwards. A file from shared material also no longer has its name in the plain fields of a 15-minute backlog notice.
- Tried with real bridges against a stand-in relay and a fake clock; not tried with a real thread session.

## A stranger's shared file name stays inside the wrapper

- A file shared with a share token reached the agent with its name in a plain field beside `trust=external`, outside the wrapper, and with no length limit. A file shared from the signed Share page had the same problem next to `trust=owner`, and also in the note when the file could not be downloaded and in the note posted in the thread. In both cases the name now appears only inside the wrapper, cut to 100 characters; a file that could not be downloaded is called "a shared file". The agent can still retry a Share-page file, and the retry answer no longer repeats any file name. A file you attach to a normal message is still named, cut to 100 characters too (it was up to 200).
- The shared page's link no longer rides in a plain field beside the message either (it is in the wrapper as before).

## `talos-app install-ask-rules` catches more spellings of rollback, and `doctor` tells an older install to run it again

- The rollback rule matched only the text `talos-app rollback`, so `bun run .../cli.ts rollback --yes` or the full path of the wrapper got no card on your phone. There are now two rules, one for the `talos-app` wrapper (bare or by any path) and one for the CLI file run directly. A rule matches the command text, so rollback started some other way (`bun -e`, a different file) is still not caught. Run `talos-app install-ask-rules --agent-dir <dir>` again to get them. Not tried against a real Claude Code prompt.
- `talos-app doctor` used to say "ask rules: ok" for any non-empty list. It now warns, and names the missing rules, when the list lacks any of the standard ones, so an install from before a rule was added is told to run the command again.

## Relay follow-ups: fewer false alarms, and nothing acknowledged that changed nothing

- A card you decided is no longer reported as lost. If your Mac took your decision, decided the card, and the relay never heard that the Mac passed it on, the relay still told you after 7 days that the decision "never got to your agent". It now says nothing when the card shows your Mac's decision, and sends no day-6 "wake your Mac" push for it either. To make that possible the relay now keeps a decided card for as long as a decision about it is still waiting for your Mac, where before it deleted the card 7 days after it was made, which could be before the decision came due. A card row that no longer opens counts as undecided, and no longer stops the other "not delivered" reports (for a decision made in the app and for an Approve tapped on a notification alike). When the relay gives up on a tap your Mac never confirmed and the card is already past its expiry, the card is now closed as expired, where it would otherwise have been put back to open and stayed open for good.
- Wording is true for a message your Mac took too. A message or voice note the relay gave up on now reads "did not reach your agent" instead of "Your Mac never got this message", and the day-6 push reads "Your messages have not reached {agent} yet. Wake its Mac today.".
- Unreadable inbox items are counted. If a stored inbox item no longer opens, the Inbox says "N items could not be read and are left out" (on Priority and Other, not Done), and the overnight digest your Mac gets ends with a "N items could not be read" line. Before, the item silently vanished from the list and the digest. The app's tab counts come from the items it shows, so they leave such an item out.
- An inbox change that applied to nothing (the item is gone, or a snooze time already past) is now refused with an error instead of being acknowledged as done, and other devices are no longer told about it.
- When the relay could not save an inbox change (a full disk, say), the app keeps the change and sends it again at the next connection or the next time you change an inbox item, where before it treated the failed save as done and never tried again. It does not retry at once.
- Not covered: older apps still treat any inbox error as final.

## Signing out empties the composer too, a replaced-key tab leaves your data alone, and problem reports tell the truth

- Every session end (sign-out, revoke, "sign out everywhere", an expiry, a sign-in over the session, or no reason given) now empties what the message box held in memory: the words of a send that failed after you left the thread, a prefill, files dropped on the chat, attachments and a quoted message. Before, a failed send's words stayed, and the next box on that thread showed them and saved them as a draft after the wipe. A send or an attach that was still going when the session ended no longer puts its words or files back afterwards, also when Settings is the one signing you out. Those words live only in that tab's memory, where nothing else (Discard, a sign-out in another tab, a new device key) can reach them, so they are not kept.
- A message you pressed just as a session expired (or was signed in over) is no longer lost, whether the end lands while it is being signed or while it is being saved: it stays in the queue, where the rules for queued messages apply (it goes out after you sign in with the same device key; with a new key it is removed and you are told). The app reports it as queued, so its words are not also handed back to the box. A voice note caught the same way keeps its recording on this device and uploads it again after you sign in, even days later, instead of keeping a reference to an upload the server will have removed by then; the text typed behind it still goes out after it. A recording made after a real sign-out is no longer saved on the device; after an expiry it still is, and is sent after you sign in.
- A browser tab that still held an old device key (the relay closes it as `device_changed`), or whose session this browser just signed in over (`signed_in_again`), no longer empties the saved chats, drafts and schedules that belong to the tab you are now using. It lets go only of what it held itself. The queued messages were already kept.
- An upload that was already going when you signed out no longer marks the next sign-in as signed out when its answer arrives late.
- A problem report sent while another report was being sent no longer says "sent" while it is still waiting; it goes out in the same run. A report an earlier run had refused no longer makes the form say yours was refused. A screenshot that cannot be uploaded now says why (signed out, rate limit, server trouble, or offline) instead of always "offline". A screenshot the server will never take (too big, wrong type, or not an image) is left off and the report goes without it, marked as shortened; before, the whole report was thrown away. A report that has to be tried again uploads its screenshot again: the server removes uploaded pictures after a while, so a saved reference could not be trusted.
- When the server is limiting reports, the form no longer says "goes out in 14 minutes": nothing was set to send it then. It says the report is saved and goes out when Talos next connects.
- Not covered: the report form line was looked at in a browser at 375 px in both themes, not on a real iPhone.

## A card approval that got no answer, or was not sent, says exactly that

- If you tapped Approve, Kill or Ask for changes and the request went out but nothing came back (12 seconds of silence, or the connection dropped or closed while it was being sent), the card showed the app's own wording ("The relay did not answer." or "Connection lost"). It now says "Didn't hear back. Check whether it ran before trying again." The card is otherwise unchanged, with its buttons, because the app cannot know whether your Mac ran it.
- If the request never left the phone (you were offline, or this device is not confirmed by your Mac yet), the card says so and "Nothing was sent." The offline case reads "You're offline. Nothing was sent."
- The app no longer claims what ran when it cannot know. An expired card used to read "Expired, nothing ran" (or "Expired: your Mac was offline, nothing ran"), also for a card that your Mac or another device had already decided. It now reads "Expired". The step-up and Face ID messages ("Something went wrong (502).", "Couldn't reach the server.", and a card that expired while you were confirming, which now says this tap was not sent) no longer say "Nothing ran", since an earlier tap or another device may already have approved the card. An error the app does not recognise says "Something went wrong."
- After a reconnect, a card that is not in your Mac's list of open cards is no longer marked "Expired" at once. The relay closes a card when it stores a decision (yours, or one from another device) and sends no update then, so the card being absent does not mean it expired, and "Ask again" on it could have led to a second run. It now stays as it was until your Mac's update arrives, and is shown as expired only once its own time has passed. A second tap on a card that was already decided gets "This card was already decided."
- Not covered: a relay refusal such as "This card expired. Nothing ran." keeps its wording. Tried with the real socket client against a stand-in relay and the card screen against a stand-in client, not on a real iPhone, and not looked at in a browser (a few words of text changed).

## `talos-app rollback` puts the Mac back on an earlier version that started cleanly

- If an update, or an agent's edit, breaks the Mac, run `talos-app rollback`. The bridge now notes the version it is running once the relay has answered after a start, and the command returns this folder to the newest noted version that is older than the one you are on. Run it again to go one step further back; it never returns to the version it left. It does not touch your messages, keys, devices or settings, and it does not move or delete any branch.
- It asks y/N first (`--yes` skips the question, for a card you approve on your phone). It stops without changing anything if the folder has changes you have not committed, if git is in the middle of a rebase or merge, or if the older code would erase or not read a setting in your `config.json` (`--skip-data-check` goes anyway). `rollback` itself starts even when an update left the packages half installed, but the settings check needs them and refuses; `--skip-data-check` is the way through.
- `talos-app install-ask-rules` now also asks you before an agent runs it. If you ran that command before, run it again to get the new rule; without the rule an agent in bypass mode can run it with no card.
- Not covered: reaching the Mac from the phone when the bridge itself is down. Nothing on the Mac listens to the phone except the bridge, so that case still needs a shell on the Mac (see `docs/SETUP.md`, "Going back"). No Talos button does it yet. Only `config.json` is checked against the older code; history, devices and keys are not.

## Quick compose no longer loses or doubles what you send

- The Mac's quick compose box now waits until Talos has signed and saved your message before it clears your text. Before, the page said "yes" as soon as it received the message, so if saving then failed (for example the device key or storage was not available) the box was already empty and the words were gone. Now a failed save leaves your text in the box with "Your text is kept." and Send back on.
- This needs both halves. The page now has a second door for the Mac app to ask through, and keeps the old door unchanged, so a Mac app you have not rebuilt yet works exactly as before (it clears your text when the page has received the message, as it always did), and a rebuilt Mac app with an older page does the same. Rebuild the Mac app (docs/desktop.md) to get the wait.
- If you keep typing after pressing Send, the answer for the first message no longer wipes it. When your sent words end at a line break and you went on below, only the sent words leave and the rest stays, with "Sent. Your newer text is kept." Any other change to the box (a different note, even one that starts with the same letters or words) is left whole; nothing is cut out of it. If the box holds nothing new (empty, or just extra spaces), it clears as usual.
- While a message is waiting for its answer, Send stays off, even if you open the box again or press Command-Return, so one press is one message.
- If the Talos page goes away before it answers (a reload or a crash), the wait ends and your text is kept. The page may have saved the message first, so the box says "Talos went away before answering. Check the thread before sending again." instead of inviting a plain retry.
- The box also treats only a real "yes" from the page as a yes. The real Talos page never answered anything else, so you will not see this change; it is covered by tests.
- Not covered: the real Talos page was not driven from the Mac app; the Mac tests use a stand-in page that answers the same ways, and the page side is tested on its own. A page that stays open but never answers still leaves Send off. If that happens, copy your text out of the box first, then reload the Talos page or restart Talos; the text in the box is not kept across a restart.

## One failed hook delivery no longer blocks the ones behind it

- When the relay stored a webhook event for your Mac but the write that queues it failed (a full disk, say), every retry then failed with "UNIQUE constraint failed: core_events.frame_id", and every later event waited behind it. The relay now stores the event and its queue entry in one step, so a failed write leaves nothing behind and the retry is a first try. A retry of a hook event or digest that finds the frame an older version stored without its queue entry finishes that entry. An event that cannot be sent no longer stops the ones after it; it is retried on every pass. The one-step store covers every frame the relay queues for the Mac. Only hook events and digests may retry under the same id; any other frame with a repeated id still gets an error.
- Your inbox and thread get each event once. If a save fails after the event was already shown (or the relay stops at that moment), the retry no longer adds a second inbox item or timeline line.
- The overnight digest keeps its id when it is retried, so your agent gets it once. Events collected after a failed attempt go out as a separate digest.
- The Mac gets each hook event once: a retry of a frame that is already queued does nothing, and one the Mac has already acknowledged is not queued again. If the relay loses both its note that the Mac took the frame and its own sent-mark, it queues the frame once more; the Mac recognises the id and drops the repeat (checked with a test).
- Not covered: events are still removed from the relay after the buffer window (7 days by default), and work events kept only as pass-through after one hour, even if they were never sent. When one event has to be retried, later events can reach the Mac before it. The relay remembers an event's inbox save for 8 days, so a buffer set longer than that could repeat one that was stuck longer.

## A message your Mac took but never passed to the agent is no longer lost without a word

- If your Mac took a message, voice note or card decision and then went down before passing it to the agent, nothing told you when the relay finally dropped it at 7 days: the message kept saying "sent". It now gets the same treatment as one the Mac never took: the day-6 "wake your Mac" push, and a "not delivered" mark at 7 days (a card decision gets a note that it reached the Mac but not the agent). Rarely a message the agent did receive is marked too: if the Mac's "passed on" confirmation was lost with the connection and the Mac then stayed away until day 7. Any reconnect before then corrects it.
- Only applies once your Mac has passed at least one message to the agent, which tells the relay it reports in two steps. An older Mac app that only confirms receipt is treated as before, so it is not told a message it handled was lost. No database change.
- Not covered: a Mac that took a message and went down before it had ever passed one to the agent is not marked (the relay cannot yet tell it from an older one).

## A failed send keeps your words, your attachments and a clear message

- If you switched to another thread while a message was still sending and it then failed, the words were lost with no sign. They now come back into that thread's box, with "Couldn't send. Your message is still here.", when you return. A failed send also keeps files you attached while it was in flight, and a slash command that fails on the phone keeps what you typed after it, as a failed message already did.
- Sent text no longer comes back after Send when a dictation tool wrote it into the box without a keystroke, or when text changed while you were recording a voice note.
- A card that cannot be saved or sent now shows the relay's own explanation when it gives one, instead of "Something went wrong (internal)".
- Words from a message that failed while you were away are no longer overwritten while they wait for you to come back: not by "Ask" on an inbox item or a schedule, by Help, or by a second failed message. Once they are back in the box, a later Ask replaces the box as it does for any draft. They all come back together, the sent words first and what you typed since after them.
- A slash command such as /compact typed while you are offline stays in the box. One that timed out does not come back, because the Mac may have received it.
- A long unbroken line in a card's error message no longer stretches the card page sideways on a phone.
- Not covered: the composer is checked in jsdom at the component level only, with no real dictation tool or iPhone. The card error line was checked at 375 px in Chromium and WebKit.

## A command for agents to drive the whole product end to end

- `pnpm drive <journey>` runs one whole-product journey on the real stack (the built relay, the real bridge, a fake Claude and a real browser) and prints one line per step, with the relay and bridge logs and the trace path when it fails. `pnpm drive list` names them, `pnpm drive all` runs every one, and `--no-build` reuses the builds already made. The journeys: approving while the Mac is away, editing a card and approving it, a message queued when the app is killed, a relay restart that keeps the relay down past the Mac's failed reconnects, with messages and replies in flight and a tap held at the relay through the restart, revoking a device from Settings, and the settings switches. This is for people and agents working on Talos; nothing changes in the app.
- Not covered: Chromium only. No iPhone, lock screen or real push. The relay restart is a clean stop and start, not a crash.

## The Mac app no longer keeps a false "Talos needs you" after a slow start, and no longer waits forever after you press Enter

- If Claude took long to start and showed a prompt Talos did not recognise, the menu said "Claude has not finished starting; look at the pane". After you answered and the session ran, that warning stayed for the rest of the launch, and the status icon showed needs-you on a healthy session. It now clears once the session is running.
- After you pressed Enter on the dev-channel warning (first start, or Restart session), a start that then never showed the "channels registered" notice stayed on "press Enter on the dev-channel warning" with no end. Once that warning is gone from the pane, the start now runs out its normal wait and says it has not finished starting.
- The Mac GUI test run (`apps/desktop/scripts/gui-tests.sh`) no longer counts a suite as passed when all its tests were skipped. The two suites that need their own setting (a page address, a screenshot folder) are listed as skipped.
- Not covered: the GUI test runner was only exercised with a fake test command, plus a real run of two suites, not the full 28 suites.

## Errors reach one place a fixer can read, and you can report a problem from the app

- When the app, the relay, the iPhone app or your Mac's bridge hits an error, it is now written to a folder on your Mac (`problems/open` inside the Talos folder), one file per kind of error with a count, the versions and a short stack. A line appears in your Inbox the first time a new kind shows up, with an id, where it came from and how many times. Nothing starts a fix by itself, and the agent is not woken: you or the lead decide what to do. On the Mac, `talos-app errors list`, `show` and `close` read and close them.
- Settings > Health has a new "Report a problem" button, and the crash screen has one too. It takes a note and an optional screenshot (pictures only, up to 5 MB), and shows exactly what will be sent before you send it. Offline, the report is saved on the phone or browser and goes out by itself when the connection is back. It is wiped when you sign out.
- No message text, card text or thread name is sent: error messages that quote what they choked on are cut at the quote, and the Mac checks again. Repeats of the same error are counted, not resent (once per 10 minutes, 20 a session); Health says how many were held back. The limits are 30 reports an hour, a folder of 200 files and 100 MB (the oldest closed one goes first), and five Inbox lines an hour with one line a day if some were left out.
- The iPhone app now keeps the system's crash and hang reports and sends them the same way.
- A Mac whose problem folder is full no longer refuses a report you wrote: it is filed even over the 200-file cap, and only automatic reports are turned away. A file that cannot be deleted no longer makes the Mac spin while it looks for room.
- The relay and the Mac's bridge send at most 20 automatic reports in any one hour, not 20 for as long as they run, so one error repeating all day cannot silence the rest.
- The report text is cut to length before it is scrubbed (a 100 KB error used to freeze the page or the bridge for seconds), and quotes inside quotes, such as the input a JSON error prints back, no longer leave words of it behind.
- The report queue in the browser has its own small database (`talos-app-problems`). The main one (`talos-app`) stays at version 2, so putting an older build back still opens your device key and outbox. Going back to an older build leaves the report queue's database unused; it holds only unsent reports.
- Not covered: the iPhone app's crash path was compiled for the simulator but not run on a phone, and the crash sample is built from Apple's documented format, not captured from a device. Whether the Inbox line pushes or stays quiet during quiet hours was not tested.

## Queued messages survive more of the ways a send can go wrong

- A message that was being sent the moment your session ran out of time is no longer deleted: it stays queued and goes out after you sign in. A sign-out still removes it.
- A message you discard while the app is sending it is now really gone: it is not sent and does not come back after a reload. Tapping "Retry" while the app is already sending the same message no longer leaves a second copy behind.
- A message the app could not mark as sent (the phone's storage was full for a moment) is tried again on its own after a few seconds, instead of waiting for the next reconnect.
- Text you send after a voice note that has not uploaded yet now waits for the voice note in that thread, so they arrive in the order you made them. Other threads and a question in a live call are never held up.
- A voice note that cannot be uploaded (the server refuses it, the daily upload limit is used up, the recording cannot be read) no longer holds the text behind it for ever. After three tries in a row on a connection that stayed up, it shows "Failed, tap to retry" with Delete, the recording is kept, and the text goes out. Tap retry to try again with a full set of tries.
- A voice note recorded while another one is uploading is now uploaded as well, without waiting for the connection to come back. One that is stuck no longer stops notes in other threads.
- Text typed in the moment between a voice note being signed and sent no longer arrives before it, including a note that was lost with a connection that dropped as it was sent.
- A voice note that was uploading when your session ran out of time and you signed back in is now sent on the new connection, instead of waiting for it to drop and return.
- A voice note that waited more than 7 days to send now shows as failed, with a line saying the recording is gone from the server, instead of being sent pointing at a deleted file. Discard it and record again.
- A message saved by an older version of the app now counts its "may already be delivered" time from when it was signed, not from the first resend.
- Not covered: the 7 days is the relay's default for keeping uploads; a relay set to keep them longer still fails a voice note this old.

## Sign-in and start-up no longer trap you or lose queued messages

- If this device's storage will not open, the app now shows "Talos can't open its storage" with **Try again** and short instructions for clearing this device's data: in a browser, clear this site's data in the browser's settings (close Talos in every other tab first, because it affects every Talos tab in that browser); in the iPhone app, delete the app and install it again; in the Mac app, use Forget this Mac. They say what that deletes: unsent messages, voice notes, chats saved on this device and this device's key, so you pair the device again. While the storage is still opening, a "Taking too long?" button sits under the logo from the first moment (no timer decides when) and leads to the same screen. If storage never answers, nothing is deleted on its own: you can wait, try again, or follow the instructions. There is no in-app Reset: a delete the page asks for can wait behind other tabs, and the browsers differ on whether it is still alive after the page closes (a review found Chromium keeps it and WebKit drops it), so the app could not tell.
- A tab that was left holding an old device key no longer wipes the unsent messages of the newer key when it reconnects: the relay now closes it with the reason `device_changed`, and the app keeps the queue for that reason. An older app that does not know the reason still wipes, as before.
- Signing in again after a device's first proof no longer wipes the other tab: the tab you were using now ends as "signed in again" (queue kept) instead of "replaced". A device revoked, or "sign out everywhere", after a tab was signed in again now wipes that tab's queue as it should.
- A voice note that was signed again late (say at day 6.5) is now counted as old from the first time it was signed, not from the later signing. Before, one whose write was lost could be sent again at day 8 and show "sent" when its recording was already gone from the server. It is now shown as gone, and the text queued behind it goes out. This needs the Mac app updated, because only a Mac that understands the original time gets it; for an older Mac the age is counted as before.
- If the device's storage never answers while the relay cannot be reached, the app no longer sits on the logo with no buttons: after the same 8 second limit as the server check it shows the offline screen with **Retry**, and Retry works again once you are back online or the storage answers.
- On the iPhone and Mac apps the stuck-storage screens now say to restart the app first (there are no other tabs there), and in a browser the instructions put "close Talos in every other tab" before the clear step.
- A sign-out wipe that could not finish after your session only expired now says "Your session ended ... Your unsent messages are kept" instead of "You signed out here".
- Signing in again while another tab is open no longer lets that tab wipe your unsent messages: the relay now says the old session ended because you signed in again, and the app keeps the queue for that reason, as it does for an idle expiry. An older app that does not know the reason still wipes, as before.
- "Sign out everywhere" is now one step on the relay, so a failure partway no longer leaves sessions ended under the wrong reason.
- A message that waited so long it had to be signed again used to look brand new to the agent. The agent is now told when you wrote it. This needs the Mac app updated: the app adds the original time only for a Mac that says it understands it, so an older Mac still works but shows the later time.
- Changing an inbox item (done, snooze, priority) is now confirmed to the app only after the relay has saved it. A failed save gives a retryable error instead of a false "done".
- Not covered: the recovery screens were checked in real Chromium and WebKit at 375 px in both themes (a stuck open and a refused open), not on a real iPhone or in the Mac app. The iPhone and Mac instructions were not run on a device: the code shows the iPhone shell loads the relay page in a web view and that Forget this Mac wipes the Mac app's site data, but that deleting the iPhone app clears the web view's data was not tested. Late-signed messages that arrive in a batch of backlog items do not carry the original-time line yet.

## The Mac bridge starts with a damaged history, tells you about a lost attachment, and retries a schedule it could not record

- If `history.sqlite` on your Mac is damaged, the bridge used to stop at start-up and your phone went quiet. It now reads the whole file first (a read error there, such as EIO or no permission, leaves the file alone and the bridge refuses to start), then runs one whole-file check. If the check fails, the search tables are dropped and rebuilt from the messages when that makes the check pass; your history stays. Anything else moves the damaged file aside (as `history.sqlite.corrupt-<time>`, with its `-wal` and `-shm`; nothing is deleted), starts with an empty history, and posts a note in your thread and to the agent. Messages work as before. Older messages are not searchable until the kept file is restored by hand, replies not yet delivered to the app are lost, and a card that was still waiting may need to be sent again. Nothing is copied from the kept file, so a recent message may arrive at your agent a second time; the note says so. A card decision cannot run twice, and neither can a control such as Clear: one you sent before the reset (or in the 2 minutes after, to allow for the phone's clock) is refused with a "send it again" answer. If the new history cannot be made (a full disk) the file is put back and the next start tries again. A file that is busy, locked, fails with an I/O error or cannot be opened is left alone and the bridge refuses to start. Garbled search data, even when it makes the check itself fail, is rebuilt and the history stays. Only the live bridge does this.
- A file you sent that the Mac could not download from the relay (relay unreachable or busy) used to vanish: the agent got the same "could not be fetched or verified" line as for a tampered file and you heard nothing. Now you get a note in the thread, the agent is told the download failed, and a new `retry_attachment` tool downloads it later against the same signed size and hash. A file that fails the size or hash check is still dropped for good, as before. A failure the Mac keeps is forgotten after 7 days, when the relay no longer has the file. A file shared with a share token is never named in a note or kept for a retry, and a thread with its own session is told to send the file again instead of being pointed at a tool it does not have.
- A scheduled job whose offer could not be written to `schedules-meta.json` (full disk, a folder in the way) was never offered again until the bridge restarted, because the unsaved offer stayed in memory. It is now taken back, and the job is offered on the next minute's check. A run that finished while the file could not be written still answers `recorded`, its "didn't finish" notice goes out once the file can be written, and the file catches up on the next tick.
- Added tests that fail if the relay-host check at sign-in is removed (the bridge signs only a challenge that names the host it dialled) and if the approved card file (`approved/<card>.json`) is ever written readable by anyone else than you. Both already held; no behaviour changed.
- Not covered: the damaged-file cases were made with real damaged SQLite files (text, header overwritten, cut off, pages of the main tables, the numbering table, the worker routes, the free list and the search index overwritten); a real EIO and a real disk-full were not produced, so a read that fails on one page and a new history that cannot be made stand in. A retried voice note gives the audio file but is not transcribed. The relay host check was tested with a stand-in socket, because a test cannot dial a non-local host name.

## A scheduled session run now gets 60 minutes before it is called failed

- A schedule run in your agent session was marked "didn't finish" after 40 minutes. Jobs that really take 41 to 47 minutes (a morning brief, a nightly memory pass) would have shown a false failure while still working. The limit is now 60 minutes. It is a fixed number: the schedule data does not carry the scheduler's own time-out, so a per-job limit is not read.
- Not covered: Chronos's `stale_claim_min` is set in its own config and not checked by the bridge; it needs to stay above 60 (the cutover config has 75).

## Opening a link or reloading no longer triggers a stray "New version available" reload

- When you left a page while one of its screens was still loading (tapping a link, opening the app from a notification, a reload), the browser cancelled that load. The app read the cancellation as "a new version was deployed" and reloaded the page itself, which could win over the page you were going to. It also used up the one automatic reload the app allows per minute, so a genuinely outdated screen in that minute showed the manual "New version available" button instead of fixing itself. The app now ignores a failed load once the page has started to leave. A screen that really went missing after an update still reloads by itself once.
- Not covered: found and checked in the browser app on WebKit at iPhone size with an automated loop (13 interrupted page loads in 1,440 before, none in 1,920 after). The iPhone app itself was not driven. If you refuse a "leave this page" prompt, the app will not auto-reload for an outdated screen until the next load, and shows the Reload button instead.

## Inbox and webhook text is encrypted in the relay's database

- Inbox and webhook text (email subjects, senders, chat text) is now encrypted at rest like messages are. New items are sealed as they arrive. Items already stored are sealed 500 at a time on the relay's 30-second housekeeping tick, so a large backlog takes a few minutes; they stay readable throughout.
- Old plain text is overwritten in place as each row is sealed, but copies can survive in unused pages of the database file, in its write-ahead log and in any backup or snapshot of the volume taken earlier. Treat those as readable until the seven-day buffer has passed.
- Rolling back: going back to the previous release is safe. Going back further, to a build from before the relay could read sealed items, makes the inbox fail to load items stored after this update.
- Not covered: the one-line summary the agent writes on an inbox item is still stored as plain text.

## Push and card safety fixes

- Revoking a device (in the app or from the Mac) or signing it out now also stops the browser and Home Screen notifications that device had turned on. Before, a revoked browser kept getting them. A browser that subscribed before this update is tied to its device the next time you open the app in it (the app re-subscribes on every open), unless you had switched notifications off there. Until then only "sign out everywhere" removes it. A browser whose device is revoked while its subscribe request is still arriving is refused.
- One damaged browser notification record no longer stops every other notification. It is skipped, logged, and counted as a failed send instead of "nobody to notify".
- Cards now show hidden direction and zero-width characters in the summary, body, warning and attachment names as visible `⟦U+202E⟧` tokens, the same as the title and fields already did, so a trick cannot reverse or hide the words you approve. Ordinary text is left alone: an emoji's presentation selector, joined emoji, flags, Persian and other words that use a zero-width joiner, and Hebrew direction marks. Notification text already showed these and is unchanged.
- Changing the permission relay setting now has a test that fails if its Face ID check is removed.
- Not covered: a real iPhone and a real Railway deploy were not used; the web view was driven at phone widths in WebKit and Chromium.

## The Mac app tells you when a restart never settles, and a second login prompt asks again

- A restart (or any start) that shows neither the dev-channel warning nor the "channels are live" line used to sit in "starting" for ever with no message. After two minutes the menu now says "Claude has not finished starting; look at the pane", and the usual "needs you at the Mac" banner follows. It only speaks when nothing else has already told you what the session is waiting for.
- If the session asked you to log in again, and you did, a later "login expired" prompt now asks again. Before, the first one was remembered for the whole run of the session and the second was silent.
- The Mac app's tests now cover both off switches (auto-restart and auto-Enter), following the session id Claude reports, the menu's Restart session, the reasons the phone post after a crash loop can be skipped, and the path from a crash to the banner. The window-opening tests have a script that runs each suite in its own process and fails a run that ends early.
- Not covered: the real Claude Code dialogs were not driven (stand-in sessions print the same text); the window-opening script was run by hand on this Mac, and CI runs it only where `TALOS_GUI_TESTS=1` is set in a logged-in session. A restart whose child dies before its process id can be read is still untested.

## iPhone: the notification buttons, the web view gate and sign-out are tested for real

- The Reply and low-risk Approve buttons need an unlocked phone; that is now checked on the real iOS button values, not on a flag. How a button press ends (one try, one retry with the same message, a failure notice that never holds your words, iOS running out of time) is tested with the network and iOS stood in. What the web view allows (camera and microphone, the cookie channel, new windows, `mailto:`) is decided in one tested place. A new Xcode test target runs against the real Keychain on the simulator and checks that sign-out leaves no key or grant behind.
- A change to the push seal on the TypeScript side now runs the iPhone job too. Before, it could post "skipped" while the Swift half no longer matched.
- Not covered: no iPhone or lock screen was used; the typed words of a Reply that failed are still not kept anywhere.

## Your agent either gets your approval once, or you are told it did not

- When you tapped Approve (or Kill, or Ask for changes) and your Mac could not hand the answer to the agent at that moment, the Mac had already filed the card as decided. The relay's second delivery of your tap was then refused as "not pending", so the agent never heard and nothing told you. Now the Mac makes one attempt. If it fails, the card ends as "Failed, nothing ran" (or, for a Kill, just closes), you get a line in the thread ("Your agent didn't get this, so nothing ran. Ask it again when it's back."), and nothing is ever sent later.
- If the Mac stops or crashes in the middle of that hand-over it cannot know whether the agent got it, so it never sends it again: the card ends as failed and the thread says "This may not have reached your agent. Check before asking again." The card itself shows the same words instead of "Ask your agent to retry".
- An app-request approval whose hand-over fails can no longer run the tool afterwards: the request is closed, not left authorised.
- "Told" means the answer was written to your agent's channel. The Mac cannot know the agent read it: a channel that accepts the write and never answers looks the same as a good one.
- A message that waited more than 15 minutes with another one behind it used to reach the agent as typed text only. A shared page, an attached note and "reply to" are now kept, in the same wrapper the agent gets for a message that arrives on time.
- A card update or reply that the relay did not confirm within eight seconds is now sent again while the connection stays up. Before, it waited for the next reconnect, which could be days. If the relay refuses such a resent row, the agent is told instead of waiting on a card your phone never shows.
- Not covered: a real dead network link (laptop sleep) was only simulated with a relay that goes silent without closing, and no real Claude Code channel failure was driven.

## Trust mode: fewer cards and passkey taps for your own words (off unless you switch it on)

- New setting, off for everyone by default. At the Mac, `talos-app trust on` turns it on and `talos-app trust off` turns it off (`talos-app trust show` says which). Your phone and the agent cannot change it, and the Mac posts a note in your default thread every time it flips. Restart the agent session after a flip so it reads the new card rule.
- When it is on: the passkey (Face ID) is asked only on payment cards. Cards for deploys, publishes and the like are approved with a tap, even from a notification. Turning on a work system, the tool-prompts switch and revoking a device skip the passkey too. The agent is told to use a card only before it sends or posts as you, spends money or deletes for good. A spoken question on a live call counts like something you typed. An allowed setting you just asked for in a thread is applied without a card and the thread says so. A schedule change still draws a card, now a tap with no passkey: the Mac cannot tell whether the words in a job came from you or from a page or file the agent read, so you look at it before it runs. An app you approved once runs a tapped write that stays inside the app without a card; a tool marked destructive, one you listed as ask-each-time, a write that reaches outside the app (sends, posts, orders), and a write no tap started still draw a card.
- Thread sessions still start between the 80 and 85 percent plan-limit marks (with a warning) and still stop at 95 percent. The 20 agent-thread limit is lifted (40 threads in all is the ceiling).
- Not covered: an app that labels a posting tool as staying inside the app is taken at its word; a payment filed under another card kind gets no passkey; an old app or relay keeps asking for the passkey as before; a card minted while trust mode was on stays low until it expires after you turn it off.

## More settings from the phone

- Health has a switch for tool prompts as approval cards (it still needs an agent restart). Work systems has boxes for what to call them and the note shown before connecting one, and a choice of whether the relay holds their events until your Mac collects them (changing that asks for the passkey, like turning a system on).
- The model list accepts any model name you type; the engine's own list no longer hides a full model name you added.
- Relay settings: `MEDIA_UPLOADS_PER_HOUR` (60), `MEDIA_DAILY_MAX_MB` (200), `SESSION_TTL_DAYS` (30) and `SESSION_IDLE_DAYS` (14). The defaults are today's limits. A relay refuses to start if the idle days are longer than the sign-in days.
- The Mac app's Blocked screen has a "Start anyway" button for another Claude session holding the channels. It starts one session once, then checks again next time, and is not offered when Telegram is the holder.
- Not covered: files over 50 MB, and approving a new app from the phone, are still Mac-only.

## Starting a thread's session right after its last one ended no longer fails on a tmux hiccup

- When a thread's session had just ended (a crash, or Park, then Start fresh or a new message) and it was the last session Talos had open in tmux, tmux's server was shutting down. A start that landed in that moment was refused with "server exited unexpectedly", and the thread showed a failed start until you tapped again. The Mac app now asks tmux again, up to three more times, for that one answer. Any other tmux error is shown as before, and a server that keeps going away still ends in the same failed start, with tmux's words in the detail. The main session's start asks again the same way.
- Not covered: this was reproduced with plain tmux (about 1 start in 600 failed, with the machine busy) and with a stand-in that returns the same answer; the CI failure it is meant to explain left no state in its log, so the link to that one run is a likely cause, not a proven one.

## Send no longer leaves the message behind as a draft

- Clicking Send while the message box did not have focus (you had clicked elsewhere, or came back from another window) sent the message and then put the same text back in the box, where it was saved as a draft. It happened only now and then and only with the button, because Enter always has the box focused already. The box now ignores a value that is simply what it last drew, so sent text cannot come back. Text a dictation tool or accessibility tool writes straight into the box is still picked up and sent, and a message that fails to send still returns to the box.
- Not covered: this is the browser app at desktop, Pixel and iPhone-sized widths; a real iPhone and a real dictation tool were not used. Phones never refocus the box after a send, so the cause could only be shown on a mouse or trackpad.

## A card you killed or sent back no longer sits at the bottom of the thread

- A card you acted on (Kill, Ask for changes, or Approve) now sits in the thread where you tapped, under that day's heading, with the newer messages after it. Before, a card you had sent back stayed pinned below the newest message, under the wrong day, for good. Only a card that is still waiting for you stays at the bottom, with its buttons.
- Why it happened: the Mac only closed a card when the agent reported a result, and the agent is never asked for one after Kill or Ask for changes. Those cards stayed "resolved" for ever, and the app treated "resolved" as still open. The Mac now closes them at once. The app also reads such a card as finished by itself, so cards that are stuck today show correctly with nothing to clean up, on the Mac app, the browser and the iPhone app.
- An approved card still waiting for the agent's result sits where you approved it and says "Working on it". After an hour with no result (counted from when your Mac took the tap, not from the tap itself, so a tap held for a sleeping Mac is not reported late at once) it says "No result reported yet · Ask Talos how it went", so it no longer claims work is going on. A card that passes its expiry while you look at it moves up out of the bottom, and a waiting card from yesterday no longer prints a Yesterday heading under Today.
- A card is dated at the moment you tapped, not the moment your Mac got to it: an Approve tapped on a notification while the Mac slept now sits in the right day.
- On Home, a killed or revised card reads "Killed" or "Revised" in grey, and an approved card with no result after an hour reads "No result", the same as in the thread. An approval that could not run, because the app request had already gone or Apps were off when you tapped (so the agent was never asked), now ends as failed, and the card says the plain reason ("Nothing ran: Apps are turned off on this Mac.") instead of staying "Working on it" or telling you to ask the agent to retry. If the agent was already asked and the app's request then timed out or its view closed, the card stays open and reads "No result reported yet" after an hour, because the agent may still run it and report. A tool that really ran is never reported as failed because a sweep closed its card early.
- Not covered: an iPhone was not available, so the iPhone app itself was not driven; its web view (WebKit at phone width) was.

## The Mac app keeps telling you what to do about the dev-channel warning

- While the dev-channel warning is up and the Mac app has told you to press Enter (or why it would not press it itself), the app no longer swaps that message for the vaguer "a dialog needs you" after the warning has sat still for a minute. A different dialog that appears later (folder trust, MCP consent, sign-in) still raises its own notice and opens the terminal.
- Not covered: the real Claude Code dialogs were not driven; the tests use stand-in sessions that print the same text.

## A message is never "sent" until it is saved

- The relay used to tell the app a message or a card answer was safe before it had written it down. If that write failed (a full disk, say), the app showed "sent", its retry was treated as a repeat, and the Mac never got it. Now the relay saves first and answers after. A failed save gives the app an error tied to that message, the message stays in the app to retry, and the retry counts as a first try. Approving a card is saved with the same step, so a failed save leaves the card waiting for you.
- The same holds for what your agent sends: a card or reply whose save fails is no longer marked as received, so the agent's resend is stored and the card reaches you.
- In the app, a message is saved on the phone before it can be sent. If that save fails you see "Couldn't send" and nothing goes out later by itself, so your retry cannot reach the agent twice. If the connection drops after a message was sent but before the relay's answer arrived, the app sends the same message again once, and the relay recognises it.
- If the phone's storage will not open at start, Talos now says so and offers Try again, instead of an endless loading screen. Nothing is deleted.
- When your session simply runs out of time, messages and voice notes you had already sent but that nothing had delivered yet stay on the phone and are shown again in their threads. The sign-in screen says how many are waiting (only ones this phone can send), and has a **Discard** button. After you sign in they go out in the order you wrote them. One that waited more than six days is signed again by the same device key before it is sent, because the Mac refuses a signature older than eight days; it keeps its message id, so a message the Mac already has is not delivered twice.
- The relay now says why a session ended, with the 401 and with the close of the open connection: ran out of time, device revoked, signed out, or signed out everywhere. Only "ran out of time" keeps the waiting messages. If the app is told anything else, or nothing (an older relay), it removes them, so a revoked or lost phone does not keep what you wrote. Signing out, revoking the device and signing in with a different device key remove them too, and the app says so when it removes some.
- These unsent messages and voice notes are stored on the phone as they are, not encrypted by Talos, until they are sent, removed or discarded. `docs/SECURITY.md` says so.
- If clearing the phone at sign-out fails, the app remembers it, says so on the sign-in page, and tries again each time it opens. It does not send or show what you removed. Nothing writes the waiting queue after you sign out.
- A voice note that cannot be saved on the phone says so and is not queued or shown as sent. A phone storage connection that dies after opening is replaced on the next try instead of failing for good.
- A message that was already sent to the relay but never confirmed, and then sat longer than the relay and the Mac remember message ids (about 8 days), is not sent again on its own: Talos cannot tell whether the agent already has it, and sending it again could deliver it twice. It shows as failed, with a note that it may already have been delivered; tap it to send it again. Messages that were never sent still go out however old they are.
- Not covered: a phone left idle past the 30-day cookie, or whose session ended before this version was deployed, gets no reason from the relay, so the app removes its waiting messages rather than keeping them (the privacy default). A message the Mac was offline for, more than eight days after it was signed, is still refused by the Mac's age check (the relay holds it up to seven days). A frame re-signed under a new id does not replace a copy the relay already holds under the old one.

## Talos Help: one page, on the phone, in the browser and from the Mac

- Settings ends with a **Help** row. It opens `/help`: which settings is which, where to change things (with a search box), first setup in order, fixes for six common problems, every keyboard shortcut and when it works, what cannot be done, and an About part with the build you are running, the log locations, how to update and how to uninstall. A button at the bottom opens a message to your agent with your search words in it; you read it and press send.
- The Mac app's **Talos Help** (top menu, Menu bar and the setup checklist) now opens that same page in the Talos window. The separate Mac-only Help window and its second copy of the text are gone. With no relay address set the Mac says so, on the Connection tab it opens. While the server cannot be reached the Talos window cannot show Help, so its failure screen lists the three fixes that need no server (the menu bar icon, `talos-app status` and `doctor`, `talos-app logs`).
- The page works signed out, and the sign-in screen links to it, so a locked-out phone can still read the fix.
- The empty-thread hint no longer sends a phone to a ⋯ menu it does not have: it names the ⋯ button on a computer and Open menu, then the pencil, on a phone.
- Not covered: the Mac's own build number is not on the page (it is in Mac settings → General). The page makes no claim about what ⌘K does inside the Mac's Talos window, or about ⌘? (macOS reserves ⇧⌘/ for its own Help search); neither was proven on a real Mac, so neither is listed. There is no Help-menu test of key priority between the page and the menu.
- Proof: `apps/web/test/help/help-truth.test.ts` checks every name, command and key the text uses against the app's source, so a rename turns it red; `help-screen.test.tsx` and `help.spec.ts` (phone and desktop, both themes, axe, keyboard, loading and failed states) cover the page.

## A phone you revoked gets no push that was already on its way

- If you revoke the Talos iPhone app while a notification is being prepared, that phone now gets nothing from it, including no sealed message text. The relay checks again right before each send to Apple, including the repeat it makes when Apple asks for a fresh token, and after any wait for the connection. A phone whose text permission was removed or replaced in that moment gets the fixed phrase instead of the words.
- Not covered: a revoked phone that was added to the Home Screen as a web app keeps its web push subscription, because those subscriptions are not tied to a device. Until the subscription is removed or the browser drops it, that phone can still get web push that shows the thread name (when "show thread names" is set to all) and carries the thread id (the id is made from the thread name). It never gets message text.
- If the relay cannot read its own records at that moment (a locked database, or a device record that no longer decrypts), it now counts the push as a failed send instead of "nobody to notify", so the card reminder and the quiet-hours summary try again instead of being marked done, and "Send a test to my iPhone" reports a failure instead of "no device". One unreadable device record no longer hides the other phones. Both retrying callers give up after 5 tries.
- The relay now answers a notification tap from an unknown or revoked device, or one whose grant it no longer holds, the same way as an unsigned one (`401 bad_signature`), so an unsigned caller cannot use it to find out which device ids exist. The iPhone app treats it as before and tells you to open Talos.

## Settings > Devices shows which device is this one, and when each was last used

- "This device" now always shows on the row that belongs to the session you are signed in with (the relay decides it by device id, never by name). It sits on its own line under the name, so it is never pushed out or cut off, and a long device name wraps instead of ending in "...".
- "Last used" was only ever written by a passkey sign-in, so a phone that signed in with a setup link (the iPhone app) read "never used" for ever. It now updates when a device is enrolled, when it makes an authenticated request, when it sends something that shows a person is there (a message, a card answer, a setting, a touch or key reported while the screen is showing), and when a Reply or Approve tapped in a notification is accepted. It moves at most once every five minutes per device, so a busy device does not write to the database on every message.
- Idle does not count. A tab or the Mac app left open overnight, its keepalive pings, the relay's own checks on open connections, a connection that reconnects by itself and another device being revoked or confirmed no longer make a device look used, so a forgotten device shows how long it has really sat idle. If the relay cannot write the time it logs one warning and tries again a minute later, rather than on every message; a sign-in or enrolment still completes.
- A device whose time the relay never recorded reads "last used unknown" instead of "never used". It fills in the next time that device is used.
- The header's session button on wide screens is now named "Session: " followed by the usage text it shows ("wk 60% used, ctx 31% used"), so a screen reader and a voice-control user get both the word "Session" and the words they see. The warning colour in the light theme is slightly darker so the "Not confirmed" badge is readable; on the black phone header and sidebar it keeps the lighter warning colour, so the needs-you dot stays readable there.
- Revoke on a device row that is this browser's own key (when the relay did not say which device this is) now asks first and signs this browser out, like the marked row does. The "This device" marker still comes only from the relay.
- No new routes or fields. An older app or relay keeps working: an app that never hears a device id from the relay marks no row.
- Not covered: the iPhone app's own screen was driven in WebKit at iPhone size, not on a real phone, and the idle-device behaviour was driven over a real websocket on a fake clock, not on a real locked iPhone left overnight.

## One web-address safety check

- The check that decides whether Talos may contact a web address was written twice, and the copy used by `talos-app apps login` let through ranges the RSS poller refused (two IPv4 ranges, 6to4 wrappers such as `2002:a9fe:a9fe::` that hide the cloud metadata address, site-local, Teredo, discard-only, documentation and translated forms). There is now one list in `packages/protocol`, used by `apps login`, the connector and the RSS poller, so a range blocked in one place is blocked in all of them.
- A sign-in request now connects only to an address that passed the check at the moment of connecting, so a name that changes its DNS answer between the check and the connection is refused.
- A feed address or server name with a trailing dot (`localhost.`) is judged as the name it is. A resolver that returns no addresses is a refusal.
- Fixed: a server name that merely starts with `127.` was treated as a local server by `apps login`, and the connector treated every host name as local for its own address, skipping the address check and the https rule on that server's own origin. Only `localhost` and address literals count as local now.
- The connector's local-server exemption is now loopback only (`localhost`, 127/8, `::1`), the same as `apps login`. A LAN address was never usable for sign-in, and exempting it could send a carried-over token over plain http to a new URL.
- Documentation addresses (2001:db8::/32, 3fff::/20) and the three IPv4 test ranges are refused; an IPv6 address that wraps a public IPv4 address is judged by that IPv4 address.

## iPhone notifications can show message text and Reply / Approve buttons, only after you tap

- Off by default and never back on by itself. Turn on gives the fixed phrase; "Show message text" (a tap) makes a grant. Turn off, Turn on again, sign-out, a revoked pairing, a blocked iOS permission and cleared page storage all leave text off, and a failed write of the off choice fails toward off.
- The words travel sealed (Apple only gets a fixed phrase and cannot read them). Your Talos server can read them, as it can read your messages today.
- Turning text off, signing out or blocking notifications deletes the keys on the phone, takes the grant back at the server (retried at every open if the server cannot be reached; the row says so), and removes the notifications that show opened words from the lock screen and Notification Center.
- Idle expiry is slower to take effect: the phone only learns at its next open, and until then the server keeps sealing text and taking taps for about 6 to 16 more days.
- Not covered: this needs a real iPhone build with the push entitlement to prove the lock screen, the Reply and Approve buttons, and that removal reaches Notification Center. Older builds keep the words already delivered until you swipe them away. Details in `docs/IOS-PUSH.md`.

## Page cards wait for a tap on Chromium, a focus guard for frames, dependency brakes

- On Chrome, Edge, Brave and Android Chrome an HTML page card shows "Run page" and loads nothing until you tap it. iPhone and the Mac app run it at once, as before. Expand still opens the page.
- Every sandboxed frame (page cards and app views) on Chrome, Edge, Brave and Android hands focus back to the message box if it grabs it right after you typed or tapped. A frame that does it three times in ten seconds is hidden behind a notice with "Show page". A mouse resting over a frame while you type no longer switches this off (after five quiet seconds it is believed again only if the browser also saw a click). iPhone, Safari and the Mac app are left alone (Firefox is guarded but untested). Clicking into a frame yourself is usually let through, but it is handed back when the pointer was already resting over the frame while you typed in the box, when you tap within 1.5 s of typing on a phone, when you click back into the window from another app, and for ten seconds after any hand-back. A bounced click is fixed only by waiting ten seconds (a handed-back click is itself the first hand-back, so moving the pointer or waiting five seconds does not help). Waiting ten seconds is not always enough: if you typed during the wait while the pointer stayed parked, a click is still bounced until the pointer moves or five quiet seconds pass. A view that calls focus() in its own touchstart or pointerdown after a pause is now bounced too, because on a touch screen the browser reports the gesture on release. The notice is per frame: a hand-back of one frame does not put another on notice. A bounced click on a view button also loses that click's gesture: the view's action is refused with "That needs a tap." (fullscreen too), the frame is on notice for ten seconds, and three such clicks hide it; click again after ten seconds. The same bounce happens for a swipe within 1.5 s before a tap, a finger tap on a touchscreen laptop, a frame brought under a still pointer after typing, and a pointer moved straight from one frame into another. The exemptions for a tap or a mouse arrival now also need the browser to report a recent gesture, so a page timer calling focus() after a pause is handed back. "Show page" appears only after the third hand-back in ten seconds, and that is the button for a page that was hidden. A view that arrives while you are typing is covered too, including on a phone and under a mouse that is parked where the view lands. Details and what is not covered: `docs/SECURITY.md`, "A page taking the keyboard".
- pnpm waits one day before it picks a new package version (`minimumReleaseAge` in `pnpm-workspace.yaml`), and the checks run `pnpm audit --prod --audit-level high` in the cloud workflow and in `ci-local.sh`, after the tests, so an advisory never hides test results (and a red test never hides an advisory). Only high and critical advisories fail a check.

## Signing in as a device needs the device's own key

- A passkey that syncs to another keychain is no longer enough to sign in as one of your devices: the sign-in also needs that device to sign the login challenge. The web app does it on its own.
- A device counts as proven the moment it enrolls. An open browser proves its key in place on its next page load, so nobody has to sign out and in. Settings > Devices shows "Key not verified" for a device that has not yet.
- The first proof from a device ends every session still attached to it without one. Every sign-in sends a push (`sign_in`, or `sign_in_unproven`) that a visible tab, a fake presence report or the chat master switch cannot silence.
- Still open for a device enrolled before this change and not opened since: it signs in without a proof, with the `sign_in_unproven` push, until `DEVICE_PROOF_REQUIRED=1`. The default stays `0` in this release; after deploying, open or revoke each device that shows "Key not verified", then set `1`.
- The in-place proof calls (run on page loads) have their own rate budget (30 a minute, 2000 a day), so opening the app cannot use up the sign-in budget and lock out sign-in or "Sign out everywhere".
- `talos-app devices revoke` and Settings both warn when a revoked device shares a passkey that stays valid.
- New routes `POST /api/auth/device/prove/options` and `/prove`; `login_proven_at` and `shared_passkey` are optional fields, so an older bridge or app ignores them.
- Proof: relay `auth/device-proof-login`, `auth/device-proof-gaps`, `push/sign-in-alert`; end to end `e2e/tests/12-device-proof.spec.ts` (real browser, built relay, real bridge).

## Relay: request-size caps, header-first uploads, and the right client address

- Every JSON route on the relay now refuses a body over 64 KiB (413) while it streams, so one anonymous request can no longer make the relay hold hundreds of MB. Media, share, frame posts and hooks keep their own, bigger caps. The cap counts bytes only as a handler reads them (Hono's own limiter read a chunked body to the end first).
- `/api/auth/*` also has a 15 s body deadline. The CSRF check for a request with no content type no longer reads the body.
- `POST /api/devices/:id/revoke` checks the session before the CSRF body check, and is limited to 20 calls a minute per address (its own bucket, so sign-in is not spent).
- A signed upload to the relay (`PUT /bridge/media`, `POST /bridge/post`, the share-token calls) is turned away with 401 before its body is read unless it names a trusted key id with a fresh time. The Mac's uploads carry `x-talos-sha256`, and the signature covers that hash, so the relay checks the signature first and then requires the body to match the hash: a stranger with a junk signature never takes an in-flight slot, and cannot lock the Mac's large uploads out. A request with no hash (a frame post, or a peer that sends none) is still read first, because the signature covers the body hash and cannot be checked without it; those reads are counted in two small pools (media: 4 per address, 6 in all; frames: 12 and 48). A counted read gives its slot back when the 408 deadline fires or the client hangs up (it used to stay parked after the 408, so stalled reads leaked their slots for good). A stranger who knows the Mac's key id can still keep a pool busy for as long as they keep opening stalled frame posts (each is cut after 15 s); that is a bounded pause on frames over 64 KiB, not a lockout that outlasts the attack. The wire format and the Mac's headers are unchanged. `GET /bridge/media/:id` reads nothing and never waits on a pool.
- `POST /share-target` is exempt from the 64 KiB cap (it never reads its body), so a big Android share lands on the retry page (303), not on bare JSON.
- The hook receiver reads its body through a pool too (32 in flight, 8 per address), with a 10 s gap and 30 s total deadline per body (408), and a full pool answers 429 with a retry hint. Before, any holder of a hook URL could make the relay hold hundreds of MB for minutes.
- The client address is `X-Real-IP` when `TRUST_PROXY_HOPS` is above 0 (a value that is not one address, such as two joined copies, is ignored), falling back to the old `X-Forwarded-For` rule. IPv6 addresses count per /64 and `::ffff:1.2.3.4` is `1.2.3.4`, so one host cannot mint a fresh budget per request. The rate-limit table sweeps at most every 30 s and holds at most 20,000 keys, so a flood of new addresses cannot stall the loop. A blocked address no longer blocks a Mac that proves it holds a trusted key.
- Not proven: the live relay's headers and memory limit were not read. Railway staff say the edge overwrites a client's `X-Real-IP`, and one forum thread showed a duplicate-header bug (since reported fixed); neither is measured on this deployment. `scripts/smoke/wp1.md` 1 now sends a spoofed `X-Real-IP` and must be run after deploy; if the spoof gets through, set `TRUST_PROXY_HOPS=0` until it is fixed.

## Collapsible sidebar, and the message box follows big inserts

- Desktop sidebar folds to a slim rail (toggle at the top, Ctrl or Cmd + backslash). Kept per device in localStorage; phones keep the bottom bar. Folded rows keep their names for screen readers, a tooltip, and the unread and Needs you counts on the icon corner.
- The message box scrolls to the end when text is added with the caret at the end: a paste, dictation (Wispr Flow), or a tool that writes the value straight on the element with no event (noticed within 200 ms while the box has focus). An edit with the caret anywhere else leaves the view alone.
- Not covered: a big insert in the middle does not scroll the caret into view.
- Review fixes: the chord is ignored while a sheet or dialog is open (it used to unmount the new-thread and settings sheets and lose typed text) and while the key is held down; folding by any route (chord, another tab) ends thread-manage mode; focus on a control the fold removes moves to the toggle instead of the page; the Home "Ask" button follows the column when the sidebar folds; an inline app view is told its new width after a fold; a paste that replaces text with something shorter still scrolls to the caret at the end.
- Screenshots: `docs/screenshots/sidebar/`.

## Local CI: less waiting in a run, and two live holders of a slot closed

- Audit first, in `docs/CI-AUDIT-2026-10-31.md`: 40 runs split into queue, setup and running. Half of a run was jobs waiting
  for their turn, setup was 2% (`pnpm install` in a new worktree takes 2.7 s), and most of the rest was two suites asleep.
- `ci-local.sh`: one install and build per run; `mod`, `image` and the Swift jobs beside `check`, `browser` after it, because every overlap with `check` failed tests with short real-time waits (`docs/CI-LOCAL.md`).
- `bun test` goes through `apps/bridge/scripts/test-parallel.ts`, one process per file, same files, same tests.
- The e2e suite runs on 3 workers in CI. Each worker has its own relay, so its per-process auth state is still not shared.
- `check`: the contract suite and `test/schedules/` one at a time, then the rest of the bridge suite, Vitest and capture together.
- A pre-push hook (biome on changed files, `tsc` on changed packages), installed by `pnpm install` for every worktree.
- Every run reports waited, setup and jobs seconds; each step's time is in the job log.
- Not done, with the numbers why: a shared `node_modules`, Vitest `isolate: false`, more skipping by changed path.
- A job can't outlive its run: results per run, a watchdog, and a dead run stopped before anyone takes its locks. A cancelled run
  leaves no detached server on the slot's port.
- One run per commit whatever each asked for, and a waiter only takes a result for a job it also ran, the same way.
- `check` and Swift jobs take turns on a machine-wide `suites` mutex. Failed side-by-side steps print last.

## History requests are single-use at the relay

- A signed `history.request` id is now refused the second time at the relay (`sig_invalid`, "That request was already used."),
  not only at the Mac. The relay answers scroll-back by seq from its own buffer, and captured request bytes sent again on a new
  socket were answered with a page there. The check is kept in the store, so it survives a restart. The e2e test
  `11-signed-history` now records what came back on the replay socket when it fails.

## Phone header, edge swipes, and no 5-hour usage

- Phones (under 768 px): the thread header is one slim row (menu button, name with a status dot, context ring that opens the
  session panel). The thread list, inbox, schedules, memory, search, settings and the thread's own settings are in a left
  menu; usage, context and agents are in a session panel from the right. A swipe from the left or right screen edge opens
  either (when the finger lifts); the buttons do the same. Desktop and tablet are unchanged.
- The 5-hour usage window is no longer shown anywhere (session panel, header chip, ring label). Weekly and context stay. A
  peer that still sends `five_hour` is read and ignored; the usage governor still reads it when present.

## V6 follow-ups: setup-code sign-in in SECURITY.md, and the review fixes

- `docs/SECURITY.md` now describes setup-code sign-in for the Mac and iPhone apps: what a leaked code can and cannot do (no pin without your `y`, but it can replace the shell's session), proof of possession for a pinned device, the five-failures burn that also blocks native pairing, sessions left over from burned codes, and the step-up limit (labelled an inference: a native app most likely cannot do step-up at all, which needs a real-device check). `scripts/security-setup-code-doc.test.ts` pins each claim to a relay test.
- Checked against main and found already shipped, no code change: history and context paging are signed (`bridge signed-history`, `web signed-history`), the search `card` column is filled from real cards (`bridge v2-followups`), and a token share no longer counts as "the owner just spoke" for a schedule card (`bridge review-share` B2). The `socketSearch` comment that still said "unsigned" is fixed.
- **`media.fetch` is a signed read.** The relay could name any media id it had ever stored and the Mac re-uploaded the file with no signature. It now needs a pinned device's `osig` and the read window like `history.request`; an unsigned one is refused with "Update the Talos app to load older files." and uploads nothing. No shipped client shows that text: the current app never sends an unsigned fetch, and an old app ignores the refusal, so it just keeps showing "Loading from your Mac…" until the app reloads. Deploy the relay before updating the Mac: an old relay turns each refusal into a row in the default thread. The app signs it and shows no alarm row for a refusal.
- **Failed signed reads are forgotten.** A forged `history.request`, `media.fetch` or search/memory read no longer lands in `seen_ids` (8 days), and one that does not even parse no longer reveals whether its id was used.
- **Relay budgets:** `history.request` 60 a minute and `media.fetch` 120 a minute per socket, then `rate_limited`.
- **Scroll-back shows why it failed** ("clock is off", "update the app", no answer) in the timeline and in the search context view, instead of a dead button.
- **A history page nobody asked for is dropped,** and a page merges only rows of the thread it was asked for. The page is still not signed; the SECURITY.md residual says so.
- **The relay can move our signing clock by an hour at most** (it was unbounded), and the doc says what that still lets it do.
- **A stand-in for an oversize row keeps its `seq`,** so an old row is not pinned under the newest message; `before_seq` paging orders by the `(thread, seq)` index instead of sorting every older row.
- **Search:** app rows are indexed by label and tool name (the spec said so; nothing was written). A search hit for a card the device does not hold shows the card's heading instead of an empty row.
- **Schedule cards:** the owner's words in one thread no longer vouch for a proposal when an untrusted share arrived in another thread after them (the agent picks the thread it proposes into), and a signed share sent with no note is not "the owner spoke".
- **Setup codes:** a native app that kept the session of an earlier, burned or expired code trades the new code for a fresh session instead of retrying on the old one (which burned the new code). A wrong device proof now burns the code it was sent with, not only the others.

## Local CI: a stalled process can no longer share a slot

- A process stalled past `CI_LOCK_GRACE` could wake up and overwrite the waiter that had moved on, so two runs held one slot:
  a takeover claim was reclaimed by age, and a first owner was written with no check. Claims now name a live claimer and are
  never taken by age, and a first owner can't replace anyone. In `scripts/ci-lock-stress.sh`, with the grace period cut to 1 s:
  two live holders in 43 of 96 rounds before, 0 of 96 after.
- The stale-takeover test no longer fails on a correct takeover of a winner that has exited; it keeps its winner alive until
  the others give up, so it tests one live holder.

## MCP Apps WP-AP4: end to end, docs, security (off by default)

- `e2e/tests/apps.spec.ts`: the built relay and web app, the real bridge with `TALOS_APP_APPS=1`, a catalog written by the real
  scan from the real probe and reference servers, and FakeClaude's agent driver running the real hook command lines. Render,
  card path, no-tap path, the gate, messages, links, sandbox escapes, phishing, display modes, injection, flood, drift,
  offline, off switch, forced errors, two at once, loading and failed states, a 10-minute clock skew, a phone in dark mode.
- G7 on the real reference views in Chromium, Pixel and WebKit (`apps/web/test/apps/reference-views.spec.ts`).
- `docs/APPS.md` (owner guide), `docs/SECURITY.md` "MCP Apps (opt-in)" with the known residuals (DNS rebinding left Low; the
  Keychain is readable by the agent's shell), `scripts/smoke/apps.md` (Mac smoke S1 to S10), a doc test, and a denylist rule.
- Probe view: `window.__probe.call` and `.send` so a test can drive the raw JSON-RPC from outside the frame.

## Local CI: a test run can no longer delete a live run's temp dir; schedules e2e on one clock

- `ci-local.sh`: the slot temp dir moves from `$TMPDIR/talos-ci-sN` to `~/.cache/talos-ci/tmp/talos-ci-sN`, beside the
  slot's lock. Under the shared `$TMPDIR`, every `pnpm test` in a builder's checkout (the tests run this script with a fake
  `HOME`, so other locks) emptied real slot 1's temp dir mid-run. That was one cause behind four kinds of red: bulk browser
  launch `ENOENT` in `test:browser`, two schedules e2e tests, and SwiftPM `couldNotFindTmpDir` on the desktop job.
- E2E: `E2E_NOW` now starts one shared clock for Chronos, the bridge and CLI (bun preload, no product hook), the relay
  and the browser. A schedules scenario stays on one plain local day: a span over midnight or a clock change moves the
  whole stack to local noon. `scripts/e2e-clock-sweep.sh` runs the whole spec at every hour and around both clock changes.
- `voice-note.spec`: waits for recorded time and for the lazy live-call button, not a fixed hold.
- `ci-local-slots` tests: no test depends on the machine's speed, and their scratch dirs are removed afterwards.

## Option C WP-OC4: the app's Own session switch and status

- Web `features/thread-sessions/`: the Own session switch in the thread settings sheet (hidden while the feature is off and
  for the default thread, General and Inbox; a plain `config.patch`, no card, no step-up), the worker's state and
  Park now / Restart / Start fresh, and Settings → Thread sessions (master switch off by default, one row per thread
  session, the governor banner).
- The session sheet's plan bars say "all sessions" once thread sessions are allowed, and a thread-scoped
  `session.state` never replaces main's, from a frame or from `ready`.
- Review fixes: the switch also needs `thread-sessions/1`; the status store starts at the app root and a `ready`
  without a status clears it; the master switch can always be turned off; the toggle uses `useThreadPatch`.

## Option C WP-OC3: desktop supervisor runs thread sessions

- `TalosDesktopCore`: `WorkerSpec` (argv, env, per-worker settings; `validate()` refuses channels, `-p`, `--bg` and any
  Telegram/iMessage/bridge env), `WorkersFile` / `WakeFile` (decoded from the protocol fixtures in the tests),
  `DedicatedSettings`, `WorkerPolicy` (cap, LRU, idle, crash loop), `PointerTyper`.
- `TalosSupervisor/WorkerManager`: starts a worker in `tmux -L talos` on its thread's first wake (`env -i`, so nothing
  leaks from the tmux server), types the one fixed pointer line, parks after the idle time, resumes by session id,
  stops on any dialog (`needs_mac`), `No session found` (`resume_missing`, id kept) and crash loops,
  re-adopts live workers after an app relaunch, and writes `workers.json` with a 5 s heartbeat.
- The app runs it with the tmux host only; main's takeover check whitelists the worker groups.
- The thread folder is re-checked before every start (realpath, under home, not `~/.claude` or the data folder).
- Review fixes: `workers.lock` keeps a second app copy passive; no park through a running turn (`stopping`); parked means the
  whole group is gone; a failed tmux read touches nothing, and a pane that isn't ours is never typed into; the folder
  checked is the folder used (`#` escaped, realpath); a launch script instead of tmux arguments; races with parking, the
  cap, folder aliases, false dialogs and relaunch state.
- Second review: an unknown is a no-op. A failed tmux read never types, signals, kills, starts or fails anything (gone means
  tmux or the kernel said so); adopt and start retry instead of guessing; unknown busy counts as busy; an unreadable
  config at launch keeps workers; the owed Enter is retried on its own. A queued Restart runs if the worker dies, and
  can't stay armed; a lowered cap parks only the excess; Quit stops the tick; waits use an awake clock, so sleep and clock
  changes can't look like quiet. `~/.claude` as a symlink is refused on both sides, a path `workers.json` can't carry is
  refused, and quoted dev warnings and resume errors aren't screens. The CLI's real `--resume` wording is matched.
- The owned pty's keystrokes go straight to the pty through its own descriptor: DispatchIO runs at default QoS, which can
  starve when parallel tests block the cooperative pool.
- Third review: an owner's stop gives up on a hung turn after 15 minutes (SIGTERM, SIGKILL, then the queued action); the
  governor never does. A `threads` value that isn't a list is unreadable, not "no threads".
- Crash after a claim: when the run that took a message has ended with nothing said, the hub posts one row in the thread.
- The Telegram guard is gone (owner decision, Telegram is being retired), from the supervisor, the bridge and the protocol.
  Workers still never get channels or tokens: that is enforced at launch.
- `scripts/smoke/option-c.md`: the owner's smoke list (O1-O16).

## Option C WP-OC1 + WP-OC2: bridge worker mode, hub socket, router

- Bridge worker mode (`TALOS_APP_WORKER_THREAD`): fail-closed (never live, no pid file, no relay socket, no mirror),
  its own thread's tools plus `read_inbound`, frames through the live bridge's `hub.sock`, HTTP + `mirror_pending`
  when the hub is down.
- Live bridge: the hub socket (nonce + process-group check on `hello`, every frame re-validated), the routing table
  with exactly-once claims and 90 s / 120 s deadlines (fallback to main with a system row), the usage governor,
  `thread.session.control`, `workers.status`.
- Review fixes: cards stay with their raiser (first writer wins; `card.update`, `card_result` and `supersedes` checked
  before the ledger moves); switch-off stops `read_inbound` and hub frames at once and hands waiting messages to main;
  one Telegram send per frame after a lost ack; `card_result` with the hub down keeps the card open; a second worker on a
  thread is refused; the bridge advertises `thread-sessions/1` and sends `workers.status` only to a relay that lists it.

## Option C WP-OC0: protocol and the Own session switch (off by default)

- Protocol `thread-sessions.ts`: `Thread.session` (`shared`|`dedicated`, absent = shared) and `session_opts`,
  `AgentConfig.dedicated` (master switch off, 3 live, usage governor 80/85/95), `threadSessionMode` /
  `canBeDedicated` (default thread, `general`, `inbox`, system and archived threads are always shared),
  `checkWorkerCwd`, the `workers.json` / wake file / hub socket schemas with fixtures in `fixtures/option-c/`, and the
  shared constants (pointer text, worker tool list, forbidden launch flags, deadlines).
- Frames `thread.session.control` (signed) and `workers.status`; `ready.workers_status`; `SessionState.scope`;
  `SessionKind` `thread`; five error codes; channel meta `routed` / `reason`. `dedicated` joins the `config.patch`
  allowlist with no step-up.
- Bridge: a patch that dedicates a front-door thread, or points a thread at a folder that is missing, outside home, or
  (also through a symlink) inside `~/.claude` or `$TALOS_APP_HOME`, is refused before anything is written.
- Review fixes: the Option C check runs on the exact config that gets written and only on the threads the change
  touches, so a switch-off is never refused; archiving a thread turns its session back to shared; refusals answer
  `thread_session_refused`. The relay passes `thread.session.control` and `workers.status`, keeps per-thread
  `session.state` for `ready.thread_session_states`, and advertises `thread-sessions/1`. Hub `mod` / `controls`
  lines (P1). A compatibility test runs the new frames through `origin/main`'s real parser.
- Forward compatibility: unknown worker states, failures and governor readings become `unknown`, unreadable status
  fields are dropped, and `ready`, `workers.status` and `config.sync` can't fail on a newer value. Unknown
  `Thread.session` reads as shared, and `session_opts` and `dedicated` fall back field by field, so a newer `max_live` never
  loses the master switch; `config.patch` still refuses junk (`sessionFieldsIssue`).
- Nothing routes yet: with the bridge and supervisor unchanged, every thread is still answered by main.

## ci-local: parallel slots

- `scripts/ci-local.sh` runs up to `CI_SLOTS` (default 3) PRs at once, each in its own slot with its own worktree, temp
  dir, Playwright port, image-test port and container. The desktop job, `playwright install` and starting Docker keep a
  shared mutex for just that step. A new run waits while the 5-min load average is above `CI_MAX_LOAD` (default 14).
- Stale locks are taken over (mkdir of a takeover marker, then an owner re-check), never `rm -rf`'d, which let two runs
  hold the old single lock at once.
- A queued `--pr` run re-resolves the PR head once it has its slot and posts statuses only for the commit it tested.
  docs/CI-LOCAL.md.

## Signed reads follow-ups

- Freshness: `history.request`, `search.query` and `memory.*` must be signed within now + 2 min / now - 5 min (durable owner
  frames keep 8 days). The app signs with the relay's time (learned from `ready`), so a phone clock that is off still
  reads. A validly signed frame outside the window gets `error{stale}` "This device's clock is off", never a
  "signature check failed" reply or a forged-signature notice to the agent.
- The seen-id check runs after the signature for `history.request`, `search.query`, `memory.*` and the signed schedule
  frames; a replay gets `sig_invalid` "That request was already used.", and an unsigned `history.request` always gets one
  fixed answer.
- `device.revoked` is applied on arrival, ahead of the main queue and any read waiting behind it. A revoked device id can
  never be pinned again, so a redelivered old revoke cannot touch a re-enrolled device.
- Relay: a history request's frame id is remembered for 24 h (in memory, best-effort across restarts), so a late Mac error
  is dropped instead of stored in a thread.
- An unsigned `history.request` (old build) is answered `error{bad_frame}` "Update the Talos app", not `sig_invalid`, so old
  builds no longer show a false "failed its security check" row.

## Thread management

- Protocol: `Thread` gains optional `color` (palette key) and `topic` (max 200); `order` defaults to 0. Old configs load
  unchanged. `THREAD_COLORS`, `THREAD_TOPIC_MAX`, `THREADS_FEATURE` (`threads/2`).
- Bridge: advertises `threads/2`; `list_threads` returns `topic`, `create_thread` takes one; after an owner thread edit
  the agent gets one system notice (renamed / new / archived / restored / topic / default). No new frame or path: edits
  are the existing owner-signed `config.patch`.
- Web: sidebar **+** and edit mode, phone Threads **+** / **Edit**, a thread settings sheet (name, 60 icons with search,
  10 colors, "what goes here", notifications, default, archive), drag / keyboard / arrow reordering. docs/THREADS.md.
- Saves wait for the Mac: `config.sync` gains optional `applied` (the patch id); a bridge refusal after the relay's ack
  now reaches the UI, and `config_conflict` re-sends the current config. Thread patches are per-thread (omitted keys
  kept, `null` clears), so an older app can't wipe colors or topics. The bridge refuses archiving the default thread
  (patch and `archive_thread`). Thread notifications apply instantly again.

## WP-N0: setup-code sign-in for native shells

- Relay: `POST /api/auth/enroll/session {code_auth}` trades a live, unused setup code for an unpinned session
  (`credential_id` null); `device/verify` still burns the code and the Mac still pins. One session per code, the
  five-failures rule applies, nothing about the code is logged or stored. Migration `auth/0003` adds
  `auth_sessions.enroll_code_id`. `device.enrolled.credential_id` is `setup-code` for these sessions.
- Protocol: `native.ts` (the JS bridge messages between the page and a native shell) and the `enrollSession` route.
- Review fixes: `device/verify` needs a device-key signature over a relay nonce to re-enroll an already-pinned device (`device_proof_required`); the code is claimed before the first await; `notify.navigate` is a strict in-app path and native -> web gains `navigate {path}`.
- `scripts/native-fixtures.ts [--check]` writes and verifies the shell-facing fixtures.

## Signed history and context reads

- Protocol: `history.request` gains optional `device_id` + `osig` and `HISTORY_UPDATE_APP_MESSAGE`; no new frame type or
  error code. The bridge serves a page only for a request signed by a pinned, unrevoked device whose frame id it has not
  seen (8-day `seen_ids`); unsigned requests (old apps) get `sig_invalid` "Update the Talos app", forged, replayed,
  unpinned and revoked ones get `sig_invalid`, and none of them get data or put content in a log.
- Relay: a signed request must carry the session's own device; the `history.page` and any `error{ref}` for it go to the
  asking socket only, and such an error is no longer stored as a system message.
- Web: scroll-back, "Show more" and the search context view sign every request; an `error{ref}` ends the wait at once.

## V2 WP-V1: health alarms

- Bridge `src/health/monitor.ts`: a `health.beat` every 60 s and within 2 s of a change (mod alive / quiet / absent,
  TTS and STT configured, FTS5). No paths, names or text. `health/1` is advertised once it runs.
- Relay `core/health.ts`: the watchdog. `session_stopped` after 5 min (once per outage, minimum gap), `mac_back`,
  `mod_quiet`; Mac-side alarms are held inside the quiet window and re-checked at its end; flags survive a redeploy.
  `GET /api/status` and `POST /api/health/test`. Health pushes ignore a visible socket. Optional ntfy mirror.
- Web: Settings -> Health (rows, notes, test button, 30 s poll) and a `HealthBanner` component.
- `docs/HEALTH.md`. The hourly external check (workflow, `/api/health`, `HEALTH_TOKEN`) is not built.

## Claude Code integration C3: session panel, controls, / picker

- Bridge `src/session/controls.ts`: a signed `session.control` is checked against the command policy and the live mod
  state BEFORE it is queued for the mod; every outcome is a recorded `session.control.result`, and a replayed control gets
  the stored result back instead of running twice. A 45 s backstop answers `mac_offline` if the mod never replies.
- Relay `session` module: keeps the last `session.state` / `session.inventory` for `ready`, passes results to apps, and
  holds a signed control for the bridge until its result is recorded.
- Mod: executes Stop (`$.turn.abort`), Compact (`$.session.compact`, deferred to turn end), New conversation and the
  allowlisted built-ins (`$.command.run`), model switch with the one-shot `PreModelSwitch` pre-approval, effort; the 15 s
  `model_switch_pending` / `effort_change_pending` waits live in the mod.
- Web: session sheet (model, effort, 5-hour and weekly usage left, context), Stop / Compact / Model / Effort / New
  conversation, the composer `/` picker, and a "mod offline" / "controls need the mod" state. No cost view.

## Claude Code integration C1: permission cards + ask rules

- The bridge declares `claude/channel/permission` when `permission_relay` is on and turns each relayed prompt into a
  `permission` card; an owner-signed Allow or Deny becomes the verdict. Fails closed (no verdict) on every error.
- `talos-app install-ask-rules` (dry run, diff, y/N); `doctor` warns about other relaying channels and missing ask rules.
- Review round: version floor 2.1.234, no Allow for `[REDACTED]`, relay-off closes open cards, newlines shown as ⏎, other-channel note on the card, safer `install-ask-rules` (mode, symlink, re-read) with a headless warning.
- Web: the permission card shows the raw call first, never cuts it, and has Allow only for a whole, safe call.

## WP8: integration, end to end, deploy files, docs

- End-to-end suite (`e2e/`): the built relay, the built web app and the real bridge behind FakeClaude, driven by Playwright.
- The built relay boots in CI; its missing runtime dependencies (`rss-parser`, `fast-xml-parser`) are declared.
- Unpinned sessions can only finish pairing (new `403 device_not_pinned`).
- Default-deny route table checked when the relay starts; `/api/me` returns the push key; the relay core no longer forwards
  `voice.ask`; spoken turns no longer seed the next call; storage-nearly-full notification; rate limit on signed bridge
  requests; sandbox policy on media errors; history requests expire; token buckets survive a clock step back.
- Linear and Calendly setup keys are used once and deleted; the wizard renders the Apps Script text and the Slack link.
- Per-thread Telegram mirror setting (default on).
- `@talos-app/integrations/catalog`: a browser-safe subpath, so the web build no longer stubs `node:*`.
- `apps/relay/Dockerfile`, `railway.json`, `.dockerignore`, `.env.example`, `pnpm dev:all`.
- Docs: `SETUP.md`, `SECURITY.md`, `deploy-railway.md`, `iphone-checklist.md`, README.
