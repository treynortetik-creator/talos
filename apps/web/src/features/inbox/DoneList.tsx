// The inbox "Done" view (audit D35): what he finished, newest first, each with Restore. Plain text only, like every inbox row.
import type { InboxItemT } from '@talos-app/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { shortAge } from '../../lib/format.ts'
import { Button } from '../../ui/index.ts'
import { useNow } from '../cards/util.ts'
import { fetchDone, restoreInboxItem } from './done.ts'
import { sourceLabel } from './EventRow.tsx'
import { SourceAvatar } from './sourceIcon.tsx'

export function DoneList() {
  const client = useTalosClient()
  const stored = useTalos((s) => s.inbox)
  const now = useNow(60_000)
  const [fetched, setFetched] = useState<InboxItemT[] | null>(null)
  const [cut, setCut] = useState(false)
  const [error, setError] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(false)
    try {
      const r = await fetchDone(client)
      setFetched(r.items)
      setCut(r.truncated)
    } catch {
      setError(true)
      setFetched((cur) => cur ?? [])
    }
  }, [client])
  useEffect(() => void load(), [load])

  // The relay's list plus what this session finished (not yet on the relay); an item the store now holds as anything else
  // (just restored) is off the list at once.
  const items = useMemo(() => {
    const byId = new Map<string, InboxItemT>((fetched ?? []).map((i) => [i.id, i]))
    for (const s of stored) {
      if (s.state === 'done') byId.set(s.id, s)
      else byId.delete(s.id)
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  }, [fetched, stored])

  const restore = async (it: InboxItemT) => {
    setNote(`Restored to ${it.priority === 'low' ? 'Other' : 'Priority'}.`)
    await restoreInboxItem(client, it)
  }

  if (fetched === null) return <p className="py-12 text-center text-text-2">Loading…</p>
  return (
    <div className="mt-3 flex flex-col gap-2">
      {error ? (
        <div
          role="alert"
          data-testid="done-error"
          className="flex items-center gap-3 rounded-card border border-warn p-3 text-sm text-warn"
        >
          <span className="flex-1">Couldn't load your done items.</span>
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}
      {cut ? (
        <p
          role="status"
          data-testid="done-truncated"
          className="m-0 rounded-card border border-warn p-3 text-sm text-warn"
        >
          Showing the 200 newest. Older finished items are not listed here.
        </p>
      ) : null}
      {note ? (
        <p role="status" className="m-0 text-sm text-text-2">
          {note}
        </p>
      ) : null}
      {items.length === 0 ? (
        error ? null : (
          <p className="py-12 text-center text-text-2" data-testid="done-empty">
            Nothing finished yet.
          </p>
        )
      ) : (
        <ul className="incised overflow-hidden rounded-card bg-surface p-1" aria-label="Done">
          {items.map((it) => (
            <li key={it.id} data-event-id={it.id} className="flex items-start gap-3 border-b border-line px-3 py-2">
              <SourceAvatar source={it.source} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-text">{it.title}</span>
                  <span className="shrink-0 rounded-pill bg-surface-2 px-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
                    {sourceLabel(it)}
                  </span>
                </span>
                <span className="block text-sm text-text-2">{it.agent_summary ?? it.summary}</span>
                <span className="block font-mono text-xs tabular-nums text-text-2">{shortAge(it.ts, now)}</span>
              </span>
              <Button variant="outline" aria-label={`Restore ${it.title}`} onClick={() => void restore(it)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
