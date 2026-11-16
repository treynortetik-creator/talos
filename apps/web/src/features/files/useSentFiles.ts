// The Library's state: the filters, the pages of `files.sent` asked for them (from the Mac), the org pages (from the relay),
// and the two merged (libraryLogic.ts). Asked again each time the Library opens and each time a filter changes; never kept,
// so a file from a thread deleted since does not linger on the device. Pages come from the relay, so they list with the Mac
// offline.
import { FILES_SENT_FEATURE, type PageInfoT, type SentFileT, sentFileType } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { fetchAllPages } from '../pages/pagesData.ts'
import { mergeLibrary } from './libraryLogic.ts'
import { DEFAULT_DAYS, filtersFor, NO_FILTERS, rowKey, SENT_TEXT, type SentFilterState } from './sentLogic.ts'

const PAGE = 50
/** Empty pages (the Mac's scan cap) read through on their own before Show more is offered. */
export const AUTO_PAGES = 4

const TYPE_DELAY_MS = 250

export type SentFiles = ReturnType<typeof useSentFiles>

const say = (e: unknown) =>
  e instanceof TalosClientError && e.code === 'mac_offline'
    ? SENT_TEXT.offline
    : e instanceof Error && e.message
      ? e.message
      : SENT_TEXT.retry

export function useSentFiles() {
  const client = useTalosClient()
  const feature = useFeature(FILES_SENT_FEATURE)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const [filters, setFilters] = useState<SentFilterState>(NO_FILTERS)
  // the name box as typed; the filter follows it a moment later, so each key does not ask the Mac
  const [nameInput, setNameInput] = useState('')
  const [files, setFiles] = useState<SentFileT[]>([])
  const filesRef = useRef<SentFileT[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gen = useRef(0)
  const sent = client.files?.sent
  // the org pages: one look when the Library opens, and again on a reconnect (a publish may have landed meanwhile)
  const [pages, setPages] = useState<PageInfoT[]>([])
  const [pagesFailed, setPagesFailed] = useState(false)
  const readySeq = useTalos((s) => s.readySeq ?? 0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: readySeq is the trigger
  useEffect(() => {
    let alive = true
    fetchAllPages().then(
      (p) => {
        if (!alive) return
        setPages(p)
        setPagesFailed(false)
      },
      () => alive && setPagesFailed(true),
    )
    return () => {
      alive = false
    }
  }, [readySeq])

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.name === nameInput ? f : { ...f, name: nameInput })), TYPE_DELAY_MS)
    return () => clearTimeout(t)
  }, [nameInput])

  const ask = useCallback(
    async (cursor: string | null) => {
      if (!sent) return
      const g = cursor ? gen.current : ++gen.current
      setLoading(true)
      setError(null)
      try {
        let cur = cursor
        for (let hops = 0; ; hops++) {
          const page = await sent({ filters: filtersFor(filters, Date.now()), cursor: cur, limit: PAGE })
          if (g !== gen.current) return
          // a row already shown is not shown twice; worked out from the list as it is now (a state updater runs later)
          const shown = cur ? filesRef.current : []
          const seen = new Set(shown.map(rowKey))
          const fresh = page.files.filter((f) => !seen.has(rowKey(f)) && Boolean(seen.add(rowKey(f))))
          filesRef.current = [...shown, ...fresh]
          setFiles(filesRef.current)
          setDays(page.days)
          const nc = page.nextCursor
          // the same cursor back is a loop (a forged answer): the list ends there
          if (nc !== null && nc === cur) {
            setNext(null)
            return
          }
          // the Mac cut a page short at its scan cap with nothing for this filter: read on by itself a few times, so a
          // filter over a long history still finds what is further back; after that, Show more goes on
          // under Files (all kinds) the HTML ones are pages, left out of the view: they do not count as found
          const found =
            filters.kind === 'files' && filters.type === 'all'
              ? fresh.filter((f) => sentFileType(f.file) !== 'pages')
              : fresh
          if (found.length === 0 && nc !== null && hops < AUTO_PAGES) {
            cur = nc
            continue
          }
          setNext(nc)
          return
        }
      } catch (e) {
        if (g === gen.current) setError(say(e))
      } finally {
        if (g === gen.current) setLoading(false)
      }
    },
    [sent, filters],
  )

  useEffect(() => {
    if (feature !== 'on') return
    filesRef.current = []
    setFiles([])
    setNext(null)
    void ask(null)
  }, [feature, ask])

  // why there is no list: an older Mac (says so), or a Mac that is away
  const unavailable =
    !sent || (feature === 'off' && macOnline) ? SENT_TEXT.updateMac : feature !== 'on' ? SENT_TEXT.offline : null

  return {
    filters,
    nameInput,
    setNameInput,
    set: (patch: Partial<SentFilterState>) => setFilters((f) => ({ ...f, ...patch })),
    clear: () => {
      setNameInput('')
      setFilters((f) => ({ ...NO_FILTERS, from: f.from })) // the switch stays where it is
    },
    files,
    /** Files and pages, one list newest first (pages wait for the files to reach back to their date). */
    // while the first files are on their way, nothing: pages shown now would jump when the files land
    rows:
      !unavailable && loading && files.length === 0
        ? []
        : mergeLibrary(unavailable ? [] : files, pages, filters, !unavailable && next !== null, Date.now()),
    pagesFailed,
    more: next ? () => void ask(next) : null,
    hasMore: next !== null,
    days,
    loading,
    error,
    retry: () => void ask(null),
    unavailable,
  }
}
