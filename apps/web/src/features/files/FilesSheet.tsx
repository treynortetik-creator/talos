// The Library on a phone or tablet: a bottom sheet over the chat listing the pages and files sent in Talos (SentFiles.tsx), asked for each
// time it opens. The thread's folder on the Mac is Thread files (`/files`, features/files/ThreadFiles.tsx).

import { IconClose } from '../../ui/icons.tsx'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../ui/sheet.tsx'
import { SentFiles } from './SentFiles.tsx'
import { SENT_TEXT } from './sentLogic.ts'

export function FilesSheet({
  open,
  onOpenChange,
}: {
  /** The thread it was opened from (the list covers every thread). */
  threadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        aria-describedby={undefined}
        className="flex h-[85dvh] flex-col gap-2 overflow-hidden px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {open && <Body />}
      </SheetContent>
    </Sheet>
  )
}

function Body() {
  return (
    <>
      <div aria-hidden="true" className="mx-auto h-1.5 w-10 shrink-0 rounded-pill bg-line" />
      <div className="flex shrink-0 items-center gap-2 pl-1">
        <div className="flex min-w-0 flex-col">
          <SheetTitle className="m-0 text-lg font-semibold">{SENT_TEXT.title}</SheetTitle>
          <span className="truncate text-xs text-text-2">{SENT_TEXT.subtitle}</span>
        </div>
        <span className="flex-1" />
        <SheetClose
          aria-label={SENT_TEXT.close}
          className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
        >
          <IconClose width={18} height={18} />
        </SheetClose>
      </div>
      <SentFiles layout="list" />
    </>
  )
}
