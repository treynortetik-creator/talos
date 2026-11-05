import type { AttachmentRefT } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconArrowDown, IconShare } from '../../ui/icons.tsx'
import { mediaUrl, useMediaGate } from './media.ts'
import { type DeliveryNote, useDelivery } from './useDelivery.ts'

export function DeliveryNoteView({
  note,
  att,
  floating,
}: {
  note: DeliveryNote
  att: AttachmentRefT
  floating?: boolean
}) {
  if (!note) return null
  return (
    <span
      role={note.kind === 'error' ? 'alert' : 'status'}
      data-testid="delivery-note"
      className={cn(
        'text-sm',
        floating
          ? 'absolute bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+3.5rem)] left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-card bg-black/80 px-3 py-2 text-white'
          : 'text-text-2',
      )}
    >
      {note.text}
      {note.manual && (
        <>
          {' '}
          <a href={`${mediaUrl(att.media_id)}?c=2`} target="_blank" rel="noopener noreferrer" className="underline">
            Open {att.name}
          </a>
        </>
      )}
    </span>
  )
}

/** True once the element has been on screen (or at once where IntersectionObserver is missing). */
function useInView(): [(el: Element | null) => void, boolean] {
  const [el, setEl] = useState<Element | null>(null)
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (!el || seen || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((rows) => rows.some((r) => r.isIntersecting) && setSeen(true), {
      rootMargin: '300px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [el, seen])
  return [setEl, seen]
}

/**
 * The one Share (phone) / Download (desktop) control for an attachment that has no download link of its own. It waits for the
 * media gate: no tap lands on the relay's 410. `floating` is the pill drawn over the image viewer.
 */
export function ShareButton({ att, floating = false }: { att: AttachmentRefT; floating?: boolean }) {
  const gate = useMediaGate(att, mediaUrl(att.media_id), undefined, false)
  const [ref, inView] = useInView()
  const d = useDelivery(att, gate.state, inView)
  const testId = floating ? 'viewer-save' : 'attachment-share'
  const look = cn(
    'inline-flex min-h-11 items-center gap-2 text-sm focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60',
    floating
      ? 'absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-10 -translate-x-1/2 rounded-pill bg-black/60 px-5 font-semibold text-white'
      : 'self-start rounded-pill px-2 text-text-2 hover:text-text',
  )
  const icon = d.verb === 'Share' ? <IconShare width={18} height={18} /> : <IconArrowDown width={18} height={18} />
  let control: React.ReactNode
  if (gate.state === 'ready') {
    control = (
      <a
        ref={ref}
        href={gate.url}
        download={d.download}
        onClick={d.onClick}
        onPointerDown={d.onPointerDown}
        aria-label={`${d.verb} ${att.name}`}
        aria-busy={d.preparing}
        data-testid={testId}
        data-prepared={d.fileReady ? 'true' : 'false'}
        className={look}
      >
        {icon}
        <span>{d.busyLabel ? 'Preparing…' : d.verb}</span>
      </a>
    )
  } else if (gate.state === 'gone') {
    control = (
      <button ref={ref} type="button" onClick={gate.load} data-testid={testId} className={look}>
        {icon}
        <span>Get {att.name}</span>
      </button>
    )
  } else if (gate.state === 'failed') {
    control = (
      <>
        <button ref={ref} type="button" onClick={gate.retry} data-testid={testId} className={look}>
          {icon}
          <span>Try again</span>
        </button>
        <span role="alert" className={floating ? 'sr-only' : 'text-sm text-text-2'}>
          This file expired from the relay; ask the agent to resend.
        </span>
      </>
    )
  } else {
    control = (
      <button ref={ref} type="button" disabled aria-busy="true" data-testid={testId} className={look}>
        {icon}
        <span>{gate.state === 'fetching' ? 'Fetching…' : 'Checking…'}</span>
      </button>
    )
  }
  return (
    <>
      {control}
      <DeliveryNoteView note={d.note} att={att} floating={floating} />
    </>
  )
}
