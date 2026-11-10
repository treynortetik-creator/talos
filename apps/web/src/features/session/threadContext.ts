// Whose context the chip and the Session panel show (docs/OPTION-C.md 9.3). A thread answered by main shows main's. A
// thread with its own session shows THAT worker's, never main's: live or busy = its current reading; parked, starting,
// stopped or unknown = its last known reading (dimmed); no reading ever = "not running". Weekly usage is account-wide and
// always comes from main's state, so it is not part of this.
import type { SessionStateT, WorkerStatusItemT } from '@talos-app/protocol'
import { useStore } from 'zustand'
import { useThreadSessionView } from '../thread-sessions/store.ts'
import { contextUsed } from './logic.ts'
import { useSessionController } from './store.ts'

/** main: main answers · worker: the worker's current reading · last: its last known one · off: a worker with none. */
export type ContextKind = 'main' | 'worker' | 'last' | 'off'
export type ThreadContext = { kind: ContextKind; ctx: ReturnType<typeof contextUsed> }

/** The states in which a worker is running and its reading is current. */
const RUNNING: readonly WorkerStatusItemT['state'][] = ['live', 'busy']

export function resolveThreadContext(a: {
  main: SessionStateT | undefined
  worker: SessionStateT | undefined
  dedicated: boolean
  workerState: WorkerStatusItemT['state'] | undefined
}): ThreadContext {
  if (!a.dedicated) return { kind: 'main', ctx: contextUsed(a.main) }
  const ctx = contextUsed(a.worker)
  if (a.workerState && RUNNING.includes(a.workerState)) return { kind: 'worker', ctx }
  return ctx ? { kind: 'last', ctx } : { kind: 'off', ctx: undefined }
}

export function useThreadContext(threadId: string | undefined): ThreadContext {
  const ctl = useSessionController()
  const main = useStore(ctl.store, (s) => s.state)
  const worker = useStore(ctl.store, (s) => (threadId ? s.threadStates[threadId] : undefined))
  const view = useThreadSessionView(threadId ?? '')
  return resolveThreadContext({
    main,
    worker,
    dedicated: threadId !== undefined && view.dedicated,
    workerState: view.worker?.state,
  })
}
