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
| Settings > Agent  | The older full editor (name, live-call context, archive, arrows) stays.                                                                                                                                                    |

The settings sheet holds: name, color, icon (searchable), "What goes here" (the topic), notifications, Default thread,
Archive / Restore. Notifications apply at once; everything else applies on Save. The default thread can't be archived
until another thread is the default (the bridge refuses it too, for any client and for the agent's `archive_thread`),
and the last active thread can't be archived. Archiving a thread with pending cards says so; the cards stay in Needs
you.

The phone list and the sidebar show the same order. Agent-made threads carry a small "by Talos" tag.

## Saving

A save counts only when the Mac applied it. The relay acks a `config.patch` when it stores it; the bridge then answers
with `config.sync{applied: <patch id>}` (saved) or `error{ref: <patch id>}` (refused: `config_conflict`, `bad_frame`).
The app waits for that answer (20 s, then "your Mac hasn't confirmed this yet"). A refusal shows in the sheet or the
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
- `create_thread` takes an optional `topic`.
- After a `config.patch` that adds, renames, archives or restores a thread, changes a topic, or moves the default, the
  agent gets one `system` channel notice listing the changes (names and topics JSON-quoted) and "call list_threads".
  Reorders, colors, icons and notification changes don't notify it.
