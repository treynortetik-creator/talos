// The folder picker for a thread's own session (docs/OPTION-C.md 9.2, docs/SECURITY.md "Folder listing"). The app names a
// folder on the Mac with a signed `fs.list`; the Mac answers with the NAMES of the folders inside it, never files, never
// contents. The refusals live on the Mac (apps/bridge/src/folders); this file is the wire shape and the words both sides use.
import { z } from 'zod'

/** The Mac lists folders for the app. Advertised by a live bridge; an older Mac has no Choose button to show. */
export const FOLDERS_FEATURE = 'folders/1'

/** The most folder names one answer carries. More are counted in `more`, never sent. */
export const FOLDER_LIST_MAX = 500
/** The longest folder name sent (a file system allows 255 bytes; names that need more are dropped). */
export const FOLDER_NAME_MAX = 255
/** The Mac gives a listing this long before it answers that it took too long. */
export const FOLDER_LIST_TIME_MS = 2000
/** Folders remembered as "recent" on this device. */
export const FOLDER_RECENT_MAX = 5
/** The longest absolute path the picker handles (the same bound as a thread's folder, `AbsolutePath`). */
export const FOLDER_PATH_MAX = 512

/** What the Mac says, in one place. The refusal is the same for a missing folder and a refused one: no oracle. */
export const FOLDER_WORDING = {
  refused: "That folder can't be opened.",
  slow: 'This folder is slow to open. Try again in a moment.',
  /** The folder is not refused, but the system will not let Talos open it (macOS privacy folders such as Documents, Desktop and Downloads, or a file mode). */
  noAccess: "macOS hasn't given Talos access to this folder.",
  notReady: 'Your Mac is not ready to list folders.',
  hiddenCount: (n: number) => `${n} more not shown`,
} as const

/** A folder the app asks about: an absolute path, or null for "tell me home and the agent folder, list nothing". */
export const FsListPath = z.string().max(FOLDER_PATH_MAX).nullable()

/** One folder inside the listed one. Just the name. */
export const FsEntry = z.strictObject({ name: z.string().min(1).max(FOLDER_NAME_MAX) })
export type FsEntryT = z.infer<typeof FsEntry>

/** `~/x` for a path under home, else the path unchanged. Display only: the app always sends and saves the full path. */
export function tildePath(path: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  if (!h) return path
  if (path === h) return '~'
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

/** The path above `path`, or null at `/`. */
export function parentPath(path: string): string | null {
  if (path === '/' || path === '') return null
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}
