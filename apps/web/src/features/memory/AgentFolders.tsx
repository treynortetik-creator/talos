// Memory -> Agent folders: each thread's folder on the Mac, to look through and add files to (files.list / files.read /
// files.put). This was the Files sheet; Files now lists the files sent in Talos (features/files/SentFiles.tsx). Where you are
// is in the URL (?af=<thread id>), so Back works.
import { FILES_FEATURE } from '@talos-app/protocol'
import { useTalos } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { FilesPane } from '../files/FilesPane.tsx'
import { shortRoot, useFilesBrowser } from '../files/useFilesBrowser.ts'
import { useMediaQuery } from '../settings/useMedia.ts'

export const AGENT_FOLDERS_TEXT = {
  title: 'Agent folders',
  hint: "Each thread's folder on your Mac: look through it and add files.",
  folder: (thread: string) => `${thread} folder`,
} as const

const row =
  'flex min-h-11 w-full items-center gap-3 border-b border-line/60 px-4 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus'

/** The threads whose folder can be opened; nothing on a Mac that does not list folders. */
export function AgentFolderList({ onOpen }: { onOpen: (threadId: string) => void }) {
  const on = useFeature(FILES_FEATURE) !== 'off'
  const all = useTalos((s) => s.threads) // filtered here: a selector that builds a new array re-renders forever
  const threads = all.filter((t) => !t.archived)
  if (!on || threads.length === 0) return null
  return (
    <section aria-labelledby="agent-folders-h" className="pt-2" data-testid="agent-folders">
      <h2 id="agent-folders-h" className="m-0 px-4 pt-3 text-base font-medium">
        {AGENT_FOLDERS_TEXT.title}
      </h2>
      <p className="m-0 px-4 pb-1 text-sm text-text-2">{AGENT_FOLDERS_TEXT.hint}</p>
      <ul className="m-0 list-none p-0">
        {threads.map((t) => (
          <li key={t.id}>
            <button type="button" className={row} onClick={() => onOpen(t.id)} data-testid={`agent-folder-${t.id}`}>
              <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={20} />
              <span className="min-w-0 flex-1 truncate">{AGENT_FOLDERS_TEXT.folder(t.name)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** One thread's folder: the tree and a file beside it on a wide screen, one at a time on a phone. */
export function AgentFolder({ threadId }: { threadId: string }) {
  const b = useFilesBrowser(threadId)
  const wide = useMediaQuery('(min-width: 768px)')
  const name = useTalos((s) => s.threads.find((t) => t.id === threadId)?.name ?? threadId)
  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-2 p-2" data-testid="agent-folder">
      <p className="m-0 px-2 text-sm text-text-2">
        <span className="font-medium text-text">{AGENT_FOLDERS_TEXT.folder(name)}</span>
        {' · '}
        {b.subtitle}
        {b.root ? <span title={b.root}> · {shortRoot(b.root)}</span> : null}
      </p>
      <FilesPane b={b} layout={wide ? 'pane' : 'sheet'} />
    </div>
  )
}
