// The Library's one list: the Mac's files (files.sent, paged newest first) and the relay's published pages (all of them at
// once), merged newest first. Pure, so the merge is testable apart from the screen.
//   - Pages are the agent's: they show on the "From <agent>" side only, under All and Pages, never under Files.
//   - While the Mac still has older files to send, a page shows only once the files reach back to its date, so the order
//     never jumps when Show more brings older files in. With no more files (or none at all), every matching page shows.
//   - Under Files with no finer kind, the HTML reports (files.sent's "pages") are left out: they are pages.
import { type PageInfoT, type SentFileT, sentFileType } from '@talos-app/protocol'
import { afterOf, rowKey, type SentFilterState } from './sentLogic.ts'

export type LibraryRow =
  | { kind: 'file'; key: string; at: string; f: SentFileT }
  | { kind: 'page'; key: string; at: string; page: PageInfoT }

const fold = (s: string) => s.normalize('NFKD').toLowerCase()

/** Does a published page pass the filters (the switch, the kind, the name, the thread, the date)? */
export function pageMatches(p: PageInfoT, s: SentFilterState, nowMs: number): boolean {
  if (s.from === 'owner' || s.kind === 'files') return false
  const name = fold(s.name.trim())
  if (name && !fold(p.title).includes(name)) return false
  if (s.threadId && p.thread_id !== s.threadId) return false
  const after = afterOf(s, nowMs)
  if (after !== null && Date.parse(p.updated_at) < after) return false
  return true
}

export function mergeLibrary(
  files: readonly SentFileT[],
  pages: readonly PageInfoT[],
  s: SentFilterState,
  more: boolean,
  nowMs: number,
): LibraryRow[] {
  const shownFiles =
    s.kind === 'files' && s.type === 'all' ? files.filter((f) => sentFileType(f.file) !== 'pages') : files
  const oldest = shownFiles.length ? Date.parse(shownFiles[shownFiles.length - 1]?.created_at ?? '') : null
  const rows: LibraryRow[] = shownFiles.map((f) => ({ kind: 'file', key: `f:${rowKey(f)}`, at: f.created_at, f }))
  for (const page of pages) {
    if (!pageMatches(page, s, nowMs)) continue
    // older than the files listed so far, while more files are still to come: it waits for them
    if (more && oldest !== null && Date.parse(page.updated_at) < oldest) continue
    rows.push({ kind: 'page', key: `p:${page.id}`, at: page.updated_at, page })
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? -1 : 1))
}
