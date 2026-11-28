// The Files pane: a look at the thread's folder on the Mac, which can add a file (FilesUpload.tsx) but never change one. A tree (folders open in place; a filter keeps the matches
// in every folder listed so far) and a viewer: Markdown rendered, any other text with line numbers, an image previewed, and
// anything else named for what it is. In the pane column the two sit side by side; in the phone's sheet one shows at a time.
import { type AttachmentRefT, FILES_WORDING } from '@talos-app/protocol'
import { type KeyboardEvent, useRef } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconBack, IconChevron, IconFile } from '../../ui/icons.tsx'
import { searchBoxKeys } from '../../ui/keys.ts'
import { Markdown } from '../threads/Markdown.tsx'
import { useMediaSrc } from '../threads/media.ts'
import { CodeView } from './CodeView.tsx'
import { type FilesUploader, UploadBar, useFilesUpload } from './FilesUpload.tsx'
import { FILES_TEXT, type FilesBrowser, type Row } from './useFilesBrowser.ts'

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)
const sizeText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export function FilesPane({ b, layout }: { b: FilesBrowser; layout: 'pane' | 'sheet' }) {
  const showViewer = layout === 'pane' || b.viewing !== null
  const showTree = layout === 'pane' || b.viewing === null
  const u = useFilesUpload(b)
  return (
    <div className={cn('flex min-h-0 flex-1', layout === 'pane' ? 'flex-row' : 'flex-col')}>
      {showTree && (
        <div
          className={cn(
            'flex min-h-0 flex-col gap-1.5',
            layout === 'pane' ? 'w-[13rem] shrink-0 border-r border-line p-2' : 'flex-1 px-1 pb-2',
          )}
        >
          <input
            type="search"
            aria-label={FILES_TEXT.filter}
            placeholder="Filter"
            value={b.filter}
            onChange={(e) => b.setFilter(e.target.value)}
            onKeyDown={searchBoxKeys({ value: b.filter, onClear: () => b.setFilter('') })}
            className={cn(
              'w-full rounded-button border border-line bg-bg px-2.5 text-sm text-text placeholder:text-text-3 focus-visible:outline-2 focus-visible:outline-focus',
              layout === 'pane' ? 'h-8' : 'h-11',
            )}
          />
          <UploadBar u={u} layout={layout} />
          <Tree b={b} layout={layout} u={u} />
        </div>
      )}
      {showViewer && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {layout === 'sheet' && (
            <button
              type="button"
              onClick={b.clearView}
              className="mb-1 inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill px-2 text-sm text-text-2 hover:bg-surface-2"
            >
              <IconBack width={18} height={18} />
              {FILES_TEXT.back}
            </button>
          )}
          <Viewer b={b} />
        </div>
      )}
    </div>
  )
}

