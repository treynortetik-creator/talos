# Thread management

Create, rename, reorder, recolor, re-icon, archive and restore threads from the app, and pick the default thread. Every
edit is one owner-signed `config.patch` (docs/PROTOCOL.md, docs/SECURITY.md): the bridge verifies the device signature,
checks the allowlist (`threads`, `default_thread`), validates the merged config and writes `config.json` atomically. The
relay can't forge or alter an edit. There are no extra approval steps.

## Where

| Surface           | How                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop sidebar   | One row of three buttons: the magnifier (search all threads, in place), **+** (a new thread) and the pencil ("Manage threads": edit mode with drag handles, a gear per thread, Archived with Restore; **Done** leaves it). |
| Phone Threads tab | **+** and **Edit** in the header. Edit mode has the same list plus Move up / Move down arrows.                                                                                                                             |
| Phone menu        | The same row of three buttons; each thread in the list has its own **···**.                                                                                                                                                |
| Inside a thread   | **···** in the header opens that thread's settings sheet (it also has "Search this thread").                                                                                                                               |
| Settings > Agent  | A short note and a **Manage threads** link that opens the same editor (`/threads?manage=1`).                                                                                                                               |

The settings sheet holds: name, color, icon (searchable), "What goes here" (the topic), notifications, Default thread,
Archive / Restore. Notifications apply at once; everything else applies on Save. The default thread can't be archived
until another thread is the default (the bridge refuses it too, for any client and for the agent's `archive_thread`),
and the last active thread can't be archived. Archiving a thread with pending cards says so; the cards stay in Needs
you.

The phone list and the sidebar show the same order. Agent-made threads carry a small "by Talos" tag.

## Saving

A save counts only when the Mac applied it. The relay acks a `config.patch` when it stores it; the bridge then answers
with `config.sync{applied: <patch id>}` (saved) or `error{ref: <patch id>}` (refused: `config_conflict`, `bad_frame`).
The app waits for that answer (20 s, then "Your Mac hasn't confirmed this change yet. It applies when your Mac picks it up."). A refusal shows in the sheet or the
list, which snaps back; on `config_conflict` the bridge also re-sends the current config so the app is up to date.
Reorders made while a save is in flight are coalesced into one more save.

**Per-thread patch semantics.** The `threads` array sets order and membership, but inside a thread that already exists
a key the client left out keeps its current value (`resolveThreadsPatch`, packages/protocol/src/patches.ts). So an
older app or tab that doesn't know `color` or `topic` can rename, archive or reorder without wiping them. A key sent
as `null` is cleared; the app sends `null` for a cleared icon, color or topic to a `threads/2` Mac.

## Reordering

Drag a row by its handle (mouse, finger or pen: pointer events, no long-press needed because the handle is dedicated).
Keyboard: focus the handle, Space to pick up, Arrow Up / Down to move, Space to drop, Escape to cancel; each step is
announced. Move up / Move down keep focus on the arrow. The order saves on drop as `Thread.order` (renumbered 0..n);
the inbox and archived threads keep their slots. The list snaps back if the save fails.

## Schema (packages/protocol/src/models.ts)

All new fields are optional, so configs written before this change still load unchanged.

| Field   | Type            | Notes                                                                                                                                                                                                                                                                   |
| ------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon`  | string, max 16  | A key from `THREAD_ICONS` (apps/web/src/ui/threadIcons.ts: 60 lucide-react glyphs) or `art-<name>` for the six black-figure icons. Anything else (an emoji in an old config, or nothing) shows the art for the thread id. Keys are saved in configs: add, never rename. |
| `color` | `^[a-z]{1,16}$` | A palette key: `red orange yellow lime mint cyan blue violet magenta pink` (`THREAD_COLORS`). The schema takes any short key so a newer app can add colors; an unknown key renders as Default.                                                                          |
| `topic` | string, max 200 | "What goes here". Shown under the thread header and returned by `list_threads`.                                                                                                                                                                                         |
| `order` | int, default 0  | Now defaults, so a hand-written config without it loads (ties keep file order).                                                                                                                                                                                         |

Colors are bright fills behind black ink with a black keyline, so one swatch works on the cream list, the black sidebar
and the dark theme. Every fill gives the ink at least 6:1 (icons need 3:1); `apps/web/test/threads/manage.test.ts`
computes it.

The thread **id never changes**. A rename only changes `name`; history, unread counts, cards and agent routing all key
on the id.

## Mac compatibility

The bridge lists `threads/2` in `hello.client.features`. Without it (a Mac on an older version) the sheet hides the
icon, color and topic pickers and says "Update Talos on your Mac": an older bridge's schema would silently drop those
fields. Create, rename, reorder, archive, notifications and default work with any bridge.

A device-only "what goes here" note from before topics existed is offered as the topic and moved into config on the
next Save.

## The agent

- `list_threads` returns each thread's `topic`; the instructions say to route by name or topic.
- `create_thread` takes an optional `topic`. It and `archive_thread` are wrappers over `config_propose` (`threads.<id>` and `threads.<id>.archived`, docs/bridge.md): the owner approves a card first, and the agent can also rename, retopic, re-icon, change the alert level or switch the own session of a thread the same way (old and new on the card, a way back in the result).
- **Setting up thread agents** (owner ruling 2026-11-19). `create_thread` also takes `parent_id`, `session` (its own session), `folder`, `color`, `model`, `effort`, `mcp`, `idle_park_min` and `instructions`: one atomic `threads.<new_id>` proposal creates and configures it. `set_thread_instructions {id, text}` writes a thread's AGENTS.md later.
  - **Who may set what.** Main: any thread, with the owner's own folder rules (no containment check against the parent, the refused roots apply to the real paths). A thread's own session (reaching the same service over the hub, as the thread the connection proved): the low fields of its own thread; threads with `parent_id` = itself (a sub-thread can't make threads); any field of its own sub-threads except their parent; the instructions of its own sub-threads only (its own are the owner's); it archives its own sub-thread with `config_propose` (`threads.<id>.archived`), `archive_thread` stays Main's.
  - **Folders.** The folder must already exist and be a directory (nothing is created for the agent). It is judged on disk at propose and again at apply: not the owner's home itself, `~/.claude`, the Talos data folder or the agent folder, also when a link leads there; for a thread session's sub-thread, the real path must lie inside the parent's real path, by whole path segments (`/a/site2` is not inside `/a/site`). Moving a parent's folder is refused while a sub-thread has its own folder outside the new one ("<child> has its own folder outside the new one; the owner must move <child> first.").
  - **The gate.** The fields that set a session up (its own session, folder, model, MCP list, and a create that carries any of them) are a card while "Lock Talos settings" is on. With it off they are made straight away when nothing outside reached the agent since the owner last spoke (the one strict check every agent session meets: outside text in any thread, a lead that spoke, the peer taint, `agent-quiet.ts`); otherwise a card. The two-hour "he asked in this thread" window does not apply to them; the low fields (name, topic, icon, colour, alerts, idle time, effort) keep it.
  - **Instructions.** Written only into the target thread's own folder (a thread with its own session and a folder that is not the shared agent folder), through the owner's no-follow, rename-over AGENTS.md save; at most 32 KB (the owner's own editor takes up to 64 KB); the text it replaces is kept as `agents-md.prev`. With the lock on, or after outside text, the write is refused (there is no card for a file write; the owner edits it in the thread's settings). On `create_thread` they are written only when the create was made at once; after a card, call `set_thread_instructions` once the thread exists.
  - **What the owner reads.** After a change made at once: "Changed <field>: old → new. To undo: …", plus "<thread> now has its own session (uses your Claude plan)." and "<thread> now works in <folder>." (fixed sentences and validated values only). The card shows the same words.
- After a `config.patch` that adds, renames, archives or restores a thread, changes a topic, or moves the default, the
  agent gets one `system` channel notice listing the changes (names and topics JSON-quoted) and "call list_threads".
  Reorders, colors, icons and notification changes don't notify it.

## Sub-threads

A thread may sit under one other thread (`Thread.parent_id`), one level deep. The rules are in
`packages/protocol/src/sub-threads.ts`; the bridge applies them to every config write (the app's `config.patch`, the agent's
cards and the bridge's own tools).

- **Supervisor support first.** No thread gets a parent, and no sub-thread is changed, until the supervisor (the Mac app,
  or the Linux supervisor since P3d5) reports `supervisor.subthreads_supported` in `workers.json` with a fresh heartbeat;
  only then does the bridge list `subthreads/1` in `hello.client.features`. Both start a sub-thread's session by the same
  rules (the Mac's `SubThreads.swift`; Linux's `worker-subthreads.ts` is its port). Taking a thread out from under its parent, archiving a sub-thread, and narrowing a parent's
  MCP list are always allowed.
- **Inheritance.** A sub-thread uses its parent's folder, model, effort and MCP list unless it sets its own
  (`effectiveSessionOpts`). Its own MCP list is cut to the parent's. Mac-only options (`ops_read`, the park timer) are never
  inherited. A sub-thread whose parent is missing or archived inherits nothing and, without a list of its own, gets no MCP
  servers.
- **Folders.** A sub-thread's folder is strictly inside its parent's; the Mac
  app re-checks the resolved paths before every start. One with its own session may also have no folder, or the parent's own
  (below, `subthreads_shared_folder`); without that capability it needs a folder of its own inside. One exception, only when the supervisor says
  `supervisor.subthreads_own_folder` in workers.json (both supervisors do):
  a sub-thread with its own session may keep an existing folder outside its parent's, written as an absolute path with no
  `.` or `..`. It is used as it is and never made, so a missing one is refused. The parent's own folder (equal) is the shared case below, and a path under the parent that a link leads out of is
  still refused. Saving it shows one line, `thread "<id>" keeps its own
  folder, so it does not get "<parent>"'s instructions; the parent's privacy rules still apply` (`subThreadWarnings`), also under Under in the thread's settings.
  The parent's privacy rules still apply to it: the Mac adds the deny rules from the parent's folder chain (parent first) to the
  child's own, and the bridge's attach check reads the `.talos-lead` markers at or above both folders, so any refusal refuses.
  A sub-thread without its own session still runs in its parent's lane and keeps the inside rule.
- **A folder of its own under a parent with none** (2026-11-19). A parent with no folder runs in the agent folder, so a
  sub-thread with its own session and a folder of its own is judged against the agent folder, as against any parent's: an
  existing one outside is kept as its own folder (never made, so a missing one is refused) and the agent folder's deny and ask
  rules are carried in. A folder inside the agent folder cannot be saved from the app (the bridge refuses the agent folder for
  every thread session when it knows it, `TALOS_AGENT_DIR`, as every install does); one written by hand is made there, as for a parent whose folder is the agent folder. The attach check
  reads `.talos-lead` markers only from a parent's own folder setting, so here none come from the parent (which runs in the
  agent folder and reads none itself). Only when the supervisor says `supervisor.subthreads_folderless_parent`
  (both do; the Mac's `DedicatedSettings.judgedAgainstAgentFolder`, the bridge's `dedicatedThreads`); without it the bridge
  refuses in plain words: `thread "<id>" can't have a folder of its own while "<parent>" has none until the Talos app on your
  Mac is updated; update it, or give "<parent>" a folder first`.
- **Sharing the parent's folder.** Only when the supervisor says `supervisor.subthreads_shared_folder` in workers.json (the Mac app
  and the Linux supervisor both do; without it the old refusal holds, "a sub-thread's folder must be inside its parent's
  folder"), a sub-thread with its own session may have no folder, or the same folder as its parent (compared as written, with
  trailing slashes ignored; a path with `.` or `..` or a link to it is not "the same"). It then runs in its parent's
  effective folder (the agent folder when the parent has none), follows it when it moves, and nothing is made or fenced for
  it. Both sessions can edit the same files, so saving it shows one
  line, `thread "<id>" and its parent "<parent>" work in the same folder; they can edit the same files`
  (`subThreadWarnings`, also under Under in the thread's settings): a warning, not a refusal. The folder claim
  (`folder_claimed`) is lifted for one family only: a parent and its own sub-threads that share its folder, and two such
  siblings. Siblings that name the same subfolder, threads of different parents and any unrelated pair are still refused.
  A parent whose folder setting cannot be read refuses its sub-threads too (never a fall back to the agent folder). A supervisor without
  the capability that refuses such a thread gets one plain line from the bridge in that thread, once per run: "this thread can't
  start: the Talos app on this computer is older than its settings; update it" (`old-supervisor-notice.ts`).
  The child uses its parent's AGENTS.md, so its own Instructions editor is off (`agentsMdFolderFor`), and a lead's
  `.talos-lead` markers in that folder bind it (`attach` reads the effective folder, not only the thread's own setting).
- **Instructions.** A sub-thread's session reads its parent's AGENTS.md as well as its own. Claude Code loads AGENTS.md
  where it loads CLAUDE.md, from the session's folder and every folder above it, and thread sessions run with
  `instructionFiles: claude-md-and-agents-md` (`withInstructionFiles`, `InstructionFiles.swift`). Verified on 2026-11-11
  with Claude Code 2.1.3xx: a session in `parent/child` got both folders' AGENTS.md, with and without a CLAUDE.md in the
  child; in the default mode, with a CLAUDE.md there, it got neither. So no launch step adds the parent's file. A sub-thread with its own folder outside its parent's is read from its own folder and the folders above it, which
  do not include its parent's folder, so it does not get the parent's instructions (`instructionFolders`, `WorkerInstructions.folders`). Each
  thread's AGENTS.md is edited in its settings, under Instructions (`docs/SECURITY.md`).
- **The Mac decides the folder.** If a sub-thread's own folder can't be read (a hand edit, a newer value), the Mac app
  refuses to start it rather than use the parent's folder. The bridge and the app read such a folder as unset, so
  `effectiveSessionOpts` may show the parent's folder; the Mac's decision is the one that counts.
- **Who answers.** An owner message (or file) in a sub-thread goes to the sub-thread's own lead when it has one,
  else to its parent's lead when the parent has one, else to the main session (`leadThreadFor`). A parent lead that is not
  reachable falls back to main as usual, with the notice in the sub-thread. A sub-thread's scheduled jobs run in its own
  session only; without one, main runs them. A message waiting for the parent's lead goes to main at once if the sub-thread
  gets a lead of its own, loses its parent or is archived.
- **Where a lead may post and read.** A parent's lead may answer in the sub-threads it answers (`reply`, `attach`, `card`,
  `set_status`; `leadPostThreads`) and read every sub-thread under it (`read_thread`; `leadReadThreads`). Its other
  thread-locked tools (settings and schedule proposals, hand-offs) stay on its own thread. A sub-thread with its own lead is
  that lead's alone, and that lead posts and reads only there. The hub applies the same list to every frame a lead sends.
  A reply the hub refuses (the sub-thread got a lead of its own between the tool's check and the send) is taken out of the
  Mac's history again, so `read_thread` and "stopped before it answered" never count it; one the outbox kept stays.
- **In the app.** Every thread list draws a sub-thread right under its parent (the keyboard's thread numbers follow that
  order). The sidebar and the phone menu draw it as an accordion: the chevron on a parent opens and closes its sub-threads,
  the choice is remembered on that device (`talos-subthreads-open` in localStorage), a parent stays open while one of its
  sub-threads is on screen, and a closed parent's count includes its sub-threads' unread replies. A list with no sub-threads
  looks as it did before. A sub-thread whose parent is not on the list (archived, or a hand edit) is drawn at the top level.
- **Archiving.** The agent can't post into an archived thread: `reply`, `attach` and `app_show` refuse it and name the
  default thread to post to instead (an archived thread is in no list and no badge, so a row there would never be
  seen); `read_thread` still works. A parent can't be archived while a live sub-thread depends on it: archive them together. The agent's
  `archive_thread` proposes the parent and its sub-threads on one card; a sub-thread the owner made can only be archived by
  the owner.

### Known gaps

- A sub-thread's own folder or parent that the app can't read (a hand edit) reads as unset, so the app may show the parent's
  folder or the thread at the top level. The Mac app's reading is the one that counts.
