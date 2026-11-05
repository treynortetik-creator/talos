// The search index's hook into history.sqlite (docs/V2-FEATURES.md V3.1). `openHistory()` calls `installSearchIndex` for
// EVERY process that opens the store (live bridge, headless writers, the CLI): it creates the tables if missing and
// registers the post-commit indexer. It never throws into a message write.
import type { HistoryStore } from '../history-store.ts'
import { ReadError, type SearchService } from '../v2-seams.ts'
import { FILE_TICK_MS, FileIndexer } from './files.ts'
import { SearchIndexer } from './indexer.ts'
import { createQuery } from './query.ts'
import { ensureSchema, probeFts5 } from './schema.ts'

type Installed = { indexer: SearchIndexer | null; fts5: boolean }
const installed = new WeakMap<HistoryStore, Installed>()

export type InstallOpts = {
  log?: { warn(msg: string, f?: Record<string, unknown>): void }
  /** Test seam: replaces the FTS5 start probe (a shim that fails it). */
  probe?: (store: HistoryStore) => boolean
}

export function installSearchIndex(store: HistoryStore, opts: InstallOpts = {}): void {
  if (installed.has(store)) return
  const fts5 = (opts.probe ?? ((s) => probeFts5(s.db)))(store)
  if (!fts5) {
    installed.set(store, { indexer: null, fts5: false })
    return
  }
  try {
    ensureSchema(store.db)
  } catch {
    installed.set(store, { indexer: null, fts5 })
    return
  }
  const indexer = new SearchIndexer(store, opts.log)
  installed.set(store, { indexer, fts5 })
  store.onWrite(indexer.listen)
}

/** The indexer `installSearchIndex` registered for this store (null when FTS5 is missing). */
export function indexerFor(store: HistoryStore): SearchIndexer | null {
  return installed.get(store)?.indexer ?? null
}

export type SearchServiceOpts = InstallOpts & {
  now?: () => number
  budgetMs?: number
  /** Live bridge: run reconcile every 30 s (and quickly while behind). Headless processes only index through the listener. */
  live?: boolean
  tickMs?: number
  /** The bridge's own media folder: text attachments in it are indexed (P1). Unset = no file contents. */
  mediaDir?: string
  fileTickMs?: number
}

export type SearchServiceHandle = SearchService & {
  /** One reconcile pass now (tests, `search reindex`). Returns true while more remains. */
  tick(): boolean
  /** One file-contents pass now (tests). Returns true while more files are pending. */
  tickFiles(): boolean
  stop(): void
}

/** The service `ctx.search` holds. `available` is false without FTS5, so `search/1` is not advertised. */
export function createSearchService(store: HistoryStore, opts: SearchServiceOpts = {}): SearchServiceHandle {
  installSearchIndex(store, opts)
  const indexer = indexerFor(store)
  const now = opts.now ?? Date.now
  const q = indexer
    ? createQuery({ db: store.db, store, indexer, now, ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}) })
    : null
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const tick = () => {
    if (!indexer) return false
    return indexer.reconcile(new Date(now()))
  }
  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      let more = false
      try {
        more = tick()
      } catch {
        stopped = true // the store is closed
        return
      }
      schedule(more ? 250 : (opts.tickMs ?? 30_000))
    }, ms)
    ;(timer as { unref?: () => void }).unref?.()
  }
  const files = indexer && opts.mediaDir ? new FileIndexer(store, opts.mediaDir) : null
  const tickFiles = () => (files ? files.tick() : false)
  let fileTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleFiles = (ms: number) => {
    if (stopped || !files) return
    fileTimer = setTimeout(() => {
      try {
        tickFiles()
      } catch {
        // a bad file or a closed store never stops the loop from being retried
      }
      scheduleFiles(opts.fileTickMs ?? FILE_TICK_MS)
    }, ms)
    ;(fileTimer as { unref?: () => void }).unref?.()
  }
  if (opts.live && indexer) {
    schedule(0)
    scheduleFiles(opts.fileTickMs ?? FILE_TICK_MS)
  }
  return {
    available: Boolean(indexer && q),
    async query(f) {
      if (!q) throw new ReadError('search_unavailable', 'Search is not available on this Mac.')
      return q.query(f)
    },
    history: (f) => (q ? q.history(f) : null),
    tick,
    tickFiles,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      if (fileTimer) clearTimeout(fileTimer)
    },
  }
}
