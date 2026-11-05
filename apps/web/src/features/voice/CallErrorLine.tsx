// Why a call could not start: one line in the flow of the composer, never floating over the thread. It sat above the
// call button before, on top of the "working" row and its Stop button. Tap it to dismiss; it also goes by itself
// (see `ERROR_SHOWN_MS` in the controller), when a new call starts, and when the owner moves to another thread.
import { useEffect, useRef } from 'react'
import { IconClose } from '../../ui/icons.tsx'
import { useCallStore } from './callStore.ts'
import { getCallController } from './controller.ts'

export function CallErrorLine({ threadId }: { threadId: string }) {
  const c = getCallController()
  const error = useCallStore(c.store, (s) => s.error)
  const phase = useCallStore(c.store, (s) => s.phase)
  // The thread screen is keyed by thread, so moving to another thread remounts this line and a "did the thread change"
  // ref would start over. The controller remembers which thread the error was first seen on.
  useEffect(() => {
    c.noteViewing(threadId)
    return c.store.subscribe(() => c.noteViewing(threadId))
  }, [threadId, c])
  const line = useRef<HTMLDivElement>(null)
  const dismiss = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Only a keyboard or screen-reader activation has focus on this button, and it is about to unmount, which would
    // drop focus to the page. A tap never took focus (onMouseDown below), so the box keeps it, and the on-screen
    // keyboard with it.
    const hadFocus = document.activeElement === e.currentTarget
    const row = line.current?.parentElement
    c.dismissError()
    if (!hadFocus) return
    const again = row?.querySelector<HTMLElement>('[aria-label="Start a live call"]:not(:disabled)')
    ;(again ?? row?.querySelector<HTMLElement>('.composer-box'))?.focus()
  }
  if (!error || phase !== 'idle') return null
  return (
    <div ref={line} role="alert" data-testid="call-error" className="mb-2 flex min-h-11 items-center gap-2">
      <button
        type="button"
        aria-label={`${error} Dismiss`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={dismiss}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-card border border-line bg-surface px-3 text-left text-sm text-danger"
      >
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <IconClose width={16} height={16} aria-hidden="true" />
      </button>
    </div>
  )
}
