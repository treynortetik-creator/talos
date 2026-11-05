// The session sheet: bottom sheet on phones, right-hand sheet on desktop.
import { IconClose } from '../../ui/icons.tsx'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../ui/index.ts'
import { keepOnOpenerTap } from '../phone/PhoneChrome.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { SessionPanel } from './SessionPanel.tsx'

export function SessionSheet({
  open,
  onOpenChange,
  threadId,
  returnFocus,
  drawer,
  status,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threadId: string
  /** Where focus goes on close when the opener is not a Radix Trigger (the agents chip). */
  returnFocus?: React.RefObject<HTMLElement | null>
  /** Phones: a full-height drawer from the right edge (the header has no status text, so `status` shows it here). */
  drawer?: boolean
  status?: React.ReactNode
}) {
  const wide = useMediaQuery('(min-width: 1024px)')
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={drawer || wide ? 'right' : 'bottom'}
        aria-describedby={undefined}
        data-testid="session-sheet"
        {...(drawer ? { onPointerDownOutside: keepOnOpenerTap } : {})}
        {...(returnFocus
          ? {
              onCloseAutoFocus: (e: Event) => {
                e.preventDefault()
                returnFocus.current?.focus()
              },
            }
          : {})}
        className={
          drawer
            ? 'drawer-anim pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]'
            : 'pb-[max(1rem,env(safe-area-inset-bottom))]'
        }
      >
        <div className="mb-4 flex items-center justify-between">
          <SheetTitle className="m-0 font-display text-xl font-semibold">Session</SheetTitle>
          <SheetClose aria-label="Close" className="grid size-11 place-items-center rounded-pill hover:bg-surface-2">
            <IconClose />
          </SheetClose>
        </div>
        {status}
        <SessionPanel threadId={threadId} />
      </SheetContent>
    </Sheet>
  )
}
