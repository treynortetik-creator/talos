// Memory browser (docs/V2-FEATURES.md V5): a read-only view of folders the owner listed in a Mac-only `memory.json`. The
// relay never stores these frames; every read is signed. Out-of-scope paths answer `memory_not_found`, whatever the reason.
import { z } from 'zod'
import { Marks } from './fts-query.ts'
import { IsoTs, MemoryPath, MemoryRootId } from './ids.ts'

export const MEMORY_FEATURE = 'memory/1'

export const MemoryEntry = z.object({
  name: z.string().max(255),
  path: MemoryPath,
  type: z.enum(['dir', 'file']),
  size: z.number().int().optional(),
  mtime: IsoTs.optional(),
  title: z.string().max(200).optional(),
  previewable: z.boolean().optional(),
})
export const MemoryRootInfo = z.object({ id: MemoryRootId, label: z.string().max(40), files: z.number().int() })
export const MemoryHit = z.object({
  root_id: MemoryRootId,
  path: MemoryPath,
  title: z.string().max(200),
  snippet: z.string().max(320),
  marks: Marks,
  mtime: IsoTs,
})
/** A resolved link. `path:null` = missing OR hidden (deny, private, include, exclude): links never reveal hidden notes. */
export const MemoryLink = z.object({
  text: z.string().max(200),
  root_id: MemoryRootId.nullable(),
  path: MemoryPath.nullable(),
})
/** A note the owner attached to a message ([Ask {agent}]); re-checked by the bridge. Inside a signed frame: strict. */
export const MessageRef = z
  .object({
    kind: z.literal('memory'),
    root_id: MemoryRootId,
    path: MemoryPath,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

/** `memory.tree` with `root_id: null` lists the roots; `path: ''` is the top of a root. */
export const MemoryTreePath = z.union([z.literal(''), MemoryPath])

/** Bytes kept free below MAX_FRAME_BYTES when a listing or a file chunk is fit (V1.3). */
export const MEMORY_FRAME_SLACK = 2 * 1024
/**
 * Links ride on the first chunk only, at most this many encoded bytes, and are dropped first when room runs short. The
 * wire shape is unchanged (it was 32 KiB), so an older app or bridge on the other end still reads every frame.
 */
export const MEMORY_LINKS_MAX_BYTES = 128 * 1024

export type MemoryEntryT = z.infer<typeof MemoryEntry>
export type MemoryRootInfoT = z.infer<typeof MemoryRootInfo>
export type MemoryHitT = z.infer<typeof MemoryHit>
export type MemoryLinkT = z.infer<typeof MemoryLink>
export type MessageRefT = z.infer<typeof MessageRef>
