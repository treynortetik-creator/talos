// The Library (owner, 2026-11-15: pages and files in one place): the files sent in Talos (files.sent, from the Mac) and the
// pages the agent published (from the relay), one list newest first. The words, the chips and filters, the type tile and the
// day groups. Kept apart from the components so they stay small and this stays testable.
import {
  FILES_SENT_DAYS,
  type FilesSentFiltersT,
  type FilesSentTypeT,
  type SentFileT,
  sentFileType,
} from '@talos-app/protocol'
import { dayLabel, formatBytes, formatDuration } from '../../lib/format.ts'

export const SENT_TEXT = {
  title: 'Library',
  subtitle: 'Pages and files, from your agent and from you',
  search: 'Search names',
  clear: 'Clear filters',
  allThreads: 'All threads',
  fromYou: 'From you',
  close: 'Close Library',
  loading: 'Loading…',
  more: 'Show more',
  retry: 'Try again',
  emptyFromAgent: (agent: string) => `${agent} hasn't sent you any pages or files yet.`,
  emptyFromYou: "You haven't sent any files yet.",
  noMatchFromYou: 'None of the files you sent match. The other side may have some.',
  noMatchFromAgent: (agent: string) => `Nothing ${agent} sent matches. The other side may have some.`,
  whose: 'Whose',
  noMatchYet: 'Nothing recent matches. Show more looks further back.',
  /** Pages still list with the Mac offline; its files need it. */
  filesNeedMac: 'Files come from your Mac, which is offline. Pages are listed.',
  /** App widgets live in their thread's messages: only threads opened on this device show theirs. */
  widgetsNote: 'Widgets show in their thread.',
  page: 'Page',
  pagesFailed: "Couldn't load your pages. Files are listed.",
  updateMac: 'Update Talos on your Mac to see sent files.',
  offline: "Your Mac is offline, so the files sent in Talos can't be listed.",
  removed: 'Greyed files were removed from your Mac (Settings, Storage) and can no longer be opened.',
  gone: 'On your Mac: tap to get it',
  fetching: 'Getting it from your Mac…',
  openFailed: "Couldn't open that file. Try again.",
} as const

/** What the list holds: everything, the pages (published pages and HTML reports), or the other files. */
export type LibraryKind = 'all' | 'pages' | 'files'
export const KIND_CHIPS: ReadonlyArray<{ id: LibraryKind; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pages', label: 'Pages' },
  { id: 'files', label: 'Files' },
]
/** Under Files, the finer kinds. */
export const TYPE_CHIPS: ReadonlyArray<{ id: Exclude<FilesSentTypeT, 'pages'>; label: string }> = [
  { id: 'all', label: 'All files' },
  { id: 'docs', label: 'Docs' },
  { id: 'audio', label: 'Audio' },
  { id: 'images', label: 'Images' },
]

export type DateRange = 'any' | 'week' | 'month'
export const DATE_LABEL: Record<DateRange, string> = { any: 'Any date', week: 'Last 7 days', month: 'Last 30 days' }
const DATE_MS: Record<Exclude<DateRange, 'any'>, number> = { week: 7 * 86_400_000, month: 30 * 86_400_000 }

export type SentFilterState = {
  kind: LibraryKind
  /** Under Files: one finer kind, or all files. */
  type: Exclude<FilesSentTypeT, 'pages'>
  name: string
  threadId: string // '' = all threads
  from: FilesSentFiltersT['from']
  range: DateRange
}
/** Files opens on what the agent sent; the switch at the top goes to what the owner sent (owner, 2026-11-15). */
export const NO_FILTERS: SentFilterState = {
  kind: 'all',
  type: 'all',
  name: '',
  threadId: '',
  from: 'agent',
  range: 'any',
}

export const filtersOn = (s: SentFilterState): boolean =>
  s.kind !== 'all' || s.type !== 'all' || s.name.trim() !== '' || s.threadId !== '' || s.range !== 'any' // who sent it is the switch

export function filtersFor(s: SentFilterState, nowMs: number): FilesSentFiltersT {
  return {
    // Files with no finer kind asks for every file; the HTML ones (pages) are left out of that view in the list
    type: s.kind === 'pages' ? 'pages' : s.kind === 'files' ? s.type : 'all',
    name: s.name.trim().slice(0, 100),
    thread_ids: s.threadId ? [s.threadId] : [],
    from: s.from,
    after: s.range === 'any' ? null : new Date(nowMs - DATE_MS[s.range]).toISOString(),
    before: null,
  }
}

/** The earliest time a date filter lets through, or null. */
export const afterOf = (s: SentFilterState, nowMs: number): number | null =>
  s.range === 'any' ? null : nowMs - DATE_MS[s.range]

export const countLabel = (n: number, more: boolean, kind: LibraryKind = 'files'): string => {
  const [one, many] = kind === 'files' ? ['file', 'files'] : kind === 'pages' ? ['page', 'pages'] : ['item', 'items']
  return `${n}${more ? '+' : ''} ${n === 1 ? one : many}`
}

/** The end of the list: how far back it can reach. */
export const daysLabel = (days: number): string =>
  days > 0 ? `Files from the last ${days} days` : `Files from your Mac's whole history`
export const DEFAULT_DAYS = FILES_SENT_DAYS

/** The tile's short label: the file's extension (HTML, MD, MP3, PNG, PDF), else its kind. */
export function tileLabel(f: SentFileT['file']): string {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(f.name)?.[1]
  if (ext) return ext.toUpperCase()
  const g = sentFileType(f)
  return g === 'pages' ? 'HTML' : g === 'audio' ? 'AUDIO' : g === 'images' ? 'IMG' : 'FILE'
}

/** The second line's size part: an audio file's length, else its size. */
export const sizeLabel = (f: SentFileT['file']): string =>
  f.duration_ms && (f.kind === 'audio' || f.kind === 'voice_note') ? formatDuration(f.duration_ms) : formatBytes(f.size)

/** Rows under day headings (Today, Yesterday, then dates), in the order given (newest first). */
export function groupByDay<T extends { at: string }>(rows: T[], nowMs: number): Array<{ label: string; files: T[] }> {
  const out: Array<{ label: string; files: T[] }> = []
  for (const f of rows) {
    const label = dayLabel(f.at, nowMs)
    const last = out[out.length - 1]
    if (last && last.label === label) last.files.push(f)
    else out.push({ label, files: [f] })
  }
  return out
}

/** A row's time under its day heading: the time alone (the heading says the day). */
export const clockLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** A row's stable key: one message can carry several files. */
export const rowKey = (f: SentFileT): string => `${f.message_id}:${f.index}`
