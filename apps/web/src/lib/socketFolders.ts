// The socket FolderClient: one signed `fs.list`, one `fs.listing` routed back by `request_id`. A refusal from the relay or the
// Mac is an `error{ref}` and rejects with `TalosClientError` (see askRead in socketClient.ts).
//
// The relay carries the answer and can write anything into it, so nothing in it decides what the app saves or shows beyond
// what it asked for: the answer must be for the path asked, home is pinned by the first answer (a later one that names another
// home is refused), and a name that is not one folder name is dropped. The caller saves the path IT asked for.
import { FOLDER_WORDING, newUlid } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { FolderClient, FolderListing } from './v2Client.ts'

export type SocketFoldersDeps = {
  /** Signs and sends `frame`, resolves with the `fs.listing` that carries its `request_id`. */
  ask(frame: Record<string, unknown>): Promise<Record<string, unknown>>
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** One folder name: not empty, not `.` or `..`, no slash, no control character. */
const isFolderName = (n: unknown): n is string =>
  typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !n.includes('/') && !CONTROL.test(n)

const parentOf = (p: string) => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** One `fs.listing` frame as the app reads it. */
export function toFolderListing(f: Record<string, unknown>, asked: string | null): FolderListing {
  const refuse = (): never => {
    throw new TalosClientError('bad_frame', FOLDER_WORDING.refused)
  }
  if (asked !== null && f.path !== asked) refuse() // an answer for another folder than the one asked
  const entries = Array.isArray(f.entries)
    ? f.entries.flatMap((e) =>
        typeof e === 'object' && e !== null && isFolderName((e as { name?: unknown }).name)
          ? [(e as { name: string }).name]
          : [],
      )
    : []
  return {
    home: typeof f.home === 'string' ? f.home : '',
    ...(typeof f.agent_dir === 'string' ? { agentDir: f.agent_dir } : {}),
    ...(asked !== null ? { path: asked } : {}),
    // the folder above the one asked, worked out here: the answer's own `parent` is not trusted
    parent: asked === null ? null : typeof f.parent === 'string' && f.parent === parentOf(asked) ? f.parent : null,
    entries,
    more: typeof f.more === 'number' && Number.isFinite(f.more) && f.more >= 0 ? f.more : 0,
  }
}

export function createSocketFolders(d: SocketFoldersDeps): FolderClient {
  let home: string | null = null
  return {
    async list(path, hidden) {
      const listing = toFolderListing(await d.ask({ type: 'fs.list', request_id: newUlid(), path, hidden }), path)
      // home comes once, from the first answer, and stays: a later answer naming another home is not ours to believe
      if (home === null && listing.home) home = listing.home
      else if (home !== null && listing.home !== home) throw new TalosClientError('bad_frame', FOLDER_WORDING.refused)
      return listing
    },
  }
}
