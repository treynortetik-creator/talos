// One place that decides whether a thread's working/queued status is still believable (D17). A row that old is a
// leftover (a dead Mac, a lost frame), so every reader of statuses (Home, the thread screen, the sidebar, the pet) goes
// through here instead of reading `statuses[id]` raw.
import type { ThreadStatusT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { useMemo } from 'react'
import { useTalos } from './client.ts'

/** A working or queued row older than this is a leftover, not live work. */
export const STALE_STATUS_MS = 6 * 3_600_000

/** The status as it should be read now: an old working/queued row reads as idle (no label), anything else is untouched. */
export function freshStatus(st: ThreadStatusT | undefined, nowMs: number): ThreadStatusT | undefined {
  if (!st) return st
  if ((st.state === 'working' || st.state === 'queued') && nowMs - Date.parse(st.since) > STALE_STATUS_MS)
    return { thread_id: st.thread_id, state: 'idle', since: st.since }
  return st
}

export function freshStatuses(map: Record<string, ThreadStatusT>, nowMs: number): ThreadStatusT[] {
  return Object.values(map).map((s) => freshStatus(s, nowMs) as ThreadStatusT)
}

/** `statuses[threadId]`, with the staleness rule applied. */
export function useThreadStatus(threadId: string): ThreadStatusT | undefined {
  const raw = useTalos((s) => ownValue(s.statuses, threadId))
  return useMemo(() => freshStatus(raw, Date.now()), [raw])
}