function Tree({ b, layout, u }: { b: FilesBrowser; layout: 'pane' | 'sheet'; u: FilesUploader }) {
  const list = useRef<HTMLDivElement>(null)
  const st = b.rootState
  if (!st || st.state === 'loading') return <p className="m-0 p-2 text-sm text-text-2">{FILES_TEXT.loading}</p>
  if (st.state === 'error')
    return (
      <div className="flex flex-col items-start gap-2 p-2 text-sm text-text-2">
        <p className="m-0">{st.message}</p>
        <button
          type="button"
          onClick={b.retry}
          className="min-h-11 rounded-pill border border-line px-3 text-sm font-medium text-text hover:bg-surface-2"
        >
          {FILES_TEXT.retry}
        </button>
      </div>
    )
  const rows = b.rows
  const selected = b.viewing?.path
  // one row is in the tab order (the one on view, else the first); arrows move between rows, Right/Left open and close
  const tabRow = rows.find((r) => r.path === selected)?.path ?? rows[0]?.path
  const onKey = (e: KeyboardEvent<HTMLDivElement>, r: Row, i: number) => {
    const focus = (j: number) => list.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[j]?.focus()
    const opened = b.filter.trim() !== '' || b.open.has(r.path)
    if (e.key === 'ArrowDown') focus(Math.min(rows.length - 1, i + 1))
    else if (e.key === 'ArrowUp') focus(Math.max(0, i - 1))
    else if (e.key === 'Home') focus(0)
    else if (e.key === 'End') focus(rows.length - 1)
    else if (e.key === 'ArrowRight' && r.kind === 'dir' && !opened) b.toggle(r.path)
    else if (e.key === 'ArrowLeft' && r.kind === 'dir' && opened && b.filter.trim() === '') b.toggle(r.path)
    else if (e.key === 'Enter' || e.key === ' ') activate(r)
    else return
    e.preventDefault()
  }
  const activate = (r: Row) => (r.kind === 'dir' ? b.toggle(r.path) : void b.view(r.path))
  const more = st.listing.more
  return (
    // a drop anywhere in the tree but on a folder row puts the file in the thread's folder
    <div
      {...u.dropOn('')}
      data-testid="files-drop"
      className={cn('min-h-0 flex-1 overflow-y-auto rounded-button', u.over === '' && 'outline-2 outline-focus')}
    >
      {rows.length === 0 ? (
        <p className="m-0 p-2 text-sm text-text-2">{b.filter.trim() ? FILES_TEXT.noMatch : FILES_TEXT.empty}</p>
      ) : (
        <div ref={list} role="tree" aria-label={FILES_TEXT.title}>
          {rows.map((r, i) => {
            const opened = r.kind === 'dir' && (b.filter.trim() !== '' || b.open.has(r.path))
            const dir = b.dirs[r.path]
            return (
              <div
                key={r.path}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-selected={r.path === selected}
                {...(r.kind === 'dir' ? { 'aria-expanded': opened } : {})}
                tabIndex={r.path === tabRow ? 0 : -1}
                onClick={() => activate(r)}
                onKeyDown={(e) => onKey(e, r, i)}
                {...u.dropOn(
                  r.kind === 'dir' ? r.path : r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '',
                )}
                style={{ paddingLeft: `${0.375 + r.depth * 0.875}rem` }}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-button pr-1.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-focus',
                  layout === 'pane' ? 'min-h-8' : 'min-h-11 border-b border-line last:border-b-0',
                  r.path === selected ? 'bg-surface-2 font-medium' : 'hover:bg-surface-2',
                  r.kind === 'dir' && u.over === r.path && 'outline-2 outline-focus',
                )}
              >
                {r.kind === 'dir' ? (
                  <IconChevron
                    width={14}
                    height={14}
                    aria-hidden="true"
                    className={cn('shrink-0 text-text-3 transition-transform', opened && 'rotate-90')}
                  />
                ) : (
                  <IconFile width={14} height={14} aria-hidden="true" className="shrink-0 text-text-3" />
                )}
                <span className="min-w-0 truncate" title={r.name}>
                  {r.name}
                </span>
                {r.kind === 'dir' && dir?.state === 'loading' && (
                  <span className="ml-auto text-xs text-text-3">{FILES_TEXT.loading}</span>
                )}
                {r.kind === 'dir' && dir?.state === 'error' && opened && (
                  <span className="ml-auto truncate text-xs text-danger" title={dir.message}>
                    {dir.message}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {more > 0 && <p className="m-0 px-2 py-1 text-xs text-text-3">{FILES_TEXT.moreCount(more)}</p>}
      {st.listing.partial && <p className="m-0 px-2 py-1 text-xs text-text-3">{FILES_WORDING.partial}</p>}
    </div>
  )
}

function Viewer({ b }: { b: FilesBrowser }) {
  const v = b.viewing
  return (
    <div data-testid="files-viewer" className="min-h-0 flex-1 overflow-auto p-3 text-sm">
      {v === null ? (
        <p className="m-0 text-text-2">{FILES_TEXT.pick}</p>
      ) : v.state === 'loading' ? (
        <p className="m-0 text-text-2">{FILES_TEXT.loading}</p>
      ) : v.state === 'error' ? (
        <div className="flex flex-col items-start gap-2 text-text-2">
          <p className="m-0">{v.message}</p>
          <button
            type="button"
            onClick={() => void b.view(v.path)}
            className="min-h-11 rounded-pill border border-line px-3 text-sm font-medium text-text hover:bg-surface-2"
          >
            {FILES_TEXT.retry}
          </button>
        </div>
      ) : (
        <>
          <p className="m-0 mb-2 truncate text-xs text-text-3" title={v.path}>
            {v.path} · {sizeText(v.file.size)}
          </p>
          {v.file.kind === 'text' ? (
            isMarkdown(v.path) ? (
              <div className="max-w-[72ch]">
                <Markdown text={v.text} />
              </div>
            ) : (
              <CodeView text={v.text} />
            )
          ) : v.file.kind === 'image' && v.file.media ? (
            <ImagePreview att={v.file.media} />
          ) : (
            <p className="m-0 text-text-2">{v.file.message ?? FILES_TEXT.pick}</p>
          )}
          {v.file.nextOffset !== null && (
            <button
              type="button"
              disabled={v.loadingMore}
              onClick={() => void b.more()}
              className="mt-2 min-h-11 rounded-pill border border-line px-3 text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-60"
            >
              {v.loadingMore ? FILES_TEXT.loading : FILES_TEXT.more}
            </button>
          )}
          {v.file.truncated && v.file.nextOffset === null && (
            <p className="m-0 mt-2 text-xs text-text-3">{FILES_TEXT.truncated}</p>
          )}
        </>
      )}
    </div>
  )
}

function ImagePreview({ att }: { att: AttachmentRefT }) {
  const { src, onError } = useMediaSrc(att)
  return (
    <img src={src} alt={att.name ?? 'image'} onError={onError} className="max-h-[70vh] max-w-full rounded-button" />
  )
}
