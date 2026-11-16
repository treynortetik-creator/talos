// The socket MemoryFoldersClient: one signed `memory.folders` or `memory.roots_set`, the answer routed back by `request_id`.
// A refusal from the relay or the Mac is an `error{ref}` and rejects with `TalosClientError` (askRead in socket-requests.ts):
// an offline Mac rejects `mac_offline`, so a save that did not reach it is never shown as saved. The relay carries the answer
// and could write anything into it, so it is checked: names are plain folder names, picked ones are among those listed,
// and a save must come back saved with exactly what was sent.
import { MEMORY_FOLDERS_LIST_MAX, MEMORY_ROOTS_MAX, MEMORY_ROOTS_WORDING, newUlid } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { MemoryFolders, MemoryFoldersClient } from './v2Client.ts'

export type SocketMemoryFoldersDeps = {
  /** Signs and sends `frame`, resolves with the `memory.folders_result` that carries its `request_id`. */
  ask(frame: Record<string, unknown>): Promise<Record<string, unknown>>
}

const refuse = (): never => {
  throw new TalosClientError('bad_frame', MEMORY_ROOTS_WORDING.saveFailed)
}
const isName = (n: unknown): n is string =>
  typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.includes('/') && n !== '.' && n !== '..'

export function toMemoryFolders(f: Record<string, unknown>, sent?: readonly string[]): MemoryFolders {
  const folders = f.folders
  const chosen = f.chosen
  if (!Array.isArray(folders) || folders.length > MEMORY_FOLDERS_LIST_MAX) refuse()
  if (!Array.isArray(chosen) || chosen.length > MEMORY_ROOTS_MAX || !chosen.every(isName)) refuse()
  const list = (folders as unknown[]).map((x) => {
    const o = x as { name?: unknown; notes?: unknown }
    if (!isName(o?.name) || !Number.isInteger(o.notes) || (o.notes as number) < 0) refuse()
    return { name: o.name as string, notes: o.notes as number }
  })
  const error = typeof f.error === 'string' ? f.error.slice(0, 300) : undefined
  if (sent) {
    const got = [...(chosen as string[])].sort()
    const want = [...new Set(sent)].sort()
    // a refused save comes back with the Mac's own line; a save must come back exactly as sent
    if (!error && (f.saved !== true || got.length !== want.length || got.some((n, i) => n !== want[i]))) refuse()
  }
  return {
    folders: list,
    chosen: chosen as string[],
    enabled: f.enabled === true,
    saved: f.saved === true,
    ...(error ? { error } : {}),
  }
}

export function createSocketMemoryFolders(d: SocketMemoryFoldersDeps): MemoryFoldersClient {
  return {
    async list() {
      return toMemoryFolders(await d.ask({ type: 'memory.folders', request_id: newUlid() }))
    },
    async set(names) {
      const list = [...new Set(names)]
      return toMemoryFolders(await d.ask({ type: 'memory.roots_set', request_id: newUlid(), names: list }), list)
    },
  }
}
