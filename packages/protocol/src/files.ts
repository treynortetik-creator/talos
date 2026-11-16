// The Files pane: a read-only look at a thread's folder (the thread's own `session_opts.cwd`, or the agent folder). The app
// names a THREAD and a path inside its folder with a signed `files.list` or `files.read`; the Mac decides which folder that
// is, and refuses anything whose real path leaves it, any hidden name (a dot-name, so .env* and .git too, or node_modules)
// and anything that is not a plain folder or file. The refusals live on the Mac (apps/bridge/src/files); this file is the
// wire shape and the words both sides use.
import { z } from 'zod'

/** The Mac shows a thread's files. Advertised by a live main bridge. */
export const FILES_FEATURE = 'files/1'

/** The most entries one listing carries; the rest are counted in `more`. */
export const FILES_LIST_MAX = 1000
/** The longest name sent (a file system allows 255 bytes; longer names are left out). */
export const FILES_NAME_MAX = 255
/** The longest path inside the folder the app may name. */
export const FILES_PATH_MAX = 1024
/** One `files.file` carries at most this much text; the app asks again from `next_offset` for more. */
export const FILES_TEXT_CHUNK = 160 * 1024
/** A text file is shown up to this many bytes; past it the answer says `truncated`. */
export const FILES_TEXT_MAX = 2 * 1024 * 1024
/** An image is previewed only up to this size. */
export const FILES_IMAGE_MAX = 10 * 1024 * 1024
/** The Mac gives a listing or a read this long before it says it took too long. */
export const FILES_TIME_MS = 3000

/** Names never shown or opened, at any depth (dot-names are hidden too: see `filesNameHidden`). */
export const FILES_HIDDEN_NAMES: readonly string[] = ['node_modules']

/** True for a name the Files pane never shows or opens: a dot-name (.env, .env.local, .git, .ssh...) or node_modules. */
export function filesNameHidden(name: string): boolean {
  return name.startsWith('.') || FILES_HIDDEN_NAMES.includes(name)
}

/** What the Mac says, in one place. The refusal is the same for a missing path and a refused one: no oracle. */
export const FILES_WORDING = {
  refused: "That isn't a file Talos shows from this thread's folder.",
  noAccess: "macOS hasn't given Talos access to this folder.",
  notReady: 'Your Mac is not ready to show files.',
  slow: 'This folder is slow to open. Try again in a moment.',
  noFolder: "This thread's folder isn't there any more.",
  hiddenRoot: "This thread's folder is inside a hidden or protected folder, so Talos doesn't show its files.",
  tooBig: 'This image is too big to preview.',
  binary: "This file isn't text or an image Talos can show.",
  more: (n: number) => `${n} more not shown`,
  partial: 'This folder is very large: only part of it is shown.',
} as const

/** A path inside the thread's folder: '' is the folder itself, else names joined by '/' (no leading '/'). */
export const FilesPath = z.string().max(FILES_PATH_MAX)

/** One entry of a listed folder: a folder or a file, by name. `size` for a file. */
export const FilesEntry = z.strictObject({
  name: z.string().min(1).max(FILES_NAME_MAX),
  kind: z.enum(['dir', 'file']),
  size: z.number().int().min(0).optional(),
})
export type FilesEntryT = z.infer<typeof FilesEntry>

/** How the viewer shows a file. An open string on the wire: a newer Mac's new kind shows as `binary`, it does not drop the frame. */
export const FILES_KINDS = ['text', 'image', 'binary'] as const

/** `path` split into names, or null when it is not one this protocol allows (empty segments, '.', '..', a leading '/'). */
export function filesPathParts(path: string): string[] | null {
  if (path === '') return []
  if (path.length > FILES_PATH_MAX || path.startsWith('/') || path.endsWith('/')) return null
  const parts = path.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.length > FILES_NAME_MAX)) return null
  return parts
}
