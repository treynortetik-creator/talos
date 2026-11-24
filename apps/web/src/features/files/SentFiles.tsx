// The Files sheet's body: the files sent in Talos, by the owner or an agent, across every thread (files.sent). A phone gets
// rows under day headings; a desktop gets a table whose Thread column jumps to the message, with audio playable in the row.
// A file the Mac removed stays listed, greyed, name and date only. The list is asked for each time this mounts.
import type { PageInfoT, SentFileT } from '@talos-app/protocol'
import { useState } from 'react'
import { Link } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { formatDuration, timeLabel } from '../../lib/format.ts'
import { Button, cn, Input } from '../../ui/index.ts'
import { FrameOverlay, SandboxedFrame } from '../../ui/SandboxedFrame.tsx'
import { pageFrameUrl, pageShareLabel } from '../pages/pagesData.ts'
import { audioLineText, useAudioLine } from '../threads/AudioLines.tsx'
import { audioPlayer, useAudio } from '../threads/audioPlayer.ts'
import { useAgentName } from '../threads/useThreads.ts'
import type { LibraryRow } from './libraryLogic.ts'
import {
  clockLabel,
  countLabel,
  DATE_LABEL,
  type DateRange,
  daysLabel,
  filtersOn,
  groupByDay,
  KIND_CHIPS,
  rowKey,
  SENT_TEXT,
  sizeLabel,
  TYPE_CHIPS,
  tileLabel,
} from './sentLogic.ts'
import { isAudio, type OpenState, urlFor, useOpenSent } from './useOpenSent.ts'
import { type SentFiles as SentFilesState, useSentFiles } from './useSentFiles.ts'

const pill =
  'min-h-11 rounded-pill border border-line bg-surface px-3 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

export function SentFiles({ layout }: { layout: 'list' | 'table' }) {
  const s = useSentFiles()
  const o = useOpenSent(s.files)
  const threads = useTalos((st) => st.threads)
  const agent = useAgentName()
  const threadName = (id: string) => threads.find((t) => t.id === id)?.name ?? id
  const from = (f: SentFileT) => (f.author === 'owner' ? 'you' : agent)
  const anyRemoved = s.files.some((f) => f.removed)
  const [openPage, setOpenPage] = useState<PageInfoT | null>(null)
  const rows = s.rows
  const props = { rows, o, from, threadName, onPage: setOpenPage, agent }
  // the Mac is away (or too old) but the relay's pages are here: list them and say why the files are not
  const pagesOnly = s.unavailable !== null && rows.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="sent-files">
      <Filters s={s} threads={threads} agent={agent} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="sent-files-scroll">
        {pagesOnly && (
          <p role="status" className="m-0 px-3 pt-2 text-sm text-text-2" data-testid="sent-files-unavailable">
            {s.unavailable === SENT_TEXT.offline ? SENT_TEXT.filesNeedMac : s.unavailable}
          </p>
        )}
        {s.pagesFailed && (
          <p role="alert" className="m-0 px-3 pt-2 text-sm text-text-2" data-testid="library-pages-failed">
            {SENT_TEXT.pagesFailed}
          </p>
        )}
        {rows.length > 0 ? (
          layout === 'list' ? (
            <List {...props} />
          ) : (
            <Table {...props} />
          )
        ) : s.unavailable ? (
          <p role="status" className="m-0 p-3 text-sm text-text-2" data-testid="sent-files-unavailable">
            {s.unavailable}
          </p>
        ) : s.error ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <p role="alert" className="m-0 text-sm text-text-2">
              {s.error}
            </p>
            <Button variant="outline" onClick={s.retry}>
              {SENT_TEXT.retry}
            </Button>
          </div>
        ) : (
          <p role="status" className="m-0 p-3 text-sm text-text-2">
            {s.loading
              ? SENT_TEXT.loading
              : filtersOn(s.filters)
                ? s.hasMore
                  ? SENT_TEXT.noMatchYet
                  : s.filters.from === 'owner'
                    ? SENT_TEXT.noMatchFromYou
                    : SENT_TEXT.noMatchFromAgent(agent)
                : s.filters.from === 'owner'
                  ? SENT_TEXT.emptyFromYou
                  : SENT_TEXT.emptyFromAgent(agent)}
          </p>
        )}
        {s.error && rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
            <p role="alert" className="m-0 text-sm text-text-2" data-testid="sent-files-more-error">
              {s.error}
            </p>
            {s.files.length === 0 && (
              <Button variant="outline" onClick={s.retry}>
                {SENT_TEXT.retry}
              </Button>
            )}
          </div>
        )}
        {s.more && !s.unavailable && (
          <div className="flex justify-center p-2">
            <Button variant="ghost" onClick={s.more} disabled={s.loading}>
              {s.loading ? SENT_TEXT.loading : SENT_TEXT.more}
            </Button>
          </div>
        )}
        {!s.unavailable && !s.error && !s.loading && rows.length > 0 && !s.hasMore && (
          <div className="flex flex-col gap-1 px-3 py-3 text-xs text-text-2" data-testid="sent-files-end">
            <p className="m-0">{daysLabel(s.days)}</p>
            {anyRemoved && <p className="m-0">{SENT_TEXT.removed}</p>}
            {s.filters.from === 'agent' && <p className="m-0">{SENT_TEXT.widgetsNote}</p>}
          </div>
        )}
      </div>
      {openPage && (
        <FrameOverlay title={openPage.title} onClose={() => setOpenPage(null)}>
          <SandboxedFrame
            title={`${openPage.title} (full screen)`}
            src={pageFrameUrl(openPage.id)}
            className="block min-h-0 w-full flex-1 bg-surface"
          />
        </FrameOverlay>
      )}
    </div>
  )
}

