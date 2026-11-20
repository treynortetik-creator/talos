// The org pages the agent publishes (kept on the relay): every one for the Library (GET /api/pages), one for its card in the
// chat. Fake mode has no relay: its pages are whatever `setFakePages` holds.
import { PageInfo, type PageInfoT, PageList, type PageShareT } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import { createHttp, type Http, HttpError } from '../../lib/http.ts'

export const PAGES_TEXT = {
  title: 'Pages',
  subtitle: 'what this thread made',
  close: 'Close Pages',
  loading: 'Loading pages…',
  empty: 'Nothing yet. Pages, reports and widgets this thread makes show here.',
  failed: "Couldn't load this thread's pages.",
  refreshFailed: "Couldn't refresh this thread's pages. The list below is from the last time they loaded.",
  retry: 'Try again',
  recent: 'From recent messages',
  recentNote: 'These go when Talos clears the old messages (about a week). A published page stays.',
  missing: 'This page was deleted.',
  kind: { page: 'Page', report: 'Report', widget: 'Widget' },
  share: {
    you: 'Only you',
    org: 'Everyone at your org',
    people: (n: number) => (n === 1 ? '1 person' : `${n} people`),
    ended: 'Share ended',
  },
  open: (title: string) => `Open ${title}`,
} as const

const defaultHttp = createHttp()
const isFake = () => import.meta.env.VITE_FAKE === '1'

let fakePages: PageInfoT[] = []
/** Fake mode and tests: the org pages the made-up relay holds. */
export function setFakePages(pages: PageInfoT[]): void {
  fakePages = pages
}

/** Every org page, every thread, newest first (the Library: the relay's own list, no Mac needed). */
export async function fetchAllPages(http: Http = defaultHttp): Promise<PageInfoT[]> {
  if (isFake()) return [...fakePages]
  return PageList.parse(await http.get('/api/pages')).pages
}

/**
 * One page, for its card: `missing` when the relay says 404 (deleted, never there, or a version it does not keep: the relay
 * answers all three alike). Any other failure throws.
 */
export async function fetchPage(
  client: TalosClient,
  id: string,
  http: Http = defaultHttp,
): Promise<PageInfoT | 'missing'> {
  void client
  if (isFake()) return fakePages.find((p) => p.id === id) ?? 'missing'
  try {
    return PageInfo.parse(await http.get(`/api/pages/${encodeURIComponent(id)}`))
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return 'missing'
    throw e
  }
}

/** An org page's share in words: the one rule the Pages pane and the page card both use. */
export function pageShareLabel(s: PageShareT | null, nowMs: number = Date.now()): string {
  if (!s) return PAGES_TEXT.share.you
  if (s.expires_at && Date.parse(s.expires_at) <= nowMs) return PAGES_TEXT.share.ended
  return s.scope === 'org' ? PAGES_TEXT.share.org : PAGES_TEXT.share.people(s.emails.length)
}

/** The page's own frame: the relay serves it with the sandbox policy (an opaque origin, no network). */
export const pageFrameUrl = (id: string) => `/p/${encodeURIComponent(id)}/frame`
