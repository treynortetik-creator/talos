// What a reader of `workers.json` (the `WorkersFile` shape in thread-sessions.ts) does with an entry it cannot read. One entry
// it cannot read must never cost the others: the Mac reads `threads` entry by entry, keeps every entry it can read, and sets
// each one it cannot read aside under `WORKERS_UNREADABLE_KEY`, so a save never writes back fewer sessions than it read.
// The Mac's side is apps/desktop/Sources/TalosDesktopCore/WorkersFileRead.swift; a Swift test reads this file to stay in step.

/**
 * The top-level key of `workers.json` that holds the entries of `threads` a reader could not read, keyed as they were in
 * `threads` (a key that is not a thread id included). Absent when there are none.
 */
export const WORKERS_UNREADABLE_KEY = 'unreadable_threads'

/**
 * Each value is the entry's JSON text, as a string. A string survives any type (an entry that is a number, an array, or an
 * object of a newer shape), and a writer that carries a string on keeps it byte for byte without encoding it again.
 *
 * - The Mac moves an entry it cannot read out of `threads` into here (its JSON text, keys sorted) and never starts that
 *   thread's own session while it is here. A reader should treat a thread listed here as unavailable, never as "off".
 * - An entry already here is carried on unchanged. One that reads again (fixed by hand, or a build that knows its shape)
 *   goes back into `threads` when the file is next read (the Mac reads it at launch). When `threads` already has that key,
 *   the copy here is kept under the key with `#` added, which is not a thread id, so it never holds that thread back.
 *   That includes an entry in `threads` that cannot be read beside a copy here that can: the copy waits under `K#` and is
 *   NOT restored automatically.
 * - An unknown `state` alone does not make an entry unreadable: the Mac reads it as "may be running" (not resting).
 * - A save never writes fewer entries (`threads` and this key together) than were read.
 */
export type WorkersUnreadableT = Record<string, string>

/**
 * When the whole file cannot be read, a writer refuses to save over it, and leaves it as it is until it reads or is removed:
 * text that is not a JSON object, `v` other than 1 (a newer file), `threads` missing or not an object, or this key present and
 * not an object. An empty file (zero bytes) holds nothing to lose and reads as no file.
 */
export const WORKERS_FILE_REFUSED_WHEN = [
  'not_json_object',
  'v_not_1',
  'threads_not_object',
  'unreadable_not_object',
] as const

/**
 * The one line the Mac shows for each case. `{threads}` is the ids, joined with ", "; a key that is not a thread id is not named
 * (it is counted as "N other"). No entry's values are ever shown.
 */
export const WORKERS_UNREADABLE_NOTICE = {
  entries: {
    id: 'workers_entries_unreadable',
    text: 'Talos could not read the saved sessions of {threads}. They are kept in workers.json. To start their own sessions again, quit Talos, fix or delete those entries, and open Talos again.',
  },
  file: {
    id: 'workers_file_unreadable',
    text: 'Talos could not read workers.json, so it will not save over it. Thread sessions are paused until the file is fixed or removed.',
  },
} as const
