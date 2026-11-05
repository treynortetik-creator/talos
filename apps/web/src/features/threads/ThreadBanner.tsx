// D18: a tap-to-jump banner when a reply lands in a thread other than the one on screen. Pushes are skipped while the
// owner is active on a screen, so this is the only signal. It reads the client store (a higher unread count, then the
// newest fresh agent message in that thread, in a thread that notifies), never socketClient.
import { useEffect, useRef, useState } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { useTalosClient } from '../../lib/client.ts'
import { IconClose } from '../../ui/icons.tsx'
import { Toast, ToastAction, ToastClose, ToastDescription, ToastTitle } from '../../ui/toast.tsx'
import { type Banner, watchForBanner } from './bannerWatch.ts'

export function ThreadBanner() {
  const client = useTalosClient()
  const nav = useNavigate()
  const onThread = useMatch('/t/:thread')
  const onCard = useMatch('/card/:id')
  // the thread on screen: /t/:thread, or the thread of the card on /card/:id (CardScreen renders that thread's view)
  const viewing = useRef<string | null>(null)
  const cardId = onCard?.params.id ?? null
  viewing.current = onThread?.params.thread ?? null
  const viewingCard = useRef<string | null>(null)
  viewingCard.current = cardId
  const [banner, setBanner] = useState<Banner | null>(null)

  useEffect(
    () =>
      watchForBanner(
        client.store,
        (st) => viewing.current ?? st.cards.find((c) => c.id === viewingCard.current)?.thread_id ?? null,
        setBanner,
      ),
    [client],
  )

  // the owner arrived at the thread the banner points to (by the banner or any other way): it has done its job
  const onScreenThread = onThread?.params.thread ?? null
  useEffect(() => {
    if (onScreenThread !== null) setBanner((b) => (b?.threadId === onScreenThread ? null : b))
  }, [onScreenThread])

  if (!banner) return null
  return (
    <Toast
      key={banner.key}
      open
      duration={7000}
      onOpenChange={(o) => {
        if (!o) setBanner(null)
      }}
      data-testid="thread-banner"
      className="pointer-events-auto flex items-center gap-1 p-1 shadow-lg"
    >
      <ToastAction
        altText={`Open ${banner.name}`}
        data-testid="thread-banner-open"
        onClick={() => nav(`/t/${banner.threadId}`)}
        className="min-h-11 min-w-0 flex-1 rounded-button px-2 py-1 text-left"
      >
        <ToastTitle className="block truncate">{banner.name}</ToastTitle>
        <ToastDescription className="block truncate">{banner.snippet}</ToastDescription>
      </ToastAction>
      <ToastClose
        aria-label="Dismiss"
        className="grid size-11 shrink-0 place-items-center rounded-pill text-text-2 hover:bg-surface-2"
      >
        <IconClose />
      </ToastClose>
    </Toast>
  )
}
