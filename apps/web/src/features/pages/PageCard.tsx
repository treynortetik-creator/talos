// The page card in the chat: drawn under the agent's message when publish_page put a page in the thread (`Message.page`,
// docs/ORG-PAGES-SPEC.md phase 1). Display only, no approval.
//
// The message is not trusted for anything but which page to ask about: a thread session can mint `page`, so it could name
// another thread's page under a made-up title. The card therefore shows nothing until GET /api/pages/:id answers, and only
// when that page belongs to this message's thread; everything it shows (the title, which version, who can open it) is the
// relay's, never the message's. A page the relay no longer has says so (without the message's title). A version the page no
// longer lists says this message is about an older one; Open still shows the current page, in the sandboxed frame the
// relay serves at /p/<id>/frame (an opaque origin, no network). Share stays off until coworker sign-in exists (phase 3).
import type { PageInfoT, PageRefT } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { Button } from '../../ui/index.ts'
import { FrameOverlay, SandboxedFrame } from '../../ui/SandboxedFrame.tsx'
import { fetchPage, PAGES_TEXT, pageFrameUrl, pageShareLabel } from './pagesData.ts'

export const PAGE_CARD_TEXT = {
  kicker: 'Page',
  version: (n: number) => `Version ${n}`,
  older: 'This message is about an older version. Open shows the current one.',
  open: 'Open',
  openLabel: (title: string) => `Open ${title} full screen`,
  share: 'Share',
  shareLater: 'Coworker sharing comes later.',
} as const

type Info = { state: 'loading' } | { state: 'ready'; page: PageInfoT } | { state: 'missing' } | { state: 'failed' }

function usePageInfo(id: string): Info {
  const client = useTalosClient()
  const [info, setInfo] = useState<Info>({ state: 'loading' })
  useEffect(() => {
    let live = true
    setInfo({ state: 'loading' })
    fetchPage(client, id).then(
      (p) => live && setInfo(p === 'missing' ? { state: 'missing' } : { state: 'ready', page: p }),
      () => live && setInfo({ state: 'failed' }),
    )
    return () => {
      live = false
    }
  }, [client, id])
  return info
}

export function PageCard({
  pageRef,
  threadId,
  nowMs = Date.now(),
  className,
}: {
  pageRef: PageRefT
  /** The thread of the message that carries the card: a page from any other thread draws no card. */
  threadId: string
  nowMs?: number
  className?: string | undefined
}) {
  const info = usePageInfo(pageRef.page_id)
  if (info.state === 'missing')
    return (
      <p data-testid="page-missing" className={cn('m-0 text-sm text-text-2', className)}>
        {PAGES_TEXT.missing}
      </p>
    )
  // not yet known, not reachable, or not this thread's: the message's own text is all there is
  if (info.state !== 'ready' || info.page.thread_id !== threadId) return null
  return <Card page={info.page} version={pageRef.version} nowMs={nowMs} className={className} />
}

function Card({
  page,
  version,
  nowMs,
  className,
}: {
  page: PageInfoT
  version: string
  nowMs: number
  className?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const openBtn = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    requestAnimationFrame(() => openBtn.current?.focus()) // back to the button that opened it
  }
  const older = !page.versions.some((v) => v.hash === version)
  const shareId = `share-later-${page.id}`
  return (
    <article
      aria-label={`${PAGE_CARD_TEXT.kicker}: ${page.title}`}
      data-testid="page-card"
      className={cn('flex flex-col gap-3 rounded-card border border-line bg-surface p-4', className)}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-semibold tracking-wide text-text-2 uppercase">{PAGE_CARD_TEXT.kicker}</span>
          <h3 className="m-0 truncate text-base font-semibold">{page.title}</h3>
          <span className="text-xs text-text-2">{PAGE_CARD_TEXT.version(page.versions.length)}</span>
        </div>
        <span data-chip="share" className="shrink-0 rounded-pill border border-line px-2 py-0.5 text-xs text-text-2">
          {pageShareLabel(page.share, nowMs)}
        </span>
      </div>
      {older && (
        <p data-testid="page-older" className="m-0 text-xs text-text-2">
          {PAGE_CARD_TEXT.older}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={openBtn} aria-label={PAGE_CARD_TEXT.openLabel(page.title)} onClick={() => setOpen(true)}>
          {PAGE_CARD_TEXT.open}
        </Button>
        <Button variant="outline" disabled aria-describedby={shareId}>
          {PAGE_CARD_TEXT.share}
        </Button>
        <span id={shareId} className="text-xs text-text-2">
          {PAGE_CARD_TEXT.shareLater}
        </span>
      </div>
      {open && (
        <FrameOverlay title={page.title} onClose={close}>
          <SandboxedFrame
            title={`${page.title} (full screen)`}
            src={pageFrameUrl(page.id)}
            className="block min-h-0 w-full flex-1 bg-surface"
          />
        </FrameOverlay>
      )}
    </article>
  )
}
