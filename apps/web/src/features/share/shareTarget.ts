// The service worker's share-target handler and the "pending share" store it writes (docs/V2-FEATURES.md V4.3).
// Android and desktop Chrome POST multipart to /share-target. The worker keeps the material (files included) in
// IndexedDB for 24 h and answers `303 /share?pending=<id>`, so the page can show it in the content box. Any failure
// lands on `/share?retry=1`: the page says the share did not arrive; the owner never sees an error page.
import { SHARE_LIMITS } from '@talos-app/protocol'
import { openDB } from 'idb'
import { SHARE_PAGE_PATH, type SharedFile, type SharedMaterial } from './material.ts'

export type PendingShare = {
  id: string
  at: number
  title?: string
  text?: string
  url?: string
  files: SharedFile[]
}

export interface PendingStore {
  put(p: PendingShare): Promise<void>
  get(id: string): Promise<PendingShare | undefined>
  delete(id: string): Promise<void>
  /** Removes everything saved before `before` (ms). */
  prune(before: number): Promise<void>
}

export function memoryPendingStore(): PendingStore {
  const m = new Map<string, PendingShare>()
  return {
    put: async (p) => void m.set(p.id, p),
    get: async (id) => {
      const p = m.get(id)
      if (p && Date.now() - p.at > SHARE_LIMITS.pendingFilesMs) {
        m.delete(id)
        return undefined
      }
      return p
    },
    delete: async (id) => void m.delete(id),
    prune: async (before) => {
      for (const [k, v] of m) if (v.at < before) m.delete(k)
    },
  }
}

const DB = 'talos-share'
const STORE = 'share-pending'

/** IndexedDB, shared by the page and the worker. Its own database so it never touches the app's storage versions. */
export function idbPendingStore(): PendingStore {
  const db = () =>
    openDB(DB, 1, {
      upgrade(d) {
        d.createObjectStore(STORE, { keyPath: 'id' })
      },
    })
  return {
    put: async (p) => void (await (await db()).put(STORE, p)),
    // Older than 24 h is gone, even if nothing has pruned it yet (files included).
    get: async (id) => {
      const d = await db()
      const p = (await d.get(STORE, id)) as PendingShare | undefined
      if (p && Date.now() - p.at > SHARE_LIMITS.pendingFilesMs) {
        await d.delete(STORE, id)
        return undefined
      }
      return p
    },
    delete: async (id) => void (await (await db()).delete(STORE, id)),
    prune: async (before) => {
      const d = await db()
      for (const p of (await d.getAll(STORE)) as PendingShare[]) if (p.at < before) await d.delete(STORE, p.id)
    },
  }
}

const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } })
const RETRY = `${SHARE_PAGE_PATH}?retry=1`

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** `POST /share-target` -> 303. Never throws, never returns an error response. */
export async function handleShareTarget(
  req: Request,
  deps: { store: PendingStore; now: () => number },
): Promise<Response> {
  try {
    const form = await req.formData()
    const str = (k: string) => {
      const v = form.get(k)
      return typeof v === 'string' && v.trim() ? v : undefined
    }
    const files: SharedFile[] = []
    for (const v of form.getAll('files')) {
      if (typeof v === 'string' || v.size === 0) continue
      files.push({ name: v.name || 'shared file', type: v.type, size: v.size, blob: v })
      if (files.length >= SHARE_LIMITS.files) break
    }
    const m: SharedMaterial = { files }
    const title = str('title')
    const text = str('text')
    const url = str('url')
    if (title) m.title = title
    if (text) m.text = text
    if (url) m.url = url
    if (!title && !text && !url && files.length === 0) return redirect(RETRY)
    const now = deps.now()
    await deps.store.prune(now - SHARE_LIMITS.pendingFilesMs)
    const id = randomId()
    await deps.store.put({ id, at: now, ...m })
    return redirect(`${SHARE_PAGE_PATH}?pending=${id}`)
  } catch {
    return redirect(RETRY)
  }
}

/** Removes pending shares older than 24 h. Called when the app opens and on a timer; never throws. */
export async function sweepPendingShares(store: PendingStore = idbPendingStore(), now = Date.now()): Promise<void> {
  try {
    await store.prune(now - SHARE_LIMITS.pendingFilesMs)
  } catch {
    // no IndexedDB (private mode): nothing was kept
  }
}

/** Sweeps now and every 30 minutes. Returns a stop function. */
export function startPendingSweep(store: PendingStore = idbPendingStore()): () => void {
  void sweepPendingShares(store)
  const t = setInterval(() => void sweepPendingShares(store), 30 * 60_000)
  return () => clearInterval(t)
}
