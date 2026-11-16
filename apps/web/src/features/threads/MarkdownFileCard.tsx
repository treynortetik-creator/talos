// A Markdown attachment (.md) opens in the app the way an HTML page does: a card in the timeline (`MarkdownFileCard`) with an Expand
// that takes the whole viewport. The text is rendered by the one markdown renderer (lib/markdown.ts via ./Markdown.tsx): no raw HTML,
// links leave through `platform.openExternal`, and a relative image shows only if it names an image attachment of the same message.
// Files over LARGE_BYTES are cut into chunks (markdownDoc.ts) and drawn one chunk at a time as the reader scrolls.
import type { AttachmentRefT } from '@talos-app/protocol'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MdImages } from '../../lib/markdown.ts'
import { cn } from '../../ui/cn.ts'
import { IconClose, IconExpand } from '../../ui/icons.tsx'
import { OVERLAY_BOX_CLASS, useFrameOverlay } from '../../ui/SandboxedFrame.tsx'
import { Markdown } from './Markdown.tsx'
import { MediaStatus } from './MediaStatus.tsx'
import { type Chunk, type Heading, LARGE_BYTES, siblingImages, splitDoc } from './markdownDoc.ts'
import { MD_TEXT } from './markdownViewerText.ts'
import { mediaUrl, useMediaGate } from './media.ts'

type Mode = 'rendered' | 'source'

/** The file's text, once the media gate says the bytes are there. */
function useDocText(url: string, enabled: boolean) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read
  useEffect(() => {
    if (!enabled) return
    const ac = new AbortController()
    setFailed(false)
    void fetch(url, { credentials: 'same-origin', signal: ac.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setText)
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true)
      })
    return () => ac.abort()
  }, [url, enabled, attempt])
  return { text, failed, retry: () => setAttempt((a) => a + 1) }
}

