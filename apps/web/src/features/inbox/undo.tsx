// Undo for Done and Snooze (audit D35), shared by every place that can do either: the inbox, a thread's item sheet and
// event rows, and Home's menu. One offer at a time; a second Done replaces the first.
import type { InboxItemT } from '@talos-app/protocol'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { Button } from '../../ui/index.ts'
import { restoreInboxItem, UNDO_MS, undoTarget } from './done.ts'

type Offer = { item: InboxItemT; kind: 'done' | 'snoozed' }
const useUndoStore = create<{ offer: Offer | null }>(() => ({ offer: null }))

/** `item` is the row as it was BEFORE the change, so Undo can put back what it was (an unread item stays unread). */
export const offerUndo = (item: InboxItemT, kind: Offer['kind']) => useUndoStore.setState({ offer: { item, kind } })
export const clearUndo = () => useUndoStore.setState({ offer: null })

export function UndoStrip({ floating = false }: { floating?: boolean }) {
  const client = useTalosClient()
  const offer = useUndoStore((s) => s.offer)
  useEffect(() => {
    if (!offer) return
    const t = setTimeout(() => (useUndoStore.getState().offer === offer ? clearUndo() : undefined), UNDO_MS)
    return () => clearTimeout(t)
  }, [offer])
  if (!offer) return null
  const { item, kind } = offer
  return (
    <div
      role="status"
      data-testid="inbox-undo"
      className={cn(
        'z-40 flex items-center gap-3 rounded-card border border-line bg-surface-2 p-2 pl-3 text-sm text-text',
        floating ? 'fixed inset-x-4 top-2 mx-auto max-w-3xl' : 'sticky top-0',
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {kind === 'done' ? 'Marked done' : 'Snoozed'}: {item.title}
      </span>
      <Button
        variant="outline"
        onClick={() => {
          clearUndo()
          void restoreInboxItem(client, item, { to: undoTarget(item) })
        }}
      >
        Undo
      </Button>
    </div>
  )
}
