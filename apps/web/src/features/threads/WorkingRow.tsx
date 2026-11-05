// D15: a visible "working" row between the timeline and the composer, with Stop beside it.
import { ownValue, type ThreadStatusT, threadSessionMode } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { useThreadStatus } from '../../lib/threadStatus.ts'
import { Button } from '../../ui/button.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { useSessionController } from '../session/store.ts'
import { useModBusy } from '../session/useModBusy.ts'
import { useAgentName } from './useThreads.ts'

/** A thread with its own worker session: main's `busy` and turn say nothing about it. */
function useDedicated(threadId: string): boolean {
  return useTalos((s) => (s.config ? threadSessionMode(s.config, threadId) === 'dedicated' : false))
}

/**
 * The state this thread shows. The mod's `busy` is global (main's) and carries no thread, so it only counts here when
 * the thread is on main's session and the newest row is the owner's (a turn the owner started that nothing has answered
 * yet). Otherwise the thread's own status wins. An old working row has already been read as idle (D17).
 */
export function useThreadState(threadId: string): ThreadStatusT['state'] | undefined {
  const status = useThreadStatus(threadId)
  const lastIsOwner = useTalos((s) => ownValue(s.messages, threadId)?.at(-1)?.author === 'owner')
  const dedicated = useDedicated(threadId)
  const modBusy = useModBusy()
  if (status?.state === 'on_call' || status?.state === 'needs_you') return status.state
  if (status?.state === 'working') return 'working'
  if (modBusy && lastIsOwner && !dedicated) return 'working'
  return status?.state
}

export function WorkingRow({ threadId }: { threadId: string }) {
  const agent = useAgentName()
  const state = useThreadState(threadId)
  const dedicated = useDedicated(threadId)
  const ctl = useSessionController()
  const busyCtl = useStore(ctl.store, (s) => Object.keys(s.pending).length > 0)
  // same rule as SessionPanel: the mod is online and can stop, a turn is running, and we know which one. A dedicated
  // thread's worker is a different session: Stop here would hit main's turn, so it is not offered.
  const showStop = useStore(
    ctl.store,
    (s) =>
      s.modOnline &&
      s.state?.capabilities.includes('stop') === true &&
      s.state.busy === true &&
      Boolean(s.state.turn_id),
  )
  // the panel is closed when Stop is tapped here, so a refusal or a timeout is shown in the row
  const [stopError, setStopError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!showStop) setStopError(null)
  }, [showStop])
  if (state !== 'working') return null
  const stop = async () => {
    setStopError(null)
    const o = await ctl.stopTurn(threadId)
    if (alive.current && o.kind === 'error') setStopError(o.text)
  }
  return (
    <div
      data-testid="working-row"
      role="status"
      className="kb-hide-banner mx-3 mb-2 flex min-h-11 flex-wrap items-center gap-x-2 rounded-card border border-line bg-surface px-3 text-sm text-text-2"
    >
      <StatusDot shape="half" className="text-accent-text" />
      <span className="min-w-0 flex-1 truncate">{agent} is working…</span>
      {showStop && !dedicated && (
        <Button variant="danger" className="border border-danger" disabled={busyCtl} onClick={() => void stop()}>
          Stop
        </Button>
      )}
      {stopError && (
        <p role="alert" data-testid="working-row-error" className="m-0 basis-full pb-2 text-danger">
          {stopError}
        </p>
      )}
    </div>
  )
}
