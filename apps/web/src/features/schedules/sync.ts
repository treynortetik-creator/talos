// Keeps the Schedules slice fresh (docs/SCHEDULES.md S5.2): loads the cached snapshot from IndexedDB, asks the Mac for the
// real one, applies `schedule.status` (health directly, rows by one re-fetch), and caches every new snapshot. One
// in-flight `schedules.list` per client, however many components ask.
import type { ScheduleSnapshotT } from '@talos-app/protocol'
import { useEffect, useMemo } from 'react'
import { type ClientState, type TalosClient, TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import type { Storage } from '../../lib/storage.ts'
import { useStorage } from '../../lib/storageContext.tsx'
import { navDot, needsRefetch, revsOf } from './logic.ts'

const CACHE_KEY = 'snapshot'
/** The `schedules.list` running now, per client; `token` tells a request apart from one started after it was abandoned. */
const inflight = new WeakMap<TalosClient, { token: object; p: Promise<void>; ac: AbortController }>()
/** How many requests each client has started: the newest one is the only one whose failure is shown. */
const latest = new WeakMap<TalosClient, number>()

function setSlice(client: TalosClient, next: Partial<ClientState['schedules']>) {
  client.store.setState((s) => ({ ...s, schedules: { ...s.schedules, ...next } }))
}

/** Why a call failed, as the slice names it (the socket client already wrote update_app / update_mac / no_answer). */
function errorName(e: unknown, current: string | null): string {
  if (current) return current
  if (e instanceof TalosClientError) {
    if (e.message === 'no_answer') return 'no_answer'
    // the relay or the bridge says it has no Schedules: "update", not a generic failure
    if (e.code === 'scheduler_unavailable') return /relay/i.test(e.message) ? 'update_relay' : 'update_mac'
    return e.code
  }
  return 'internal'
}

/** One `schedules.list`, shared by everyone who asks while it is running. */
export function refreshSchedules(client: TalosClient): Promise<void> {
  const cur = inflight.get(client)
  if (cur) return cur.p
  const token = {}
  const ac = new AbortController()
  // a request may speak only while no newer one has started: an abandoned one's late failure is not news
  const mine = (latest.get(client) ?? 0) + 1
  latest.set(client, mine)
  const p = (async () => {
    try {
      await client.schedules.listSchedules({ signal: ac.signal })
    } catch (e) {
      // an abandoned request's late failure says nothing about the list a newer one fetched
      if (ac.signal.aborted || latest.get(client) !== mine) return
      const s = client.store.getState().schedules
      setSlice(client, { status: 'error', error: errorName(e, s.status === 'error' ? s.error : null) })
    } finally {
      if (inflight.get(client)?.token === token) inflight.delete(client)
    }
  })()
  inflight.set(client, { token, p, ac })
  return p
}

/**
 * The Mac went away: a request it was answering will never be answered, only time out. It is let go, so the refresh when
 * the Mac is back starts a new one at once instead of waiting on the dead one.
 */
export function abandonRefresh(client: TalosClient): void {
  inflight.get(client)?.ac.abort() // it stops waiting, and writes nothing from now on (socketSchedules.ts)
  inflight.delete(client)
}

/** How long the page waits for the saved list before it says the Mac is offline: an IndexedDB open can hang (another tab
 * holding an upgrade), and an endless "Loading…" is worse than an "offline" that the saved list then replaces. */
export const CACHE_LOOK_MS = 2000

const lookLimit = (f: () => void): (() => void) => {
  const t = setTimeout(f, CACHE_LOOK_MS)
  return () => clearTimeout(t)
}

export async function loadCached(
  client: TalosClient,
  storage: Storage,
  limit: (giveUp: () => void) => (() => void) | undefined = lookLimit,
): Promise<void> {
  if (client.store.getState().schedules.snapshot) return
  const lookOver = () => {
    if (!client.store.getState().schedules.cacheChecked) setSlice(client, { cacheChecked: true })
  }
  const stop = limit(lookOver) // past the limit the page may say the Mac is offline; a late answer below still draws the list
  try {
    const c = await storage.get<{ snapshot: ScheduleSnapshotT }>('schedules', CACHE_KEY)
    if (c?.snapshot && !client.store.getState().schedules.snapshot)
      setSlice(client, { snapshot: c.snapshot, status: 'ready', revs: revsOf(c.snapshot), cacheChecked: true })
  } catch {}
  stop?.()
  // found or not, the look is over: only now may the screen say there is nothing to show
  lookOver()
}

/**
 * Mounted once in the shell chrome: cache, first load, reconnect load, `schedule.status` handling, and the cache write.
 * Safe to mount twice (the in-flight list is shared).
 */
export function useSchedulesSync(): void {
  const client = useTalosClient()
  const storage = useStorage()
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const snapshot = useTalos((s) => s.schedules.snapshot)

  useEffect(() => {
    void loadCached(client, storage)
  }, [client, storage])

  useEffect(() => {
    if (macOnline) void refreshSchedules(client)
    else abandonRefresh(client)
  }, [client, macOnline])

  useEffect(() => {
    return client.onFrame('schedule.status', (f) => {
      const s = client.store.getState().schedules
      if (s.snapshot) setSlice(client, { snapshot: { ...s.snapshot, health: f.health } })
      if (needsRefetch(f, s.revs)) void refreshSchedules(client)
    })
  }, [client])

  useEffect(() => {
    if (snapshot) void storage.put('schedules', CACHE_KEY, { snapshot }).catch(() => {})
  }, [storage, snapshot])
}

/** The dot on the Schedules tab. */
export function useSchedulesDot(): boolean {
  const snapshot = useTalos((s) => s.schedules.snapshot)
  // a coarse clock is enough: failures age out over 24 h
  return useMemo(() => navDot(snapshot, Date.now()), [snapshot])
}
