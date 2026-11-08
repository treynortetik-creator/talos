// The Session panel docked on the right of a thread (desktop, 1024 px and up). It sits beside the chat, never over it, and
// takes no focus: typing and clicking in the chat go on while it is open. It closes only on its own cross or on the usage chip.
import { IconClose } from '../../ui/icons.tsx'
import { setSessionDockOpen } from './dockPref.ts'
import { SessionPanel } from './SessionPanel.tsx'

export function SessionDock({ threadId }: { threadId: string }) {
  return (
    <aside
      id="session-dock"
      aria-label="Session"
      data-testid="session-dock"
      className="flex w-[22.5rem] shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-[max(0.625rem,env(safe-area-inset-top))] pb-2">
        <h2 className="m-0 font-display text-xl font-semibold">Session</h2>
        <button
          type="button"
          aria-label="Close session panel"
          onClick={() => {
            setSessionDockOpen(false)
            // the cross is about to leave the page: focus goes back to the chip that opens this panel
            document.querySelector<HTMLElement>('[data-testid="session-trigger"]')?.focus()
          }}
          className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
        >
          <IconClose />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
        <SessionPanel threadId={threadId} />
      </div>
    </aside>
  )
}
