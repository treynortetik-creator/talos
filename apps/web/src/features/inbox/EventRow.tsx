// One inbox row. Everything that came from a hook is rendered as plain React text: never HTML, never markdown.
import type { InboxItemT } from '@talos-app/protocol'
import { type PointerEvent, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { shortAge } from '../../lib/format.ts'
import { cn } from '../../ui/cn.ts'
import { useNow } from '../cards/util.ts'
import type { EventRowProps } from '../contracts.ts'
import { snoozeUntil } from './logic.ts'
import { SourceAvatar } from './sourceIcon.tsx'
import { offerUndo } from './undo.tsx'

const SWIPE_PX = 80
const START_PX = 8

export function sourceLabel(item: InboxItemT): string {
  return item.source.replace(/_/g, ' ')
}

/** A swipe to Done or Snooze offers Undo wherever the row sits (the inbox or a thread). */
export function EventRow({ item, onOpen }: EventRowProps) {
  const client = useTalosClient()
  const tz = useTalos((s) => s.config?.timezone ?? 'UTC')
  const quiet = useTalos((s) => s.config?.quiet_window ?? null)
  const now = useNow(60_000)
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const moved = useRef(false)
  const [dx, setDx] = useState(0)
  // The latest drag distance, read by `end`. Reading the `dx` state there used a stale render when pointerup landed before
  // React re-rendered the last pointermove (a fast flick, or a slow CI runner), so a real swipe fell under SWIPE_PX.
  const dxRef = useRef(0)

  const done = () => {
    void client.updateInbox(item.id, { state: 'done' })
    offerUndo(item, 'done')
  }
  const snooze = () => {
    void client.updateInbox(item.id, {
      state: 'snoozed',
      snoozeUntil: snoozeUntil(new Date(), tz, quiet).toISOString(),
    })
    offerUndo(item, 'snoozed')
  }

  const down = (e: PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
    moved.current = false
  }
  const move = (e: PointerEvent) => {
    const s = start.current
    if (!s) return
    const x = e.clientX - s.x
    if (!moved.current && (Math.abs(x) < START_PX || Math.abs(e.clientY - s.y) > Math.abs(x))) return
    moved.current = true
    dxRef.current = Math.max(-160, Math.min(160, x))
    setDx(dxRef.current)
  }
  const end = () => {
    if (!start.current) return
    start.current = null
    const final = dxRef.current
    dxRef.current = 0
    setDx(0)
    if (final >= SWIPE_PX) done()
    else if (final <= -SWIPE_PX) snooze()
  }

  const agentSummary = item.agent_summary
  return (
    <li className="relative overflow-hidden border-b border-line" data-event-id={item.id}>
      <div aria-hidden className="absolute inset-0 flex items-center justify-between px-4 text-sm font-medium">
        <span className="text-ok">✓ Done</span>
        <span className="text-info">Snooze ⏰</span>
      </div>
      <button
        type="button"
        className={cn(
          'relative flex min-h-16 w-full touch-pan-y items-start gap-3 bg-surface px-3 py-2 text-left select-none',
          dx === 0 && 'transition-transform duration-[var(--dur-1)] ease-talos',
        )}
        style={{ transform: `translateX(${dx}px)` }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          start.current = null
          dxRef.current = 0
          setDx(0)
        }}
        onClick={() => {
          if (moved.current) {
            moved.current = false
            return
          }
          onOpen?.(item)
        }}
      >
        <SourceAvatar source={item.source} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('truncate text-text', item.state === 'new' && 'font-medium')}>{item.title}</span>
            <span className="shrink-0 rounded-pill bg-surface-2 px-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
              {sourceLabel(item)}
            </span>
          </span>
          {agentSummary ? (
            <span className="block text-sm text-text">
              <span aria-hidden>✦ </span>
              <span className="sr-only">Summary from the agent: </span>
              {agentSummary}
            </span>
          ) : (
            <span className="block text-sm text-text-2">{item.summary}</span>
          )}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-text-2">{shortAge(item.ts, now)}</span>
      </button>
    </li>
  )
}