/** The two halves of Files: what the agent sent (where it opens) and what the owner sent. Left and right arrows move between them. */
function Whose({ s, agent }: { s: SentFilesState; agent: string }) {
  const sides = [
    { id: 'agent', label: `From ${agent}` },
    { id: 'owner', label: SENT_TEXT.fromYou },
  ] as const
  return (
    <div
      role="radiogroup"
      aria-label={SENT_TEXT.whose}
      data-testid="sent-files-whose"
      className="grid grid-cols-2 gap-1 rounded-pill bg-surface-2 p-1"
    >
      {sides.map((side, i) => {
        const chosen = s.filters.from === side.id
        return (
          // biome-ignore lint/a11y/useSemanticElements: a two-part switch (as the type chips): native radios would need hidden inputs
          <button
            key={side.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            title={side.label}
            onClick={() => !chosen && s.set({ from: side.id })}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
              e.preventDefault()
              const to = sides[1 - i]
              if (!to) return
              s.set({ from: to.id })
              const group = e.currentTarget.parentElement
              requestAnimationFrame(() =>
                (group?.querySelectorAll('[role="radio"]')[1 - i] as HTMLElement | undefined)?.focus(),
              )
            }}
            className={cn(
              'min-h-11 min-w-0 truncate rounded-pill px-3 text-sm text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              chosen && 'bg-surface font-semibold text-text shadow-sm',
            )}
          >
            {side.label}
          </button>
        )
      })}
    </div>
  )
}

