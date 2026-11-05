// Entry points to the thread settings sheet (manage/ThreadEditor.tsx): the "..." in a thread's header, and "New thread".
import type { ThreadT } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { cn } from '../../ui/cn.ts'
import { IconMore, IconPlus, IconSearch } from '../../ui/icons.tsx'
import { ThreadEditor } from './manage/ThreadEditor.tsx'

export function ThreadSettings({ thread }: { thread: ThreadT }) {
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  // Settings -> Notifications links to /t/<id>?settings=1: open this thread's settings once, then drop the flag so a
  // refresh or Back does not reopen it.
  const [params, setParams] = useSearchParams()
  const wantsOpen = params.get('settings') === '1'
  useEffect(() => {
    if (!wantsOpen) return
    setOpen(true)
    const next = new URLSearchParams(params)
    next.delete('settings')
    setParams(next, { replace: true })
  }, [wantsOpen, params, setParams])
  return (
    <>
      <button
        type="button"
        aria-label="Search this thread"
        title="Search this thread"
        data-testid="thread-search"
        onClick={() => nav(`/search?thread=${encodeURIComponent(thread.id)}`)}
        className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
      >
        <IconSearch />
      </button>
      <button
        type="button"
        aria-label="Thread settings"
        data-testid="thread-settings-trigger"
        onClick={() => setOpen(true)}
        className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
      >
        <IconMore />
      </button>
      <ThreadEditor open={open} onOpenChange={setOpen} thread={thread} />
    </>
  )
}

/** "+ New thread": opens the sheet in create mode. `compact` is the icon-only header/sidebar button. */
export function NewThread({
  compact,
  tone = 'surface',
  onCreated,
  className,
  defaultName,
}: {
  defaultName?: string
  compact?: boolean
  tone?: 'surface' | 'chrome'
  onCreated?: (id: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-testid={compact ? 'new-thread' : 'new-thread-bottom'}
        aria-label={compact ? 'Add a thread' : undefined}
        title={compact ? 'Add a thread' : undefined}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-button text-sm font-semibold',
          compact ? 'min-w-11' : 'border px-4',
          tone === 'chrome'
            ? 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome'
            : 'border-line text-text hover:bg-surface-2',
          className,
        )}
      >
        <IconPlus width={20} height={20} />
        {!compact && 'New thread'}
      </button>
      <ThreadEditor
        open={open}
        onOpenChange={setOpen}
        {...(onCreated ? { onCreated } : {})}
        {...(defaultName ? { defaultName } : {})}
      />
    </>
  )
}
