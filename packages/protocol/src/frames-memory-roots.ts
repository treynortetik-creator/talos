// Which folders the Memory screen's Notes show, picked in Settings (owner, 2026-11-15; until then only `talos-app memory init`
// in a terminal set them). Split out of frames.ts, which re-exports them. Both are signed requests answered on the bridge's
// read queue, like agents_md.*: the relay never stores or replays them, it passes them to the Mac and back to the asking
// socket. The Mac checks every name against its own listing of the agent folder at write time; a name is never joined onto a
// path before that check. The agent folder's own path never leaves the Mac.
import { z } from 'zod'
import { frame, ownerFrame } from './frame-base.ts'
import { Ulid } from './ids.ts'

/** The Mac answers `memory.folders` / `memory.roots_set`: Settings shows the folder picker only then. */
export const MEMORY_ROOTS_FEATURE = 'memory-roots/1'
/** As many folders as memory.json takes (bridge memory/config.ts MAX_ROOTS). */
export const MEMORY_ROOTS_MAX = 20
/** The most folders one answer lists. */
export const MEMORY_FOLDERS_LIST_MAX = 200
/** A folder's notes are counted up to this many (the list must stay quick: it runs on the Mac's read queue). */
export const MEMORY_FOLDER_NOTES_MAX = 1000

/** A folder directly in the agent folder, by name only. Shape only here: the Mac decides whether it is one of its own. */
export const MemoryFolderName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..', 'a folder name, not a path')

export const MEMORY_ROOTS_WORDING = {
  notSetUp: "Your Mac doesn't have an agent folder for Memory yet.",
  unknown: "One of those folders isn't in your agent folder any more. Pick again.",
  saveFailed: "Your Mac couldn't save the folder choice.",
  saved: 'Saved. Notes show these folders now.',
  off: 'No folders picked, so Notes is off. Pick a folder to turn it back on.',
  broken:
    "Your Mac's memory settings file has a mistake in it. Fix it at your Mac (talos-app memory show says what), then pick here.",
} as const

/** The folders the owner can pick from, and the ones picked now. Answered by `memory.folders_result`. */
export const MemoryFoldersFrame = ownerFrame('memory.folders', {
  request_id: Ulid,
})

/**
 * Notes shows exactly these folders (each a name from the last listing), and Memory browsing is on; an empty list turns
 * browsing off. The owner's own signed choice: no confirm. Answered by `memory.folders_result` with `saved`.
 */
export const MemoryRootsSetFrame = ownerFrame('memory.roots_set', {
  request_id: Ulid,
  names: z.array(MemoryFolderName).max(MEMORY_ROOTS_MAX),
})

export const MemoryFolderInfo = z
  .object({
    name: MemoryFolderName,
    /** Notes the Memory screen would show from it (the always-on denylist and private markers applied), counted up to
     * MEMORY_FOLDER_NOTES_MAX. */
    notes: z.number().int().min(0),
  })
  .strict()

/**
 * The agent folder's own folders, by name, and which are picked. `saved` answers a `memory.roots_set` that was written;
 * `error` is a plain line for the owner (MEMORY_ROOTS_WORDING) when it was not, or when there is nothing to list.
 */
export const MemoryFoldersResultFrame = frame('memory.folders_result', {
  request_id: Ulid,
  folders: z.array(MemoryFolderInfo).max(MEMORY_FOLDERS_LIST_MAX),
  chosen: z.array(MemoryFolderName).max(MEMORY_ROOTS_MAX),
  /** Memory browsing is on (the Mac's switch). */
  enabled: z.boolean(),
  saved: z.boolean().optional(),
  error: z.string().max(300).optional(),
})
