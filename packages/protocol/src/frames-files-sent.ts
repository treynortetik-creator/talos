// The Files sheet: files sent in Talos, by the owner or an agent, across every thread the Mac lists (archived and sub-threads
// included), newest first. The Mac answers from its message history (history.sqlite), so the list reaches back as far as that
// history does (FILES_SENT_DAYS). A signed read like search.query: the relay forwards it and never stores the answer, and the
// app asks again each time the sheet opens rather than keeping a copy. Split out of frames.ts, which re-exports the frames.
import { z } from 'zod'
import { frame, ownerFrame } from './frame-base.ts'
import { IsoTs, MsgId, PageCursor, ThreadId, Ulid } from './ids.ts'
import { AttachmentRef, Message } from './models.ts'

/** The Mac lists the files sent in Talos. */
export const FILES_SENT_FEATURE = 'files-sent/1'
/** The most files one page carries. */
export const FILES_SENT_PAGE_MAX = 50
/** How far back the list reaches: the Mac's message history (MESSAGE_RETENTION_MS in the bridge's history store). */
export const FILES_SENT_DAYS = 90
/** The longest name filter: a plain piece of a file name, never a pattern. */
export const FILES_SENT_NAME_MAX = 100

/** The type chips. Every file is in 'all'; one that fits no group is in 'all' only. */
export const FilesSentType = z.enum(['all', 'pages', 'docs', 'audio', 'images'])
export type FilesSentTypeT = z.infer<typeof FilesSentType>

/** Strict, no defaults: it sits inside the signed `files.sent`. */
export const FilesSentFilters = z
  .object({
    type: FilesSentType,
    /** A piece of the file's name, any letter case ('' = any). Matched as text: % and _ are themselves. */
    name: z.string().max(FILES_SENT_NAME_MAX),
    thread_ids: z.array(ThreadId).max(40), // [] = every thread the Mac lists
    from: z.enum(['any', 'owner', 'agent']), // 'agent': everything the owner did not send
    after: IsoTs.nullable(),
    before: IsoTs.nullable(),
  })
  .strict()
export type FilesSentFiltersT = z.infer<typeof FilesSentFilters>

export const FilesSentFrame = ownerFrame('files.sent', {
  request_id: Ulid,
  filters: FilesSentFilters,
  /** Opaque, from the last page's `next_cursor`: the page continues after the last file it carried (time, then id). */
  cursor: PageCursor.nullable(),
  limit: z.number().int().min(1).max(FILES_SENT_PAGE_MAX),
})

/** One file as sent: the message it came in, who sent it, and the attachment itself. */
export const SentFile = z.object({
  message_id: MsgId,
  thread_id: ThreadId,
  author: Message.shape.author,
  created_at: IsoTs,
  /** The attachment's place in its message (a message can carry several). */
  index: z.number().int().min(0).max(63),
  file: AttachmentRef,
  /** The Mac removed the file's bytes (Settings, Storage): it is listed, but can no longer be opened. */
  removed: z.boolean(),
})
export type SentFileT = z.infer<typeof SentFile>

export const FilesSentListFrame = frame('files.sent_list', {
  request_id: Ulid,
  files: z.array(SentFile).max(FILES_SENT_PAGE_MAX),
  next_cursor: PageCursor.nullable(),
  /** How many days back the Mac's history reaches (what the list can show at most); 0 = it keeps history for good. */
  days: z.number().int().min(0).max(36500),
})

/** The type group a file is in, from its kind, MIME type and name (an agent's file may carry a generic MIME type). */
export function sentFileType(f: { kind: string; mime: string; name: string }): Exclude<FilesSentTypeT, 'all'> | null {
  const mime = f.mime.toLowerCase().split(';')[0]?.trim() ?? ''
  const ext = /\.([a-z0-9]{1,8})$/i.exec(f.name)?.[1]?.toLowerCase() ?? ''
  if (f.kind === 'html' || mime === 'text/html' || ext === 'html' || ext === 'htm') return 'pages'
  if (f.kind === 'image' || mime.startsWith('image/')) return 'images'
  if (f.kind === 'audio' || f.kind === 'voice_note' || mime.startsWith('audio/')) return 'audio'
  if (
    mime === 'application/pdf' ||
    mime === 'text/markdown' ||
    mime === 'text/plain' ||
    ext === 'pdf' ||
    ext === 'md' ||
    ext === 'markdown' ||
    ext === 'txt'
  )
    return 'docs'
  return null
}
