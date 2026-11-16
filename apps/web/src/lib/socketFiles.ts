// The socket FilesClient: one signed `files.list` or `files.read`, the answer routed back by `request_id`. A refusal from the
// relay or the Mac is an `error{ref}` and rejects with `TalosClientError` (askRead in socket-requests.ts).
//
// The relay carries the answer and can write anything into it, so the app checks it against what it asked: the answer must be
// for the thread and path asked, an entry must be one plain name that is not hidden (the Mac never sends one; a forged one is
// dropped, not shown), and a kind the app does not know shows as a file it cannot display.
import {
  FILES_PUT_ANSWER_MS,
  FILES_SENT_PAGE_MAX,
  FILES_WORDING,
  type FilesEntryT,
  filesNameHidden,
  newUlid,
  PageCursor,
  SentFile,
  type SentFileT,
} from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { FilesClient, FilesFile, FilesListing, FilesSentPage } from './v2Client.ts'

export type SocketFilesDeps = {
  /** Signs and sends `frame`, resolves with the answer that carries its `request_id`. */
  ask(
    frame: Record<string, unknown>,
    answer: 'files.listing' | 'files.file' | 'files.put_result' | 'files.sent_list',
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  /** A thread this device lists: a sent file under any other is dropped. */
  knownThread?(id: string): boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const isName = (n: unknown): n is string =>
  typeof n === 'string' &&
  n !== '' &&
  n !== '.' &&
  n !== '..' &&
  !n.includes('/') &&
  !CONTROL.test(n) &&
  !filesNameHidden(n)
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const refuse = (): never => {
  throw new TalosClientError('bad_frame', FILES_WORDING.refused)
}

export function toFilesListing(f: Record<string, unknown>, threadId: string, path: string): FilesListing {
  if (f.thread_id !== threadId || f.path !== path) refuse()
  const entries = Array.isArray(f.entries)
    ? f.entries.flatMap((e): FilesListing['entries'] => {
        const x = e as Partial<FilesEntryT> | null
        if (!x || !isName(x.name) || (x.kind !== 'dir' && x.kind !== 'file')) return []
        return [{ name: x.name, kind: x.kind, ...(x.kind === 'file' ? { size: count(x.size) } : {}) }]
      })
    : []
  return {
    threadId,
    root: typeof f.root === 'string' ? f.root : '',
    path,
    entries,
    more: count(f.more),
    ...(f.partial === true ? { partial: true } : {}),
  }
}

export function toFilesFile(f: Record<string, unknown>, threadId: string, path: string): FilesFile {
  if (f.thread_id !== threadId || f.path !== path) refuse()
  const kind = f.kind === 'text' || f.kind === 'image' ? f.kind : 'binary'
  return {
    threadId,
    path,
    kind,
    size: count(f.size),
    mtime: typeof f.mtime === 'string' ? f.mtime : '',
    ...(kind === 'text' && typeof f.text === 'string' ? { text: f.text } : {}),
    ...(typeof f.offset === 'number' ? { offset: count(f.offset) } : {}),
    nextOffset: kind === 'text' && typeof f.next_offset === 'number' ? count(f.next_offset) : null,
    truncated: f.truncated === true,
    ...(kind === 'image' && f.media && typeof f.media === 'object' ? { media: f.media as FilesFile['media'] } : {}),
    ...(typeof f.message === 'string' ? { message: f.message.slice(0, 300) } : {}),
  }
}

/**
 * A page of sent files as the app shows it: each row must be one the protocol allows, under a thread this device knows (a
 * row the relay made up, or from a thread deleted since, is dropped), at most a page of them. The answer is never kept.
 */
export function toFilesSentPage(f: Record<string, unknown>, knownThread: (id: string) => boolean): FilesSentPage {
  const files = Array.isArray(f.files)
    ? f.files.slice(0, FILES_SENT_PAGE_MAX).flatMap((x): SentFileT[] => {
        const r = SentFile.safeParse(x)
        return r.success && knownThread(r.data.thread_id) ? [r.data] : []
      })
    : []
  const cur = PageCursor.safeParse(f.next_cursor)
  return { files, nextCursor: cur.success ? cur.data : null, days: count(f.days) }
}

export function createSocketFiles(d: SocketFilesDeps): FilesClient {
  return {
    async list(threadId, path) {
      const f = await d.ask({ type: 'files.list', request_id: newUlid(), thread_id: threadId, path }, 'files.listing')
      return toFilesListing(f, threadId, path)
    },
    async read(threadId, path, offset) {
      const f = await d.ask(
        { type: 'files.read', request_id: newUlid(), thread_id: threadId, path, offset },
        'files.file',
      )
      return toFilesFile(f, threadId, path)
    },
    async put(threadId, dir, name, media) {
      const f = await d.ask(
        {
          type: 'files.put',
          request_id: newUlid(),
          thread_id: threadId,
          dir,
          name,
          media: { ...media, role: 'attachment' },
        },
        'files.put_result',
        FILES_PUT_ANSWER_MS, // the Mac fetches the file before it answers
      )
      // the answer must be for the folder asked, under one plain name, with the size that was sent
      if (f.thread_id !== threadId || f.dir !== dir || !isName(f.name) || f.size !== media.size) refuse()
      return { name: f.name as string, size: count(f.size) }
    },
    async sent({ filters, cursor, limit }) {
      const f = await d.ask({ type: 'files.sent', request_id: newUlid(), filters, cursor, limit }, 'files.sent_list')
      return toFilesSentPage(f, d.knownThread ?? (() => true))
    },
  }
}
