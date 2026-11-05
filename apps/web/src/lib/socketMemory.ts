/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// The socket MemoryClient (docs/V2-FEATURES.md V5). Every call is one signed owner frame; the answer is a frame routed
// back to this socket by `request_id`, and a refusal is an `error{ref}` that rejects with `TalosClientError`
// (`memory_off`, `memory_not_found`, `mac_offline`, `rate_limited`). Reads are not queued: they need the Mac now.
import { newUlid } from '@talos-app/protocol'
import type { MemoryClient } from './v2Client.ts'

type Answer = 'memory.listing' | 'memory.file' | 'memory.results'

export type SocketMemoryDeps = {
  /** Signs and sends `frame`, resolves with the answer frame that carries its `request_id`. */
  ask(frame: Record<string, unknown>, answer: Answer): Promise<Record<string, any>>
}

export function createSocketMemory(d: SocketMemoryDeps): MemoryClient {
  return {
    async tree(rootId, path, cursor) {
      const f = await d.ask(
        { type: 'memory.tree', request_id: newUlid(), root_id: rootId, path, cursor },
        'memory.listing',
      )
      return { ...(f.roots ? { roots: f.roots } : {}), entries: f.entries ?? [], nextCursor: f.next_cursor ?? null }
    },
    async read(rootId, path, offset) {
      const f = await d.ask(
        { type: 'memory.read', request_id: newUlid(), root_id: rootId, path, offset },
        'memory.file',
      )
      return {
        text: f.text,
        mime: f.mime,
        size: f.size,
        mtime: f.mtime,
        sha256: f.sha256,
        nextOffset: f.next_offset ?? null,
        ...(f.links ? { links: f.links } : {}),
      }
    },
    async search(q, rootIds, cursor, limit) {
      const f = await d.ask(
        { type: 'memory.search', request_id: newUlid(), q, root_ids: rootIds, cursor, limit },
        'memory.results',
      )
      return { hits: f.hits ?? [], nextCursor: f.next_cursor ?? null, index: f.index }
    },
  }
}
