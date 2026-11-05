// One search hit (docs/V2-FEATURES.md V3.3). Memory reuses it. The snippet is plain text and `marks` are offsets, so the
// highlight is built from text nodes only: nothing in a snippet is ever parsed as HTML.
import { Fragment } from 'react'
import type { HitRowProps } from '../contracts.ts'
import { segments } from './logic.ts'

export type HitRowFullProps = HitRowProps & {
  marks?: ReadonlyArray<readonly [number, number]>
  /** Where the match is, e.g. "in message". */
  badge?: string
  /** An attached file's name, shown with a paperclip. */
  file?: string
}

export function HitRow({ title, snippet, onOpen, marks = [], badge, file }: HitRowFullProps) {
  const body = (
    <>
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-text-2">
        <span className="font-semibold">{title}</span>
        {(file || badge) && (
          <span className="shrink-0">
            {file ? <span aria-hidden="true">📎 </span> : null}
            {file ? <span>{file} · </span> : null}
            {badge}
          </span>
        )}
      </span>
      <span className="text-sm text-text [overflow-wrap:anywhere]">
        {segments(snippet, marks).map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered
          <Fragment key={i}>
            {s.mark ? <mark className="rounded-sm bg-accent/25 px-0.5 text-text">{s.text}</mark> : s.text}
          </Fragment>
        ))}
      </span>
    </>
  )
  const cls = 'flex w-full flex-col gap-1 border-b border-line/60 px-4 py-3 text-left'
  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${cls} min-h-11 hover:bg-surface`} data-testid="hit-row">
      {body}
    </button>
  ) : (
    <div className={cls} data-testid="hit-row">
      {body}
    </div>
  )
}
