// Message search on the Mac (docs/V2-FEATURES.md V3): SQLite FTS5 in history.sqlite behind the signed `search.query`.
// The relay only forwards; results go to the asking socket only and are never stored.
import { z } from 'zod'
import { Marks } from './fts-query.ts'
import { IsoTs, MsgId, ThreadId } from './ids.ts'
import { AttachmentRef, Message } from './models.ts'

export const SEARCH_FEATURE = 'search/1'

/** Strict, no defaults: it sits inside the signed `search.query`. */
export const SearchFilters = z
  .object({
    thread_ids: z.array(ThreadId).max(40), // [] = all threads
    from: z.enum(['any', 'owner', 'agent']), // 'agent' includes system rows; hook and share rows only under 'any'
    has_file: z.boolean().nullable(), // role 'attachment' and kind != voice_note; voice replies never count
    after: IsoTs.nullable(),
    before: IsoTs.nullable(),
  })
  .strict()

/** One per FTS column (text, transcript, names, files, card), first column holding a match wins (V3.1). */
export const SearchMatchIn = z.enum(['text', 'transcript', 'attachment_name', 'attachment_text', 'card'])
/** The badge each `match_in` gets in the results list (V3.3). */
export const MATCH_IN_LABEL: Record<z.infer<typeof SearchMatchIn>, string> = {
  text: 'in message',
  transcript: 'in voice note',
  attachment_name: 'in file name',
  attachment_text: 'in file',
  card: 'in card',
}

export const SearchHit = z.object({
  message_id: MsgId,
  thread_id: ThreadId,
  seq: z.number().int().nullable(),
  author: Message.shape.author,
  kind: Message.shape.kind,
  via: Message.shape.via,
  created_at: IsoTs,
  match_in: SearchMatchIn,
  snippet: z.string().max(320), // plain text, never HTML
  marks: Marks,
  attachment: AttachmentRef.pick({ media_id: true, name: true, mime: true, kind: true }).optional(),
  /** A heartbeat digest row: its text came from outside, so the app attributes it to "Heartbeat". */
  heartbeat: z.literal(true).optional().catch(undefined),
})

export const SearchSort = z.enum(['relevance', 'newest'])
export const SearchIndexState = z.enum(['ready', 'indexing', 'dirty'])

export const SEARCH_LIMITS = {
  /** Per socket (typing makes 5 or 6 queries per search). */
  queriesPerMin: 120,
  /** Per query on the Mac, then `search_unavailable`. */
  budgetMs: 1500,
  /** The app gives up and says "Your Mac didn't answer." */
  appTimeoutMs: 15_000,
  totalEstimateCap: 1000,
  relevanceCap: 200,
  newestCap: 1000,
} as const

export type SearchFiltersT = z.infer<typeof SearchFilters>
export type SearchHitT = z.infer<typeof SearchHit>
export type SearchMatchInT = z.infer<typeof SearchMatchIn>
