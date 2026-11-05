// The one call controller of this page, in its own small module so the thread screen can follow the call's phase without
// pulling in the lazily loaded call UI.
import { CallController } from './callController.ts'
import { useCallStore } from './callStore.ts'
import { browserDeps } from './media.ts'

let controller: CallController | null = null

/** The one call controller of this page. Tests and the harness replace it with a fake-backed one. */
export function getCallController(): CallController {
  controller ??= new CallController(browserDeps())
  return controller
}
export function setCallController(c: CallController | null): void {
  controller = c
}

/** True from tapping the call button until the call is over: the shell swaps the composer for the call bar. */
export function useIsOnCall(threadId?: string): boolean {
  return useCallStore(
    getCallController().store,
    (s) => s.phase !== 'idle' && (threadId === undefined || s.threadId === null || s.threadId === threadId),
  )
}
