// D15: the working indicator. The bar is a thin line on the top edge of the message box that takes no room (a zero-height
// element, so nothing is pushed or covered). Stop is on the working line under the newest message (WorkingLine, 2026-11-20,
// Option B), which also says "is working" to screen readers: the bar is silent.
import { ownValue, type ThreadStatusT, threadSessionMode } from '@talos-app/protocol'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { useThreadStatus } from '../../lib/threadStatus.ts'
import { useSessionController } from '../session/store.ts'
import { useModBusy } from '../session/useModBusy.ts'

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

/**
 * What the working line needs to offer Stop: the same rule as SessionPanel (the mod is online and can stop, a turn is
 * running, and we know which one). A dedicated thread's worker is a different session, so Stop there would hit main's turn
 * and is not offered. The panel is closed when Stop is tapped here, so a refusal or a timeout is returned for the line to show.
 * stop() resolves to the outcome, so the caller can tell a stop that went through from one that did not.
 */
export function useWorkingStop(threadId: string) {
  const state = useThreadState(threadId)
  const dedicated = useDedicated(threadId)
  const ctl = useSessionController()
  const busy = useStore(ctl.store, (s) => Object.keys(s.pending).length > 0)
  const canStop = useStore(
    ctl.store,
    (s) =>
      s.modOnline &&
      s.state?.capabilities.includes('stop') === true &&
      s.state.busy === true &&
      Boolean(s.state.turn_id),
  )
  const working = state === 'working'
  const showStop = canStop && !dedicated && working
  // The outcome goes to the caller: WorkingLine shows an error above the message box, where it outlives the turn.
  const stop = () => ctl.stopTurn(threadId)
  return { working, showStop, busy, stop }
}

export type WorkingStop = ReturnType<typeof useWorkingStop>

/**
 * The bar: no height, margin, padding or border of its own, so it costs the screen nothing. Its line is drawn over the
 * message box's top edge (3 px, never takes a tap). Purely visual: the working line is the live status for screen readers.
 */
export function WorkingRow({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId)
  if (state !== 'working') return null
  return (
    <div data-testid="working-row" aria-hidden="true" className="relative h-0 shrink-0">
      <div
        data-testid="working-line"
        className="pointer-events-none absolute inset-x-0 -top-px h-[3px] overflow-hidden"
        aria-hidden="true"
      >
        <div data-testid="working-line-fill" className="working-line-fill h-full" />
      </div>
    </div>
  )
}
