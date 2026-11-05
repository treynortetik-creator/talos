import { type MouseEvent, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getMathVersion, renderMarkdown, subscribeMath } from '../../lib/markdown.ts'
import { getPlatform } from '../../lib/platform.ts'
import { type RunContext, useRunSlots } from './RunButton.tsx'

/** Agent and owner markdown. Links leave the app only through `platform.openExternal`. */
export function Markdown({ text, run }: { text: string; run?: RunContext }) {
  // Temml loads the first time a formula appears; the version bump draws the formulas once it is there.
  const math = useSyncExternalStore(subscribeMath, getMathVersion)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `math` is the trigger
  const html = useMemo(() => renderMarkdown(text), [text, math])
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
  }, [html])
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const copy = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]')
    if (copy) {
      const pre = copy.closest('pre')?.cloneNode(true) as HTMLElement | undefined
      pre?.querySelector('[data-copy-code]')?.remove()
      const text = pre?.textContent ?? ''
      const done = (ok: boolean) => {
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
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {runSlots}
    </>
  )
}
