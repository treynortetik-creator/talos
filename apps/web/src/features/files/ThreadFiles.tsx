// `/files`: Thread files. Each thread's folder on the Mac, to look through and add files to (files.list / files.read /
// files.put, FilesPane + FilesUpload). It sat under Memory until Memory became the Nyx setup screen (2026-11-27). Which
// thread is open is in the URL (`?t=<thread id>`), so Back works; old `/memory?af=<id>` links are sent here.
import { useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { IconBack } from '../../ui/icons.tsx'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { FilesPane } from './FilesPane.tsx'
import { THREAD_FILES_TITLE, threadFilesPath, useFeaturesKnown, useThreadFilesOn } from './threadFilesLink.ts'
import { shortRoot, useFilesBrowser } from './useFilesBrowser.ts'

export const THREAD_FILES_TEXT = {
  title: THREAD_FILES_TITLE,
  hint: "Each thread's folder on your Mac: look through it and add files.",
  folder: (thread: string) => `${thread} folder`,
  off: 'Your Mac does not share thread folders. Update Talos on your Mac to look through them here.',
  none: 'No threads yet.',
  back: 'All thread files',
  loading: 'Loading…',
} as const

const row =
  'flex min-h-11 w-full items-center gap-3 border-b border-line/60 px-4 py-2 text-left text-text no-underline hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus'

export function ThreadFilesScreen() {
  const [sp] = useSearchParams()
  const on = useThreadFilesOn()
  const known = useFeaturesKnown()
  const t = sp.get('t')
  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="thread-files">
      <header className="border-b border-line/60 p-4">
        <h1 className="m-0 font-display text-2xl font-semibold">{THREAD_FILES_TEXT.title}</h1>
      </header>
      {!on && !known ? (
        <p role="status" className="m-0 px-4 pt-2 text-sm text-text-2" data-testid="thread-files-loading">
          {THREAD_FILES_TEXT.loading}
        </p>
      ) : !on ? (
        <p className="m-0 px-4 pt-2 text-sm text-text-2" data-testid="thread-files-off">
          {THREAD_FILES_TEXT.off}
        </p>
      ) : t ? (
        <>
          {/* replace: the browser's Back after this goes where the list was opened from, not into the folder again */}
          <Link
            to="/files"
            replace
            className="mx-2 mt-1 inline-flex min-h-11 items-center gap-1 self-start rounded-button px-2 text-sm text-accent-text"
          >
            <IconBack width={18} height={18} aria-hidden="true" />
            {THREAD_FILES_TEXT.back}
          </Link>
          <ThreadFolder key={t} threadId={t} />
        </>
      ) : (
        <ThreadFolderList />
      )}
    </section>
  )
}

/** The threads whose folder can be opened. */
function ThreadFolderList() {
  const all = useTalos((s) => s.threads) // filtered here: a selector that builds a new array re-renders forever
  const threads = all.filter((x) => !x.archived)
  return (
    <section aria-label={THREAD_FILES_TEXT.title} className="pt-1">
      <p className="m-0 px-4 pb-2 text-sm text-text-2">{THREAD_FILES_TEXT.hint}</p>
      {threads.length === 0 ? (
        <p className="m-0 px-4 text-sm text-text-2">{THREAD_FILES_TEXT.none}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {threads.map((x) => (
            <li key={x.id}>
              <Link to={threadFilesPath(x.id)} className={row} data-testid={`thread-folder-${x.id}`}>
                <ThreadIcon id={x.id} icon={x.icon} color={x.color} size={20} />
                <span className="min-w-0 flex-1 truncate">{THREAD_FILES_TEXT.folder(x.name)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** One thread's folder: the tree and a file beside it on a wide screen, one at a time on a phone. */
function ThreadFolder({ threadId }: { threadId: string }) {
  const b = useFilesBrowser(threadId)
  const wide = useMediaQuery('(min-width: 768px)')
  const name = useTalos((s) => s.threads.find((x) => x.id === threadId)?.name ?? threadId)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <div className="flex min-h-[24rem] flex-1 flex-col gap-2 p-2" data-testid="thread-folder">
      {/* the folder's name is its heading, and takes focus when it opens: the row that was pressed is gone */}
      <h2 ref={heading} tabIndex={-1} className="m-0 px-2 text-base font-medium outline-none">
        {THREAD_FILES_TEXT.folder(name)}
      </h2>
      <p className="m-0 px-2 text-sm text-text-2">
        {b.subtitle}
        {b.root ? <span title={b.root}> · {shortRoot(b.root)}</span> : null}
      </p>
      <FilesPane b={b} layout={wide ? 'pane' : 'sheet'} />
    </div>
  )
}
