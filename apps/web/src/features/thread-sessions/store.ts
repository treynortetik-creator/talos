// Option C in the app (docs/OPTION-C.md): the last `workers.status` the Mac sent (also in `ready.workers_status`), and
// the park / resume / restart / fresh controls. One store per client, refcounted like the session controller.
import {
  canBeDedicated,
  dedicatedSettings,
  type ErrorCodeT,
  type FrameOf,
  newUlid,
  THREAD_SESSIONS_FEATURE,
  type ThreadSessionActionT,
  threadSessionMode,
  type WorkerStatusItemT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { useEffect, useMemo } from 'react'
import { type StoreApi, useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { type TalosClient, TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'

export type ControlOutcome = { ok: boolean; text: string; code?: ErrorCodeT }
type State = {
  status: WorkersStatusT | undefined
  pending: Record<string, ThreadSessionActionT>
  last?: ControlOutcome
}

export type ThreadSessionsController = {
  readonly store: StoreApi<State>
  start(): () => void
  control(threadId: string, action: ThreadSessionActionT): Promise<ControlOutcome>
}

const RESULT_WAIT_MS = 30_000

export function createThreadSessionsController(client: TalosClient): ThreadSessionsController {
  const store = createStore<State>(() => ({ status: undefined, pending: {} }))
  const waiters = new Map<string, (o: ControlOutcome) => void>()
  let refs = 0
  let off: Array<() => void> = []
  const settle = (id: string, o: ControlOutcome) => {
    const w = waiters.get(id)
    if (!w) return
    waiters.delete(id)
    const { [id]: _gone, ...rest } = store.getState().pending
    store.setState({ pending: rest, last: o })
    w(o)
  }
  return {
    store,
    start() {
      if (refs++ === 0) {
        off = [
          client.onFrame('workers.status', (f: FrameOf<'workers.status'>) => store.setState({ status: f.status })),
          // replaced, not merged: a ready without it means this Mac or relay doesn't do thread sessions (any more)
          client.onFrame('ready', (f: FrameOf<'ready'>) => store.setState({ status: f.workers_status })),
          client.onFrame('session.control.result', (f: FrameOf<'session.control.result'>) =>
            settle(f.control_id, { ok: f.ok, text: f.text, ...(f.code ? { code: f.code } : {}) }),
          ),
        ]
      }
      let done = false
      return () => {
        if (done) return
        done = true
        if (--refs === 0) {
          for (const o of off) o()
          off = []
        }
      }
    },
    async control(threadId, action) {
      const send = client.sendOwnerFrame
      if (!send) return { ok: false, text: 'This build cannot send that.' }
      const id = newUlid()
      const answered = new Promise<ControlOutcome>((res) => waiters.set(id, res))
      store.setState((s) => ({ pending: { ...s.pending, [id]: action }, last: undefined }))
      const t = setTimeout(() => settle(id, { ok: false, text: 'The Mac did not answer' }), RESULT_WAIT_MS)
      try {
        await send.call(client, { type: 'thread.session.control', control_id: id, thread_id: threadId, action })
      } catch (e) {
        settle(id, {
          ok: false,
          text: e instanceof TalosClientError && e.message ? e.message : "Couldn't reach the Mac.",
          ...(e instanceof TalosClientError ? { code: e.code } : {}),
        })
      }
      const o = await answered
      clearTimeout(t)
      return o
    },
  }
}

const controllers = new WeakMap<TalosClient, ThreadSessionsController>()
export function getThreadSessionsController(client: TalosClient): ThreadSessionsController {
  let c = controllers.get(client)
  if (!c) {
    c = createThreadSessionsController(client)
    controllers.set(client, c)
  }
  return c
}

export function useThreadSessionsController(): ThreadSessionsController {
  const client = useTalosClient()
  const c = useMemo(() => getThreadSessionsController(client), [client])
  useEffect(() => c.start(), [c])
  return c
}

export function useWorkersStatus(): WorkersStatusT | undefined {
  return useStore(useThreadSessionsController().store, (s) => s.status)
}

/** What the app shows for one thread. */
export type ThreadSessionView = {
  /** The switch may be offered at all: master switch on, the Mac supports workers, and the thread may have one. */
  offered: boolean
  /** The master switch is on but the Mac can't host thread sessions right now. */
  unsupported: boolean
  dedicated: boolean
  worker: WorkerStatusItemT | undefined
}

/** The Mac's bridge says it routes thread sessions AND a supervisor that can host them is running. */
export function useThreadSessionsSupported(status: WorkersStatusT | undefined): boolean {
  const listed = useTalos((s) => s.presence.features?.includes(THREAD_SESSIONS_FEATURE) === true)
  return listed && status?.supported === true
}

export function useThreadSessionView(threadId: string): ThreadSessionView {
  const config = useTalos((s) => s.config)
  const status = useWorkersStatus()
  const supported = useThreadSessionsSupported(status)
  if (!config) return { offered: false, unsupported: false, dedicated: false, worker: undefined }
  const on = dedicatedSettings(config).enabled
  const allowed = canBeDedicated(config, threadId)
  return {
    offered: on && supported && allowed,
    unsupported: on && allowed && !supported,
    dedicated: threadSessionMode(config, threadId) === 'dedicated',
    worker: status?.threads.find((t) => t.thread_id === threadId),
  }
}

export const WORKER_STATE_TEXT: Record<WorkerStatusItemT['state'], string> = {
  off: 'Not started',
  starting: 'Starting',
  live: 'Live',
  busy: 'Working',
  parking: 'Parking',
  parked: 'Parked',
  failed: 'Needs attention',
  stopping: 'Stopping',
  unknown: 'Unknown',
}

export const WORKER_ERROR_TEXT: Record<string, string> = {
  needs_mac:
    'It stopped at a question only the Mac can answer. Open Talos Terminal on the Mac, pick this thread under Thread sessions, and answer it there. Then press Restart here to start it again',
  resume_missing: "Its conversation can't be resumed. Start fresh to begin a new one",
  crash_loop: 'It kept crashing, so it was stopped',
  start_failed: "It didn't start",
  folder_claimed: 'Another thread session works in that folder',
  unknown: "It stopped for a reason this version doesn't know. Open Talos Terminal on the Mac to see what happened",
  mode_escalation_denied:
    'It was not started: it would have more access than the main session. Narrow its settings, then press Restart',
}

export function workerLine(w: WorkerStatusItemT | undefined): string {
  if (!w) return 'Starts with the next message.'
  const when = (iso: string | undefined) =>
    iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
  if (w.state === 'failed') return WORKER_ERROR_TEXT[w.error ?? ''] ?? WORKER_STATE_TEXT.failed
  if (w.state === 'parked') return w.parked_at ? `Parked ${when(w.parked_at)}` : 'Parked'
  return WORKER_STATE_TEXT[w.state]
}
