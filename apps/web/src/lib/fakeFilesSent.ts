// The Files sheet's list in fake mode: the files sent in Talos, as the Mac would answer `files.sent` (src/files/sent.ts in
// the bridge): newest first, filtered and paged the same way, made-up names only. Times are relative to now, so the day
// groups (Today, Yesterday, ...) always have something in them.
import { FILES_SENT_DAYS, type FilesSentFiltersT, type SentFileT, sentFileType } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { FilesSentPage } from './v2Client.ts'

const HOUR = 3600_000
const SHA = 'f'.repeat(64)
// stable per seed row: the same file keeps its ids across asks
const mediaId = (i: number) => `md_01JBF3V7Q8K2M4N6P8R0S2T${String(i).padStart(3, '0')}`
const msgId = (i: number) => `m_01JBF3V7Q8K2M4N6P8R0S2T${String(i).padStart(3, '0')}`

type Seed = {
  hoursAgo: number
  thread: string
  author: SentFileT['author']
  name: string
  mime: string
  kind: SentFileT['file']['kind']
  size: number
  duration_ms?: number
  removed?: boolean
}

/** Made-up files across the demo threads, both directions. */
export const DEMO_SENT: Seed[] = [
  {
    hoursAgo: 0.4,
    thread: 'general',
    author: 'agent',
    name: 'weekly-summary.html',
    mime: 'text/html',
    kind: 'html',
    size: 48_200,
  },
  {
    hoursAgo: 1.2,
    thread: 'general',
    author: 'agent',
    name: 'standup-notes.mp3',
    mime: 'audio/mpeg',
    kind: 'audio',
    size: 1_840_000,
    duration_ms: 154_000,
  },
  {
    hoursAgo: 3,
    thread: 'inbox',
    author: 'owner',
    name: 'trip-plan.md',
    mime: 'text/markdown',
    kind: 'file',
    size: 3_100,
  },
  {
    hoursAgo: 26,
    thread: 'general',
    author: 'agent',
    name: 'whiteboard.png',
    mime: 'image/png',
    kind: 'image',
    size: 412_000,
  },
  {
    hoursAgo: 30,
    thread: 'inbox',
    author: 'agent',
    name: 'receipt.pdf',
    mime: 'application/pdf',
    kind: 'file',
    size: 96_000,
  },
  {
    hoursAgo: 75,
    thread: 'general',
    author: 'owner',
    name: 'packing-list.txt',
    mime: 'text/plain',
    kind: 'file',
    size: 900,
  },
  {
    hoursAgo: 140,
    thread: 'general',
    author: 'agent',
    name: 'release-notes.md',
    mime: 'text/markdown',
    kind: 'file',
    size: 5_600,
  },
  // old enough that the relay may have let its bytes go, and too big to be asked back unasked
  {
    hoursAgo: 200,
    thread: 'general',
    author: 'agent',
    name: 'quarterly-deck.pdf',
    mime: 'application/pdf',
    kind: 'file',
    size: 8_400_000,
  },
  {
    hoursAgo: 900,
    thread: 'inbox',
    author: 'agent',
    name: 'old-report.html',
    mime: 'text/html',
    kind: 'html',
    size: 30_000,
    removed: true,
  },
]

export function createFakeFilesSent(deps: {
  macOnline: () => boolean
  knownThread: (id: string) => boolean
  seed?: Seed[]
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const rows = (): SentFileT[] =>
    (deps.seed ?? DEMO_SENT).map((s, i) => ({
      message_id: msgId(i + 1),
      thread_id: s.thread,
      author: s.author,
      created_at: new Date(now() - s.hoursAgo * HOUR).toISOString(),
      index: 0,
      file: {
        media_id: mediaId(i + 1),
        kind: s.kind,
        role: 'attachment',
        mime: s.mime,
        name: s.name,
        size: s.size,
        sha256: SHA,
        ...(s.duration_ms ? { duration_ms: s.duration_ms } : {}),
      },
      removed: s.removed === true,
    }))
  return {
    async sent({
      filters: f,
      cursor,
      limit,
    }: {
      filters: FilesSentFiltersT
      cursor: string | null
      limit: number
    }): Promise<FilesSentPage> {
      if (!deps.macOnline()) throw new TalosClientError('mac_offline')
      const name = f.name.trim().toLowerCase()
      const all = rows()
        .filter((r) => deps.knownThread(r.thread_id))
        .filter((r) => f.type === 'all' || sentFileType(r.file) === f.type)
        .filter((r) => !name || r.file.name.toLowerCase().includes(name))
        .filter((r) => f.thread_ids.length === 0 || f.thread_ids.includes(r.thread_id))
        .filter((r) => f.from === 'any' || (f.from === 'owner' ? r.author === 'owner' : r.author !== 'owner'))
        .filter((r) => (!f.after || r.created_at >= f.after) && (!f.before || r.created_at < f.before))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      const from = cursor ? Number(cursor) : 0
      const page = all.slice(from, from + limit)
      return {
        files: page,
        nextCursor: from + limit < all.length ? String(from + limit) : null,
        days: FILES_SENT_DAYS,
      }
    },
  }
}
