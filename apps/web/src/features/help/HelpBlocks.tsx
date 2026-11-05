// Renders the blocks of `content.ts`. Only plain structure: lists, headings, details. Nothing here holds any words of its own.
import { Fragment, type ReactNode } from 'react'
import {
  type Block,
  blockText,
  type Fix,
  type Key,
  PLACE_NAME,
  type QA,
  rowText,
  stripMarkers,
  type Where,
} from './content.ts'

/** Turns [[Name]] and ((Path → Of → Labels)) into bold and {{command}} into code. */
export function Marked({ text }: { text: string }) {
  const parts = text.split(/(\[\[.+?\]\]|\{\{.+?\}\}|\(\(.+?\)\))/g)
  return (
    <>
      {parts.map((part, i) => {
        const key = `${i}-${part}`
        if (part.startsWith('[[') || part.startsWith('((')) return <strong key={key}>{part.slice(2, -2)}</strong>
        if (part.startsWith('{{'))
          return (
            <code
              key={key}
              className="rounded-button bg-surface-2 px-1 font-mono text-[0.9em] [overflow-wrap:anywhere]"
            >
              {part.slice(2, -2)}
            </code>
          )
        return <Fragment key={key}>{part}</Fragment>
      })}
    </>
  )
}

/** Every word must appear somewhere in the text. An empty search keeps everything. */
export function matches(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}

function WhereLine({ w }: { w: Where }) {
  return (
    <li className="m-0">
      <span className="text-text-2">{PLACE_NAME[w.place]}</span>
      {w.path.map((p) => (
        <Fragment key={p}>
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> then </span>
          {w.place === 'terminal' ? <code className="font-mono text-[0.9em]">{p}</code> : <strong>{p}</strong>}
        </Fragment>
      ))}
    </li>
  )
}

function WhereRow({ row }: { row: QA }) {
  return (
    <li className="m-0 flex flex-col gap-1 py-3" data-testid="help-where-row">
      <span className="font-medium">{row.q}</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
        {row.where.map((w) => (
          <WhereLine key={`${w.place}/${w.path.join('/')}`} w={w} />
        ))}
      </ul>
      {row.note && (
        <span className="text-sm text-text-2">
          <Marked text={row.note} />
        </span>
      )}
    </li>
  )
}

function FixRow({ row, forceOpen }: { row: Fix; forceOpen: boolean }) {
  return (
    <details open={forceOpen || undefined} className="py-1" data-testid={`help-fix-${row.id}`}>
      <summary className="flex min-h-11 cursor-pointer items-center font-medium">{row.q}</summary>
      <ol className="m-0 flex list-decimal flex-col gap-2 pb-3 pl-5 text-sm">
        {row.steps.map((s) => (
          <li key={s}>
            <Marked text={s} />
          </li>
        ))}
      </ol>
    </details>
  )
}

function KeyRow({ k }: { k: Key }) {
  return (
    <li className="m-0 flex flex-col gap-0.5 py-2" data-testid="help-key-row">
      <span>
        <kbd className="rounded-button border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-sm">{k.keys}</kbd>{' '}
        <span className="font-medium">{k.what}</span>
      </span>
      <span className="text-sm text-text-2">
        <Marked text={k.when} />
      </span>
    </li>
  )
}

const LIST = 'incised m-0 flex list-none flex-col divide-y divide-line rounded-card bg-surface px-4 py-1'

/**
 * A block cut down to what matches the search, or null when nothing in it does. This is the one place that decides what
 * a search keeps: the count above the results and the rows drawn below both come from it, so they cannot disagree.
 */
export function narrowBlock(block: Block, query: string): Block | null {
  if (query.trim() === '') return block
  switch (block.kind) {
    case 'p':
    case 'steps':
      return matches(blockText(block), query) ? block : null
    case 'where': {
      const rows = block.rows.filter((r) => matches(rowText(r), query))
      return rows.length === 0 ? null : { ...block, rows }
    }
    case 'fix': {
      const rows = block.rows.filter((r) => matches(blockText({ kind: 'fix', rows: [r] }), query))
      return rows.length === 0 ? null : { ...block, rows }
    }
    case 'keys': {
      const groups = block.groups
        .map((g) => ({
          ...g,
          rows: g.rows.filter((r) => matches(`${g.title} ${r.keys} ${r.what} ${stripMarkers(r.when)}`, query)),
        }))
        .filter((g) => g.rows.length > 0)
      return groups.length === 0 ? null : { ...block, groups }
    }
    case 'limits': {
      const rows = block.rows.filter((r) => matches(`${r.q} ${stripMarkers(r.a)}`, query))
      return rows.length === 0 ? null : { ...block, rows }
    }
  }
}

/** Draws a block as it is given (already narrowed by `narrowBlock`). `searching` opens every fix. */
export function BlockView({ block, searching }: { block: Block; searching: boolean }): ReactNode {
  switch (block.kind) {
    case 'p':
      return (
        <p className="m-0">
          <Marked text={block.text} />
        </p>
      )
    case 'steps':
      return (
        <ol className="m-0 flex list-decimal flex-col gap-2 pl-5">
          {block.items.map((s) => (
            <li key={s}>
              <Marked text={s} />
            </li>
          ))}
        </ol>
      )
    case 'where':
      return (
        <ul className={LIST}>
          {block.rows.map((r) => (
            <WhereRow key={r.q} row={r} />
          ))}
        </ul>
      )
    case 'fix':
      return (
        <div className={`${LIST} divide-y`}>
          {block.rows.map((r) => (
            <FixRow key={r.id} row={r} forceOpen={searching} />
          ))}
        </div>
      )
    case 'keys':
      return (
        <>
          {block.groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-1">
              <h3 className="m-0 text-base font-medium">{g.title}</h3>
              <ul className={LIST}>
                {g.rows.map((r) => (
                  <KeyRow key={`${r.keys}/${r.what}`} k={r} />
                ))}
              </ul>
            </div>
          ))}
        </>
      )
    case 'limits':
      return (
        <ul className={LIST}>
          {block.rows.map((r) => (
            <li key={r.q} className="m-0 flex flex-col gap-1 py-3">
              <span className="font-medium">{r.q}</span>
              <span className="text-sm text-text-2">
                <Marked text={r.a} />
              </span>
            </li>
          ))}
        </ul>
      )
  }
}
