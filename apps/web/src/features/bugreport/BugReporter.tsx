// "Report a bug": the picture of the screen to mark up, what went wrong, what is attached, a preview of every byte, Send.
// Mac, browser and phone share the state (`useReporter`); the phone gets its own full-screen layout. Nothing leaves until Send.

import { useEffect } from 'react'
import { cn } from '../../ui/cn.ts'
import { Dialog, DialogContent } from '../../ui/index.ts'
import { PHONE_QUERY } from '../phone/PhoneChrome.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { pictureFromFile, warmReadBack } from './capture.ts'
import { DesktopLayout } from './DesktopLayout.tsx'
import { PhoneLayout } from './PhoneLayout.tsx'
import { useReporter } from './useReporter.ts'

export function BugReporter() {
  const phone = useMediaQuery(PHONE_QUERY)
  const r = useReporter()
  // mounted with the shell, before any open: the read-back question is answered by the time anyone taps (capture.ts)
  useEffect(() => warmReadBack(), [])
  return (
    <Dialog open={r.open} onOpenChange={(o) => !o && r.close()}>
      <DialogContent
        aria-describedby={undefined}
        data-bug-reporter
        // left out of its own picture, with its overlay
        data-no-capture=""
        overlayProps={{ 'data-no-capture': '' } as never}
        // a pasted image becomes the picture; pasted words go where they always went (a copy from a document can carry both)
        onPaste={(e) => {
          if (e.clipboardData.types.includes('text/plain')) return
          const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
          if (!file) return
          e.preventDefault()
          void pictureFromFile(file).then((c) => c && r.setPicture(c))
        }}
        // Esc inside the text-on-picture field only drops that word; the form stays open
        onEscapeKeyDown={(e) => {
          if (e.target instanceof HTMLElement && e.target.dataset.bugText !== undefined) e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          if (r.returnTo?.isConnected) {
            e.preventDefault()
            r.returnTo.focus()
          }
        }}
        className={cn(
          // the overlay layer (ui/layers.ts) puts it above the floating buttons of the screen behind it
          'flex flex-col p-0',
          phone
            ? 'inset-0 top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none'
            : 'h-[min(92dvh,50rem)] w-[min(96vw,80rem)]',
        )}
      >
        {phone ? <PhoneLayout r={r} /> : <DesktopLayout r={r} />}
      </DialogContent>
    </Dialog>
  )
}
