// What the Files pane knows about a thread's folder: the folders it has listed (asked of the Mac one at a time, as they are
// opened), which are open, the filter, and the file on view (text comes in chunks; "Show more" asks for the next one).
import { FILES_PUT_FEATURE, FILES_WORDING } from '@talos-app/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { type FilesFile, type FilesListing, useFeature } from '../../lib/v2Client.ts'

export type DirState =
  | { state: 'loading' }
  | { state: 'ok'; listing: FilesListing }
  | { state: 'error'; message: string }
export type Viewing =
  | { path: string; state: 'loading' }
  | { path: string; state: 'ok'; file: FilesFile; text: string; loadingMore: boolean }
  | { path: string; state: 'error'; message: string }
export type Row = { path: string; name: string; kind: 'dir' | 'file'; depth: number; size?: number }

export const FILES_TEXT = {
  title: 'Files',
  subtitle: 'read-only',
  /** On a Mac that takes uploads (files-put/1): files can be added, never changed or deleted. */
  subtitleUploads: 'view and add files',
  filter: 'Filter files',
  loading: 'Loading…',
  retry: 'Try again',
  empty: 'Nothing to show in this folder.',
  noMatch: 'No file here matches. Open a folder to look inside it.',
  pick: 'Pick a file to see it here.',
  more: 'Show more',
  truncated: 'The rest of this file is not shown: it is longer than the pane shows.',
  back: 'All files',
  close: 'Close Files',
  offline: "Your Mac is offline, so its files can't be shown.",
  moreCount: FILES_WORDING.more,
} as const

const say = (e: unknown): string =>
  e instanceof TalosClientError && e.code === 'mac_offline'
    ? FILES_TEXT.offline
    : e instanceof Error && e.message && !/^[a-z_]+$/.test(e.message)
      ? e.message
      : FILES_WORDING.notReady

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** The rows the tree shows: open folders' contents under them; with a filter, the matches in every folder listed so far. */
export function treeRows(dirs: Record<string, DirState>, open: ReadonlySet<string>, filter: string): Row[] {
  const f = filter.trim().toLowerCase()
  const walk = (dir: string, depth: number): Row[] => {
    const d = dirs[dir]
    if (d?.state !== 'ok') return []
    const out: Row[] = []
    for (const e of d.listing.entries) {
      const path = join(dir, e.name)
      const row: Row = { path, name: e.name, kind: e.kind, depth, ...(e.size !== undefined ? { size: e.size } : {}) }
      const hit = !f || e.name.toLowerCase().includes(f)
      if (e.kind === 'file') {
        if (hit) out.push(row)
        continue
      }
      // a folder: with no filter, its contents when it is open; with one, it stays when it or anything listed under it matches
      const under = f || open.has(path) ? walk(path, depth + 1) : []
      if (!f || hit || under.length > 0) out.push(row, ...under)
    }
    return out
  }
  return walk('', 0)
}

export function useFilesBrowser(threadId: string) {
  const files = useTalosClient().files
  const uploads = useFeature(FILES_PUT_FEATURE) !== 'off' && Boolean(files?.put)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const want = useRef<string | null>(null) // the file asked for last: an older answer that arrives late is dropped
  // Everything here belongs to one thread. The pane stays mounted when the thread changes, so it starts over then (in render,
  // so not even one frame shows the old thread's file), and an answer that comes back for the thread left behind is dropped.
  const current = useRef(threadId)
  current.current = threadId
  const [owner, setOwner] = useState(threadId)
  if (owner !== threadId) {
    setOwner(threadId)
    setDirs({})
    setOpen(new Set())
    setFilter('')
    setViewing(null)
    want.current = null
  }

  const load = useCallback(
    async (path: string) => {
      if (!files || current.current !== threadId) return // a reload for a thread left behind (an upload that ended late)
      setDirs((d) => ({ ...d, [path]: { state: 'loading' } }))
      try {
        const listing = await files.list(threadId, path)
        if (current.current === threadId) setDirs((d) => ({ ...d, [path]: { state: 'ok', listing } }))
      } catch (e) {
        if (current.current === threadId) setDirs((d) => ({ ...d, [path]: { state: 'error', message: say(e) } }))
      }
    },
    [files, threadId],
  )

  useEffect(() => {
    void load('')
  }, [load])

  const toggle = useCallback(
    (path: string) => {
      setOpen((o) => {
        const n = new Set(o)
        if (n.has(path)) n.delete(path)
        else n.add(path)
        return n
      })
      const d = dirs[path]
      if (!d || d.state === 'error') void load(path)
    },
    [dirs, load],
  )

  const view = useCallback(
    async (path: string) => {
      if (!files) return
      want.current = path
      setViewing({ path, state: 'loading' })
      try {
        const file = await files.read(threadId, path, 0)
        if (want.current !== path || current.current !== threadId) return
        setViewing({ path, state: 'ok', file, text: file.text ?? '', loadingMore: false })
      } catch (e) {
        if (want.current === path && current.current === threadId) setViewing({ path, state: 'error', message: say(e) })
      }
    },
    [files, threadId],
  )

  const more = useCallback(async () => {
    const v = viewing
    if (!files || v?.state !== 'ok' || v.file.nextOffset === null || v.loadingMore) return
    setViewing({ ...v, loadingMore: true })
    try {
      const next = await files.read(threadId, v.path, v.file.nextOffset)
      if (want.current !== v.path || current.current !== threadId) return
      setViewing({ ...v, file: next, text: v.text + (next.text ?? ''), loadingMore: false })
    } catch (e) {
      if (want.current === v.path && current.current === threadId)
        setViewing({ path: v.path, state: 'error', message: say(e) })
    }
  }, [files, threadId, viewing])

  const rows = useMemo(() => treeRows(dirs, open, filter), [dirs, open, filter])
  const rootDir = dirs['']
  return {
    available: Boolean(files),
    root: rootDir?.state === 'ok' ? rootDir.listing.root : '',
    rootState: rootDir,
    dirs,
    open,
    rows,
    filter,
    setFilter,
    toggle,
    view,
    viewing,
    more,
    retry: () => void load(''),
    /** Lists a folder again (after an upload into it). */
    reload: (path: string) => void load(path),
    threadId,
    /** What the pane's title line says it does. */
    subtitle: uploads ? FILES_TEXT.subtitleUploads : FILES_TEXT.subtitle,
    clearView: () => {
      want.current = null
      setViewing(null)
    },
  }
}

export type FilesBrowser = ReturnType<typeof useFilesBrowser>

/** `/Users/you/…` or `/home/you/…` as `~/…`, for display. */
export function shortRoot(root: string): string {
  return root.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}
