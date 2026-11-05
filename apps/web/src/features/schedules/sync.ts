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
const inflight = new WeakMap<TalosClient, Promise<void>>()

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
  if (cur) return cur
  const p = (async () => {
    try {
      await client.schedules.listSchedules()
    } catch (e) {
      const s = client.store.getState().schedules
      setSlice(client, { status: 'error', error: errorName(e, s.status === 'error' ? s.error : null) })
    } finally {
      inflight.delete(client)
    }
  })()
  inflight.set(client, p)
  return p
}

export async function loadCached(client: TalosClient, storage: Storage): Promise<void> {
  if (client.store.getState().schedules.snapshot) return
  try {
    const c = await storage.get<{ snapshot: ScheduleSnapshotT }>('schedules', CACHE_KEY)
    if (c?.snapshot && !client.store.getState().schedules.snapshot)
      setSlice(client, { snapshot: c.snapshot, status: 'ready', revs: revsOf(c.snapshot) })
  } catch {}
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