/** One row of chips, one chosen (as the theme picker); the arrow keys move along it. */
function Chips<T extends string>({
  label,
  chips,
  value,
  onPick,
}: {
  label: string
  chips: ReadonlyArray<{ id: T; label: string }>
  value: T
  onPick: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-2 overflow-x-auto pb-0.5">
      {chips.map((c, at) => {
        const chosen = value === c.id
        return (
          // biome-ignore lint/a11y/useSemanticElements: chips, one chosen (as the theme picker): native radios would need hidden inputs
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            onClick={() => !chosen && onPick(c.id)}
            onKeyDown={(e) => {
              const step =
                e.key === 'ArrowRight' || e.key === 'ArrowDown'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                    ? -1
                    : 0
              if (!step) return
              e.preventDefault()
              const i = (at + step + chips.length) % chips.length
              const to = chips[i]
              if (!to) return
              onPick(to.id)
              const group = e.currentTarget.parentElement
              requestAnimationFrame(() =>
                (group?.querySelectorAll('[role="radio"]')[i] as HTMLElement | undefined)?.focus(),
              )
            }}
            className={cn(pill, 'shrink-0', chosen && 'border-accent bg-accent/15 font-semibold')}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

function Filters({
  s,
  threads,
  agent,
}: {
  s: SentFilesState
  threads: Array<{ id: string; name: string; archived?: boolean }>
  agent: string
}) {
  const on = filtersOn({ ...s.filters, name: s.nameInput })
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <Whose s={s} agent={agent} />
      <Input
        type="search"
        placeholder={SENT_TEXT.search}
        aria-label={SENT_TEXT.search}
        value={s.nameInput}
        onChange={(e) => s.setNameInput(e.target.value)}
        data-testid="sent-files-search"
      />
      <Chips label="Kind" chips={KIND_CHIPS} value={s.filters.kind} onPick={(kind) => s.set({ kind, type: 'all' })} />
      {s.filters.kind === 'files' && (
        <Chips label="File type" chips={TYPE_CHIPS} value={s.filters.type} onPick={(type) => s.set({ type })} />
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and legend; this is a toolbar of filters */}
      <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Date"
          className={pill}
          value={s.filters.range}
          onChange={(e) => s.set({ range: e.target.value as DateRange })}
        >
          {(Object.keys(DATE_LABEL) as DateRange[]).map((r) => (
            <option key={r} value={r}>
              {DATE_LABEL[r]}
            </option>
          ))}
        </select>
        <select
          aria-label="Thread"
          className={cn(pill, 'max-w-[11rem]')}
          value={s.filters.threadId}
          onChange={(e) => s.set({ threadId: e.target.value })}
        >
          <option value="">{SENT_TEXT.allThreads}</option>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {on && (
          <>
            <span className="text-sm text-text-2" data-testid="sent-files-count">
              {countLabel(s.rows.length, s.hasMore, s.filters.kind)}
            </span>
            <button type="button" className="min-h-11 px-2 text-sm text-accent" onClick={s.clear}>
              {SENT_TEXT.clear}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

type RowProps = {
  rows: LibraryRow[]
  o: ReturnType<typeof useOpenSent>
  from: (f: SentFileT) => string
  threadName: (id: string) => string
  /** A published page opens full screen in its sandboxed frame. */
  onPage: (p: PageInfoT) => void
  /** Who published the pages (they are all the agent's). */
  agent: string
}

/** A published page's square: says PAGE, like a file's says its type. */
const PageTile = () => (
  <span
    aria-hidden="true"
    className="grid size-11 shrink-0 place-items-center rounded-button border border-accent/40 bg-accent/10 text-[11px] font-semibold tracking-wide text-accent-text"
  >
    PAGE
  </span>
)

function Tile({ f }: { f: SentFileT }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-11 shrink-0 place-items-center rounded-button border border-line bg-surface-2 text-[11px] font-semibold tracking-wide text-text-2"
    >
      {tileLabel(f.file)}
    </span>
  )
}

const stateWords = (st: OpenState | undefined) =>
  st === 'gone'
    ? SENT_TEXT.gone
    : st === 'fetching'
      ? SENT_TEXT.fetching
      : st === 'failed'
        ? SENT_TEXT.openFailed
        : null

/**
 * What a tap on a row does: a link that opens the file (on the tap itself, as the timeline's file links do), the message player for
 * audio (a Play / Pause toggle), "get it from your Mac" for a file the relay no longer has, nothing for a file the Mac removed.
 */
function Opener({
  f,
  o,
  className,
  children,
}: {
  f: SentFileT
  o: ReturnType<typeof useOpenSent>
  className: string
  children: React.ReactNode
}) {
  const st = o.states[rowKey(f)]
  // The row is the only control for audio started here (there is no floating player), so it is a Play / Pause toggle.
  const playing = useAudio((d) => d.item?.key === `${f.message_id}:${f.file.media_id}` && d.playing)
  if (f.removed) return <div className={className}>{children}</div>
  if (st === 'fetching')
    return (
      <button type="button" className={className} disabled aria-busy="true">
        {children}
      </button>
    )
  if (isAudio(f))
    return (
      <button type="button" className={className} onClick={() => (playing ? audioPlayer.pause() : void o.play(f))}>
        <span className="sr-only">{playing ? 'Pause ' : 'Play '}</span>
        {children}
      </button>
    )
  if (st === 'gone' || st === 'failed')
    return (
      <button type="button" className={className} onClick={() => void o.getBack(f)}>
        {children}
      </button>
    )
  return (
    <a href={urlFor(f)} target="_blank" rel="noopener" className={className}>
      {children}
    </a>
  )
}

function List({ rows, o, from, threadName, onPage }: RowProps) {
  const now = Date.now()
  const row = 'flex min-h-14 w-full items-center gap-3 rounded-button px-2 py-1.5 text-left'
  return (
    <div className="flex flex-col">
      {groupByDay(rows, now).map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="m-0 px-2 pt-3 pb-1 text-xs font-semibold text-text-2">{g.label}</h3>
          <ul className="m-0 list-none p-0">
            {g.files.map((r) => {
              if (r.kind === 'page')
                return (
                  <li key={r.key} data-testid="sent-file" data-kind="page">
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      className={cn(row, 'hover:bg-surface-2')}
                      onClick={() => onPage(r.page)}
                    >
                      <PageTile />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{r.page.title}</span>
                        <span className="truncate text-xs text-text-2">
                          {`${SENT_TEXT.page} · ${threadName(r.page.thread_id)} thread · ${pageShareLabel(r.page.share, now)}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-text-2">{clockLabel(r.at)}</span>
                    </button>
                  </li>
                )
              const f = r.f
              const words = stateWords(o.states[rowKey(f)])
              return (
                <li key={r.key} data-testid="sent-file" data-kind="file" data-removed={f.removed || undefined}>
                  <Opener f={f} o={o} className={cn(row, f.removed ? 'opacity-50' : 'hover:bg-surface-2')}>
                    <Tile f={f} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{f.file.name}</span>
                      {!f.removed && (
                        <RowWords
                          f={f}
                          words={words ?? `From ${from(f)} · ${threadName(f.thread_id)} thread · ${sizeLabel(f.file)}`}
                          className="truncate text-xs text-text-2"
                        />
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-text-2">{clockLabel(f.created_at)}</span>
                  </Opener>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Table({ rows, o, from, threadName, onPage, agent }: RowProps) {
  const now = Date.now()
  const th = 'px-2 py-2 text-left text-xs font-semibold text-text-2'
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line">
          <th scope="col" className={th}>
            <span className="sr-only">Type</span>
          </th>
          <th scope="col" className={th}>
            Name
          </th>
          <th scope="col" className={th}>
            Thread
          </th>
          <th scope="col" className={th}>
            From
          </th>
          <th scope="col" className={th}>
            Size
          </th>
          <th scope="col" className={th}>
            Sent
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          if (r.kind === 'page')
            return (
              <tr key={r.key} data-testid="sent-file" data-kind="page" className="border-b border-line/60">
                <td className="px-2 py-1.5 align-middle">
                  <PageTile />
                </td>
                <td className="max-w-[18rem] px-2 py-1.5 align-middle">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => onPage(r.page)}
                    className="flex min-h-11 max-w-full items-center gap-2 truncate text-left font-medium hover:underline"
                  >
                    <span className="truncate">{r.page.title}</span>
                  </button>
                  <span className="block text-xs text-text-2">{pageShareLabel(r.page.share, now)}</span>
                </td>
                <td className="px-2 py-1.5 align-middle">
                  <Link to={`/t/${r.page.thread_id}`} className="text-accent hover:underline">
                    {threadName(r.page.thread_id)}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 align-middle text-text-2">{agent}</td>
                <td className="px-2 py-1.5 align-middle" />
                <td className="whitespace-nowrap px-2 py-1.5 align-middle text-text-2">{timeLabel(r.at, now)}</td>
              </tr>
            )
          const f = r.f
          const st = o.states[rowKey(f)]
          const words = stateWords(st)
          const td = 'px-2 py-1.5 align-middle'
          return (
            <tr
              key={r.key}
              data-testid="sent-file"
              data-kind="file"
              data-removed={f.removed || undefined}
              className={cn('border-b border-line/60', f.removed && 'opacity-50')}
            >
              <td className={td}>
                <Tile f={f} />
              </td>
              <td className={cn(td, 'max-w-[18rem]')}>
                <Opener
                  f={f}
                  o={o}
                  className="flex min-h-11 max-w-full items-center gap-2 truncate text-left font-medium hover:underline"
                >
                  {isAudio(f) && !f.removed && <span aria-hidden="true">▶</span>}
                  <span className="truncate">{f.file.name}</span>
                </Opener>
                <RowWords f={f} words={words} className="block text-xs text-text-2" />
                {!f.removed && isAudio(f) && <Progress f={f} />}
              </td>
              <td className={td}>
                {f.removed ? null : (
                  <Link to={`/t/${f.thread_id}?m=${f.message_id}`} className="text-accent hover:underline">
                    {threadName(f.thread_id)}
                  </Link>
                )}
              </td>
              <td className={cn(td, 'whitespace-nowrap text-text-2')}>{f.removed ? null : from(f)}</td>
              <td className={cn(td, 'whitespace-nowrap text-text-2')}>{f.removed ? null : sizeLabel(f.file)}</td>
              <td className={cn(td, 'whitespace-nowrap text-text-2')}>{timeLabel(f.created_at, now)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** A row's second line: what the player says about this audio row (refused, waiting for data) takes the place of `words`. */
function RowWords({ f, words, className }: { f: SentFileT; words: string | null; className: string }) {
  const line = useAudioLine(`${f.message_id}:${f.file.media_id}`)
  const text = line ? audioLineText(line) : words
  return text ? (
    <span className={className} data-testid={line ? `audio-${line}` : undefined}>
      {text}
    </span>
  ) : null
}

/** An audio row's progress while the player plays it. */
function Progress({ f }: { f: SentFileT }) {
  const key = `${f.message_id}:${f.file.media_id}`
  // plain values only: a selector that builds an object re-renders forever (React #185)
  const mine = useAudio((d) => d.item?.key === key)
  const cur = useAudio((d) => (d.item?.key === key ? d.cur : 0))
  const known = useAudio((d) => (d.item?.key === key ? d.duration : 0))
  const p = mine ? { cur, dur: known || (f.file.duration_ms ?? 0) / 1000 } : null
  if (!p || p.dur <= 0) return null
  return (
    <span className="mt-1 flex items-center gap-2" data-testid="sent-file-progress">
      <span className="h-1 w-32 overflow-hidden rounded-pill bg-line">
        <span className="block h-full bg-accent" style={{ width: `${Math.min(100, (p.cur / p.dur) * 100)}%` }} />
      </span>
      <span className="whitespace-nowrap text-xs text-text-2">
        {formatDuration(p.cur * 1000)} / {formatDuration(p.dur * 1000)}
      </span>
    </span>
  )
}
