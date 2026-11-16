// Edit mode for the thread list (sidebar and the phone Threads tab): drag or move to reorder, a gear per thread for its
// settings sheet, and the archived threads with Restore. Reorders save as one owner-signed config.patch on drop.
import { SUBTHREADS_FEATURE, type ThreadT } from '@talos-app/protocol'
import { useMemo, useState } from 'react'
import { useFeature } from '../../../lib/v2Client.ts'
import { cn } from '../../../ui/cn.ts'
import { IconSettings } from '../../../ui/icons.tsx'
import { ThreadIcon } from '../../../ui/ThreadIcon.tsx'
import { ReorderList } from './ReorderList.tsx'
import { ThreadEditor } from './ThreadEditor.tsx'
import { underBlocked, underChoices } from './UnderPicker.tsx'
import { reorderThreads, sortThreads, useThreadPatch } from './useThreadPatch.ts'

export function ThreadManageList({
  tone = 'surface',
  moveButtons,
}: {
  tone?: 'surface' | 'chrome'
  moveButtons?: boolean
}) {
  const { threads, macOnline, err, busy, apply } = useThreadPatch()
  const subthreads = useFeature(SUBTHREADS_FEATURE) === 'on'
  const [editing, setEditing] = useState<ThreadT | null>(null)
  const { active, archived } = useMemo(() => {
    const s = sortThreads(threads)
    return {
      active: s.filter((t) => !t.archived && t.id !== 'inbox'),
      archived: s.filter((t) => t.archived),
    }
  }, [threads])
  const chrome = tone === 'chrome'
  const items = active.map((t) => ({ id: t.id, label: t.name, t }))
  const gear = cn(
    'grid size-11 shrink-0 place-items-center rounded-button',
    chrome ? 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome' : 'text-text-2 hover:bg-surface-2',
  )
  return (
    <div data-testid="thread-manage" className="flex flex-col gap-1">
      <ReorderList
        label="Threads, in order"
        testId="thread-order"
        tone={tone}
        moveButtons={moveButtons}
        disabled={!macOnline}
        items={items}
        onCommit={(ids) => apply((latest) => reorderThreads(latest, ids))}
        // dropped ONTO another thread: it goes under it, the same parent_id patch as the Under picker (the Mac judges it again)
        nest={
          subthreads
            ? {
                allowed: (id, onto) => {
                  const t = threads.find((x) => x.id === id)
                  return (
                    t !== undefined &&
                    !t.archived &&
                    t.kind !== 'system' &&
                    underBlocked(threads, t) === null &&
                    underChoices(threads, t).some((c) => c.id === onto)
                  )
                },
                commit: (id, onto) =>
                  apply((latest) => latest.map((x) => (x.id === id ? { ...x, parent_id: onto } : x))),
                label: (held) => `Put ${held} under this`,
              }
            : undefined
        }
        renderRow={({ t }) => (
          <>
            <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={28} framed />
            <span className={cn('min-w-0 flex-1 truncate text-sm', chrome ? 'text-on-chrome' : 'text-text')}>
              {t.name}
            </span>
            <button
              type="button"
              aria-label={`Settings for ${t.name}`}
              data-testid={`thread-edit-${t.id}`}
              onClick={() => setEditing(t)}
              className={gear}
            >
              <IconSettings width={18} height={18} />
            </button>
          </>
        )}
      />
      {!macOnline && (
        <p className={cn('m-0 px-2 text-xs', chrome ? 'text-on-chrome-2' : 'text-text-2')}>
          Changes need your Mac online.
        </p>
      )}
      {err && (
        <p role="alert" className={cn('m-0 px-2 text-xs', chrome ? 'text-chrome-accent-text' : 'text-danger')}>
          {err}
        </p>
      )}
      {archived.length > 0 && (
        <div className="mt-2" data-testid="thread-archived">
          <p
            className={cn(
              'm-0 px-2 pb-1 text-xs font-semibold tracking-[var(--tracking-caps)] uppercase',
              chrome ? 'text-on-chrome-2' : 'text-text-2',
            )}
          >
            Archived
          </p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {archived.map((t) => (
              <li key={t.id} className="flex min-h-11 items-center gap-2 pl-2">
                <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={24} framed className="opacity-70" />
                <span className={cn('min-w-0 flex-1 truncate text-sm', chrome ? 'text-on-chrome-2' : 'text-text-2')}>
                  {t.name}
                </span>
                <button
                  type="button"
                  disabled={!macOnline || busy}
                  onClick={() =>
                    void apply((latest) => latest.map((x) => (x.id === t.id ? { ...x, archived: false } : x)))
                  }
                  className={cn(
                    'min-h-11 rounded-button px-3 text-sm font-semibold disabled:opacity-50',
                    chrome ? 'text-chrome-accent-text hover:bg-chrome-hover' : 'text-accent-text hover:bg-surface-2',
                  )}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ThreadEditor
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        thread={editing ?? undefined}
      />
    </div>
  )
}
