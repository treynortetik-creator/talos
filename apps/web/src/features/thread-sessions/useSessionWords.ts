// The words for one thread's own session, live: workers.status (what the supervisor wrote), a pending permission card for that
// thread, the session's plan window (the "about" reset for a usage limit) and the governor, on the relay's clock and re-read
// every 30 s so "since" and the duration stay true. Null for a thread with no session of its own (it is answered by Main).
import type { SessionStateT } from '@talos-app/protocol'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { useHost } from '../../lib/hostWords.ts'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'
import { useRelayNow } from '../cards/util.ts'
import { useSessionController } from '../session/store.ts'
import { useThreadSessionView, useWorkersStatus } from './store.ts'
import { type SessionWords, sessionWords } from './words.ts'

/** The plan window that resets soonest after `now`: the nearest a usage limit can clear, said as "about". */
export function soonestReset(state: SessionStateT | undefined, now: number): string | undefined {
  let best: string | undefined
  for (const r of state?.rate_limits ?? []) {
    const at = r.resets_at ? Date.parse(r.resets_at) : Number.NaN
    if (!Number.isFinite(at) || at <= now) continue
    if (best === undefined || at < Date.parse(best)) best = r.resets_at
  }
  return best
}

export function useSessionWords(threadId: string): SessionWords | null {
  const view = useThreadSessionView(threadId)
  const status = useWorkersStatus()
  // only a permission request is "a permission request"; another card in the thread is the agent's, not the session's wait
  const pendingCard = useAwaitingOwner(threadId).some((c) => c.kind === 'permission')
  const online = useTalos((s) => s.connection === 'online')
  const ctl = useSessionController()
  const threadState = useStore(ctl.store, (s) => s.threadStates[threadId])
  const now = useRelayNow()
  const host = useHost()
  if (!view.dedicated || !status) return null
  return sessionWords({
    item: view.worker,
    now,
    supervisorOnline: status.supervisor_online,
    // this page not connected is as unknown as the Mac not reporting: the last picture, never said as live
    pageOffline: !online,
    statusAt: status.at,
    governorResetsAt: status.governor.resets_at,
    aboutResetsAt: soonestReset(threadState, now),
    pendingCard,
    host,
  })
}

/** Whether the row (and the header) should show the session instead of the usual line: only when there is something to say. */
export const rowShowsSession = (w: SessionWords | null): w is SessionWords =>
  !!w && w.tone !== 'idle' && w.tone !== 'none'
