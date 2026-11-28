import { type MouseEvent, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { announceCopy } from '../../lib/announceCopy.ts'
import { getMathVersion, type MdImages, renderMarkdown, subscribeMath } from '../../lib/markdown.ts'
import { getPlatform } from '../../lib/platform.ts'
import { markdownPieces, renderPieces } from './markdownPieces.ts'
import { type RunContext, useRunSlots } from './RunButton.tsx'

/** Agent and owner markdown. Links leave the app only through `platform.openExternal`. */
export function Markdown({ text, run, images }: { text: string; run?: RunContext; images?: MdImages }) {
  // Temml loads the first time a formula appears; the version bump draws the formulas once it is there.
  const math = useSyncExternalStore(subscribeMath, getMathVersion)
  // A long text is drawn in pieces (markdownPieces.ts); a short one is one piece, drawn whole as it always was.
  const pieces = useMemo(() => markdownPieces(text), [text])
  // What each piece drew, by the piece's exact text. It is dropped when the images or the formula engine change what a piece draws.
  const cache = useRef<{ images: MdImages | undefined; math: number; drawn: Map<string, string> } | null>(null)
  const drawn = useMemo(() => {
    const opts = images ? { images } : undefined
    if (!pieces) return { whole: renderMarkdown(text, opts), parts: null }
    let own = cache.current
    if (!own || own.images !== images || own.math !== math) {
      own = { images, math, drawn: new Map<string, string>() }
      cache.current = own
    }
    return { whole: null, parts: renderPieces(pieces, (t) => renderMarkdown(t, opts), own.drawn) }
  }, [pieces, text, images, math])
  const html = drawn.whole ?? (drawn.parts as string[]).join('')
  const box = useRef<HTMLDivElement>(null)
  // Shell blocks get a Run button when the caller says where the message sits (a thread message, never a note or a caption).
  const runSlots = useRunSlots(box, html, text, run)
  // Every code block gets a Copy button (added after render: the HTML comes from the sanitizer, which keeps no buttons).
  // biome-ignore lint/correctness/useExhaustiveDependencies: html is the trigger
  useEffect(() => {
    for (const pre of Array.from(box.current?.querySelectorAll('pre') ?? [])) {
      if (pre.querySelector('[data-copy-code]')) continue
      pre.style.position = 'relative'
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('data-copy-code', '')
      b.setAttribute('aria-label', 'Copy code')
      b.textContent = 'Copy'
      b.style.cssText =
        'position:absolute;top:4px;right:4px;min-height:32px;min-width:44px;padding:0 8px;font-size:12px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--text-2);cursor:pointer'
      pre.appendChild(b)
    }
    // A wide table scrolls sideways inside itself (app.css); it takes focus so the arrow keys can scroll it too.
    for (const table of Array.from(box.current?.querySelectorAll('table') ?? [])) table.tabIndex = 0
  }, [html])
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const copy = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]')
    if (copy) {
      const pre = copy.closest('pre')?.cloneNode(true) as HTMLElement | undefined
      pre?.querySelector('[data-copy-code]')?.remove()
      const text = pre?.textContent ?? ''
      const done = (ok: boolean) => {
        announceCopy(ok)
        copy.textContent = ok ? 'Copied' : "Couldn't copy"
        setTimeout(() => {
          copy.textContent = 'Copy'
        }, 1500)
      }
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(false),
      )
      return
    }
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (href) getPlatform().openExternal(href)
  }
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated handler; the links inside stay focusable and activatable */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation of a link fires click, which this intercepts */}
      <div
        ref={box}
        className="prose-talos"
        onClick={onClick}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
        // biome-ignore lint/security/noDangerouslySetInnerHtmlWithChildren: the HTML is only set when there are no pieces (no children)
        dangerouslySetInnerHTML={pieces ? undefined : { __html: html }}
      >
        {pieces?.map((piece, i) =>
          piece.source ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a piece keeps its place as the text grows, so its markup is reused
            <div key={i} data-md-chunk="" style={{ display: 'contents' }}>
              <pre className="m-0 whitespace-pre-wrap font-mono text-sm">{piece.text}</pre>
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a piece keeps its place as the text grows, so its markup is reused
              key={i}
              data-md-chunk=""
              style={{ display: 'contents' }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
              dangerouslySetInnerHTML={{ __html: (drawn.parts as string[])[i] as string }}
            />
          ),
        )}
      </div>
      {runSlots}
    </>
  )
}
