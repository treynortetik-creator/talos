// "Under" in thread settings (docs/THREADS.md "Sub-threads"): put a thread under another one, one level deep, or take it out.
// It saves at once through the thread patch, like the alerts row. The Mac judges every rule again (packages/protocol
// sub-threads.ts: folders, MCP lists, Mac app support), so a refusal shows here in the Mac's own words and the choice goes back
// to what is saved. Shown only when the bridge says this Mac takes sub-threads (`subthreads/1`).
import { SUBTHREADS_FEATURE, subThreadWarnings, type ThreadT } from '@talos-app/protocol'
import { useId } from 'react'
import { useFeature } from '../../../lib/v2Client.ts'

/** The threads `thread` may go under: top-level, not archived, not the inbox, not itself. */
export function underChoices(threads: readonly ThreadT[], thread: ThreadT): ThreadT[] {
  return threads.filter((t) => t.id !== thread.id && !t.archived && t.kind !== 'system' && !t.parent_id)
}

/** Why `thread` can't be put under anything (it holds sub-threads), or null when it can. */
export function underBlocked(threads: readonly ThreadT[], thread: ThreadT): string | null {
  if (threads.some((t) => t.parent_id === thread.id && t.id !== thread.id))
    return 'This thread has sub-threads, so it stays at the top level (sub-threads go one level deep).'
  return null
}

/** The note for a sub-thread that keeps its own folder outside its parent's (no parent instructions), or null. */
export function ownFolderNote(threads: readonly ThreadT[], thread: ThreadT): string | null {
  const mine = `thread "${thread.id}" `
  return subThreadWarnings({ threads }).find((w) => w.startsWith(mine)) ?? null
}

export function UnderPicker({
  thread,
  threads,
  locked,
  save,
}: {
  thread: ThreadT
  threads: readonly ThreadT[]
  locked: boolean
  /** Writes the new parent (null = top level). A refusal shows in the editor's error line, in the Mac's words. */
  save: (parent: string | null) => Promise<boolean>
}) {
  const id = useId()
  const on = useFeature(SUBTHREADS_FEATURE) === 'on'
  if (!on || thread.archived || thread.kind === 'system') return null // the inbox is never a sub-thread
  const blocked = underBlocked(threads, thread)
  const choices = underChoices(threads, thread)
  const current = thread.parent_id ?? ''
  const ownFolder = ownFolderNote(threads, thread)
  // a parent that is no longer a valid choice (archived, missing, or a hand edit) still shows, so the select never lies about
  // the file; a missing one by its id
  const stale =
    current && !choices.some((t) => t.id === current)
      ? (threads.find((t) => t.id === current) ?? { id: current, name: current })
      : undefined

  return (
    <div className="flex flex-col gap-1" data-testid="thread-under">
      <label htmlFor={id} className="text-sm font-medium">
        Under
      </label>
      {blocked && !current ? (
        <p className="m-0 text-xs text-text-2" data-testid="thread-under-blocked">
          {blocked}
        </p>
      ) : (
        <select
          id={id}
          className="min-h-11 rounded-button border border-line bg-surface px-2 text-sm text-text disabled:opacity-50"
          disabled={locked}
          value={current}
          onChange={(e) => void save(e.target.value || null)}
        >
          <option value="">No thread (top level)</option>
          {stale && (
            <option value={stale.id} disabled>
              {stale.name}
            </option>
          )}
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {ownFolder && (
        <p className="m-0 text-xs text-text-2" data-testid="thread-under-own-folder">
          {ownFolder}
        </p>
      )}
      <p className="m-0 text-xs text-text-2">
        A sub-thread uses its parent's folder, model and MCP servers unless it sets its own.
      </p>
    </div>
  )
}