/** Gives the headings of a drawn chunk the ids the outline jumps to (kept if the markup is redrawn, e.g. when maths loads). */
function useHeadingIds(box: React.RefObject<HTMLElement | null>, prefix: string, entries: Heading[], on: boolean) {
  useEffect(() => {
    const el = box.current
    if (!el || !on) return
    const assign = () => {
      const dom = Array.from(el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
      let at = 0
      for (const h of entries) {
        while (at < dom.length && dom[at]?.tagName !== `H${h.level}`) at++
        const node = dom[at++]
        if (!node) return
        node.id = `${prefix}-${h.index}`
        node.tabIndex = -1
      }
    }
    assign()
    const mo = new MutationObserver(assign)
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [box, prefix, entries, on])
}

function ChunkView({
  chunk,
  n,
  mode,
  images,
  prefix,
  entries,
}: {
  chunk: Chunk
  n: number
  mode: Mode
  images: MdImages
  prefix: string
  entries: Heading[]
}) {
  const box = useRef<HTMLDivElement>(null)
  useHeadingIds(box, prefix, entries, mode === 'rendered')
  return (
    <div ref={box} data-chunk={n}>
      {mode === 'source' ? (
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm" data-testid="md-source">
          {chunk.text}
        </pre>
      ) : (
        <Markdown text={chunk.text} images={images} />
      )}
    </div>
  )
}

const seg =
  'min-h-11 px-3 text-sm text-text-2 hover:text-text focus-visible:outline-2 focus-visible:outline-focus aria-pressed:bg-surface-2 aria-pressed:font-semibold aria-pressed:text-text'

/** The document: toolbar (Rendered / Source, Contents), the outline, and the text. `tall` fills its parent; otherwise it is a short scroll box. */
export function MarkdownDoc({
  att,
  text,
  images,
  tall,
}: {
  att: AttachmentRefT
  text: string
  images: MdImages
  tall?: boolean
}) {
  const { chunks, headings } = useMemo(() => splitDoc(text), [text])
  const prefix = useId().replace(/:/g, '')
  const [mode, setMode] = useState<Mode>('rendered')
  const [shown, setShown] = useState(1)
  const [toc, setToc] = useState(false)
  const [pending, setPending] = useState<number | null>(null)
  const region = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const large = text.length > LARGE_BYTES
  const more = shown < chunks.length
  const byChunk = useMemo(() => chunks.map((_, i) => headings.filter((h) => h.chunk === i)), [chunks, headings])

  // The next part is drawn when the end of the drawn text comes into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` re-observes, so a sentinel still in view draws the next part
  useEffect(() => {
    const s = sentinel.current
    if (!more || !s || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (e) => {
        if (e.some((x) => x.isIntersecting)) setShown((n) => Math.min(n + 1, chunks.length))
      },
      { root: region.current, rootMargin: '600px 0px' },
    )
    io.observe(s)
    return () => io.disconnect()
  }, [more, shown, chunks.length])

  const goto = useCallback((h: Heading) => {
    setMode('rendered')
    setShown((n) => Math.max(n, h.chunk + 1))
    setPending(h.index)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the chunk holding the heading is drawn
  useEffect(() => {
    if (pending === null) return
    const el = region.current
    const target =
      el?.querySelector<HTMLElement>(`#${prefix}-${pending}`) ??
      el?.querySelector<HTMLElement>(`[data-chunk="${headings[pending]?.chunk}"]`)
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
    setPending(null)
  }, [pending, shown, mode, prefix, headings])

  return (
    <div className={cn('flex min-h-0 flex-col', tall && 'flex-1')}>
      <div className="flex flex-wrap items-center gap-x-2 border-b border-line bg-surface-2 px-2">
        <fieldset aria-label={MD_TEXT.viewAria} className="m-0 flex min-w-0 border-0 p-0">
          <button type="button" aria-pressed={mode === 'rendered'} onClick={() => setMode('rendered')} className={seg}>
            {MD_TEXT.rendered}
          </button>
          <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')} className={seg}>
            {MD_TEXT.source}
          </button>
        </fieldset>
        {headings.length >= 3 && (
          <button
            type="button"
            aria-expanded={toc}
            aria-controls={`${prefix}-toc`}
            onClick={() => setToc((v) => !v)}
            className={cn(seg, 'ml-auto')}
          >
            {MD_TEXT.contents}
          </button>
        )}
      </div>
      {toc && (
        <nav
          id={`${prefix}-toc`}
          aria-label={MD_TEXT.contentsAria(att.name)}
          className="max-h-48 overflow-auto border-b border-line bg-surface px-2 py-1"
        >
          <ul className="m-0 list-none p-0">
            {headings.map((h) => (
              <li key={h.index} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                <button
                  type="button"
                  onClick={() => goto(h)}
                  className="min-h-11 w-full truncate text-left text-sm text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {h.text || '—'}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {large && (
        <p className="m-0 border-b border-line px-3 py-1 text-xs text-text-2" data-testid="md-large-note">
          {MD_TEXT.largeNote(chunks.length)}
        </p>
      )}
      <section
        ref={region}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box the keyboard can reach and scroll
        tabIndex={0}
        aria-label={mode === 'source' ? MD_TEXT.sourceRegion(att.name) : MD_TEXT.region(att.name)}
        data-testid="md-region"
        className={cn('min-h-0 overflow-auto bg-surface p-3 text-text', tall ? 'flex-1' : 'max-h-80')}
      >
        {chunks.slice(0, shown).map((c, i) => (
          <ChunkView
            // biome-ignore lint/suspicious/noArrayIndexKey: chunks are positional and never reordered
            key={i}
            chunk={c}
            n={i}
            mode={mode}
            images={images}
            prefix={prefix}
            entries={byChunk[i] ?? []}
          />
        ))}
        {more && (
          <div ref={sentinel} className="flex flex-wrap items-center gap-2 py-2" data-testid="md-more">
            <button
              type="button"
              onClick={() => setShown((n) => n + 1)}
              className="min-h-11 rounded-pill border border-line px-3 text-sm text-text-2 hover:text-text"
            >
              {MD_TEXT.loadMore(shown, chunks.length)}
            </button>
            <button
              type="button"
              onClick={() => setShown(chunks.length)}
              className="min-h-11 rounded-pill px-3 text-sm text-text-2 underline hover:text-text"
            >
              {MD_TEXT.showAll}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function MarkdownFullscreen({
  att,
  text,
  images,
  onClose,
}: {
  att: AttachmentRefT
  text: string
  images: MdImages
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  // The whole dialog is the Tab ring (not just the bar): the document has controls of its own.
  const onKeyDown = useFrameOverlay({ active: true, onClose, boxRef: box, barRef: box, closeRef: closeBtn })
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={att.name}
      onKeyDown={onKeyDown}
      className={OVERLAY_BOX_CLASS}
    >
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1 font-mono text-xs text-text-2">
        <span className="min-w-0 flex-1 truncate">{att.name}</span>
        <button
          ref={closeBtn}
          type="button"
          aria-label={MD_TEXT.closeLabel}
          title={MD_TEXT.close}
          onClick={onClose}
          className="grid size-11 shrink-0 place-items-center rounded-pill text-text hover:bg-surface"
        >
          <IconClose width={22} height={22} />
        </button>
      </div>
      <MarkdownDoc att={att} text={text} images={images} tall />
    </div>
  )
}

export function MarkdownFileCard({
  att,
  siblings = [],
}: {
  att: AttachmentRefT
  siblings?: readonly AttachmentRefT[]
}) {
  const { state, retry, load, url } = useMediaGate(att, mediaUrl(att.media_id))
  const doc = useDocText(url, state === 'ready')
  const [open, setOpen] = useState(false)
  const expandRef = useRef<HTMLButtonElement>(null)
  const images = useMemo(() => siblingImages(att, siblings), [att, siblings])
  const close = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(() => expandRef.current?.focus())
  }, [])
  const ready = state === 'ready' && doc.text !== null
  return (
    <figure className="m-0 overflow-hidden rounded-card border border-line" data-testid="md-card">
      <figcaption className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 py-1 pl-3 pr-1 font-mono text-xs text-text-2">
        <span className="min-w-0 truncate">{att.name}</span>
        <button
          ref={expandRef}
          type="button"
          aria-label={MD_TEXT.expand(att.name)}
          onClick={() => setOpen(true)}
          disabled={!ready}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill px-2 text-text-2 hover:text-text disabled:opacity-50"
        >
          <IconExpand width={16} height={16} />
          <span>{MD_TEXT.expandLabel}</span>
        </button>
      </figcaption>
      {ready ? (
        <MarkdownDoc att={att} text={doc.text as string} images={images} />
      ) : (
        <div className="grid h-40 place-items-center bg-surface p-4 text-sm text-text-2">
          {state === 'failed' || state === 'fetching' || state === 'gone' ? (
            <MediaStatus state={state} what={att.name} onRetry={retry} onLoad={load} />
          ) : doc.failed ? (
            <span role="alert" className="flex flex-wrap items-center gap-x-3">
              <span>{MD_TEXT.failed(att.name)}</span>
              <button type="button" onClick={doc.retry} className="min-h-11 text-accent-text underline">
                {MD_TEXT.retry}
              </button>
            </span>
          ) : (
            <span role="status">{MD_TEXT.loading(att.name)}</span>
          )}
        </div>
      )}
      {open && ready && <MarkdownFullscreen att={att} text={doc.text as string} images={images} onClose={close} />}
    </figure>
  )
}
