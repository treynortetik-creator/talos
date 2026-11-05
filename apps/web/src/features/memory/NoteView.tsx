// One note (docs/V2-FEATURES.md V5.3): path, age, [Ask {agent}], frontmatter as a small table, markdown through
// lib/markdown.ts (raw HTML is text, `.html` is shown as source), resolved links navigate and null links are grey. A long
// note loads its next chunk when the end scrolls into view.
import type { MemoryLinkT } from '@talos-app/protocol'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { relativeTime } from '../../lib/format.ts'
import { getPlatform } from '../../lib/platform.ts'
import { Button } from '../../ui/index.ts'
import { AskSheet } from './AskSheet.tsx'
import { baseName, errorWords, frontmatterParts, linkPlan, renderNote, splitFrontmatter } from './logic.ts'

type Loaded = {
  text: string
  mime: string
  mtime: string
  sha256: string
  size: number
  nextOffset: number | null
  links: MemoryLinkT[]
}

export function NoteView({
  rootId,
  path,
  agent,
  onOpen,
}: {
  rootId: string
  path: string
  agent: string
  onOpen: (rootId: string, path: string) => void
}) {
  const mem = useTalosClient().memory
  const [note, setNote] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [changed, setChanged] = useState(false)
  const [ask, setAsk] = useState(false)
  const gen = useRef(0)
  const sentinel = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    if (!mem) return
    const g = ++gen.current
    setNote(null)
    setError(null)
    setChanged(false)
    try {
      const r = await mem.read(rootId, path, 0)
      if (g !== gen.current) return
      setNote({
        text: r.text,
        mime: r.mime,
        mtime: r.mtime,
        sha256: r.sha256,
        size: r.size,
        nextOffset: r.nextOffset,
        links: r.links ?? [],
      })
    } catch (e) {
      if (g === gen.current) setError(errorWords(e instanceof TalosClientError ? e.code : undefined))
    }
  }, [mem, rootId, path])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = useCallback(async () => {
    if (!mem || !note || note.nextOffset === null || more) return
    setMore(true)
    const g = gen.current
    try {
      const r = await mem.read(rootId, path, note.nextOffset)
      if (g !== gen.current) return
      if (r.sha256 !== note.sha256) setChanged(true)
      else setNote((n) => (n ? { ...n, text: n.text + r.text, nextOffset: r.nextOffset } : n))
    } catch (e) {
      if (g === gen.current) setError(errorWords(e instanceof TalosClientError ? e.code : undefined))
    } finally {
      setMore(false)
    }
  }, [mem, note, more, rootId, path])

  useEffect(() => {
    const el = sentinel.current
    if (!el || note?.nextOffset == null || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [note?.nextOffset, loadMore])

  const isMarkdown = note?.mime === 'text/markdown'
  // one plan for the whole note: the properties first (they come first in the file), then the body
  const { rows, parts, html, body } = useMemo(() => {
    if (!note || !isMarkdown)
      return {
        rows: [] as Array<[string, string]>,
        parts: [] as ReturnType<typeof frontmatterParts>[],
        html: '',
        body: note?.text ?? '',
      }
    const sp = splitFrontmatter(note.text)
    const plan = linkPlan(note.text, note.links, path, note.nextOffset === null)
    const parts = sp.rows.map(([, v]) => frontmatterParts(v, plan))
    return { rows: sp.rows, parts, html: renderNote(sp.body, note.links, plan), body: sp.body }
  }, [note, isMarkdown, path])

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const idx = a.getAttribute('data-mem-link')
    if (idx !== null) {
      const l = note?.links[Number(idx)]
      if (l?.root_id && l.path) onOpen(l.root_id, l.path)
      return
    }
    const href = a.getAttribute('href')
    if (href) getPlatform().openExternal(href)
  }

  if (error)
    return (
      <p role="status" className="m-0 p-4 text-text-2" data-testid="memory-error">
        {error}
      </p>
    )
  if (!note)
    return (
      <p role="status" className="m-0 p-4 text-text-2">
        Loading…
      </p>
    )
  return (
    <article className="flex min-w-0 flex-col gap-3 p-4" data-testid="memory-note">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 break-all text-sm text-text-2" data-testid="memory-note-path">
            {path} · edited {relativeTime(note.mtime)} ago
          </p>
        </div>
        <Button variant="outline" onClick={() => setAsk(true)} data-testid="memory-ask">
          Ask {agent}
        </Button>
      </header>
      {rows.length > 0 && (
        <table className="w-full table-fixed border-collapse text-sm" data-testid="memory-frontmatter">
          <caption className="sr-only">Note properties</caption>
          <tbody>
            {rows.map(([k, v], r) => (
              <tr key={k} className="border-b border-line/60">
                <th scope="row" className="w-1/3 py-1 pr-3 text-left font-medium text-text-2">
                  {k}
                </th>
                <td className="break-words py-1">
                  {(parts[r] ?? [{ text: v }]).map((p, n) => {
                    const l = p.link && p.link.index >= 0 ? note?.links[p.link.index] : undefined
                    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one value never reorder
                    const key = n
                    if (!p.link) return <span key={key}>{p.text}</span>
                    if (l?.root_id && l.path) {
                      const [rid, lp] = [l.root_id, l.path]
                      return (
                        <button
                          key={key}
                          type="button"
                          className="m-0 min-h-11 cursor-pointer border-0 bg-transparent p-0 text-left text-accent-text underline underline-offset-2"
                          data-testid="memory-front-link"
                          onClick={() => onOpen(rid, lp)}
                        >
                          {p.text}
                        </button>
                      )
                    }
                    return (
                      <span key={key} className="text-text-2" data-testid="memory-link-null">
                        {p.text}
                      </span>
                    )
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isMarkdown ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: delegated handler; the links inside stay focusable and activatable
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation of a link fires click, which this intercepts
        <div
          className="prose-talos"
          data-testid="memory-body"
          onClick={onClick}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown; the link slots are ours
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        // plain text and .html are shown as source, never rendered
        <pre
          className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm"
          data-testid="memory-body"
        >
          {body}
        </pre>
      )}
      {changed && (
        <p role="status" className="m-0 text-sm text-text-2" data-testid="memory-changed">
          This note changed while you were reading it.{' '}
          <button type="button" className="min-h-11 font-semibold text-accent" onClick={() => void load()}>
            Reload
          </button>
        </p>
      )}
      {note.nextOffset === null && note.size > new TextEncoder().encode(note.text).length && (
        <p role="status" className="m-0 text-sm text-text-2" data-testid="memory-truncated">
          Only the start of this note is shown. It is longer than your Mac shares.
        </p>
      )}
      {note.nextOffset !== null && !changed && (
        <div ref={sentinel} className="flex justify-center">
          <Button variant="ghost" onClick={() => void loadMore()} disabled={more} data-testid="memory-load-more">
            {more ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      <AskSheet
        open={ask}
        onOpenChange={setAsk}
        agent={agent}
        title={baseName(path)}
        refInfo={{ rootId, path, sha256: note.sha256 }}
      />
    </article>
  )
}
