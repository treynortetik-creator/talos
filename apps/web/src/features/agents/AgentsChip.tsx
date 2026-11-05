// The header chip below 1280 px (docs/SUBAGENTS.md 6.1): "3 agents" next to the session mascot. From 1024 px it opens
// the right-hand session sheet (its Agents section sits under the meters); on phones it opens a bottom sheet with the
// full list. Shown only when the mod sends a snapshot at all; the count is agentCounts().active, pulsing while busy.
import { lazy, Suspense, useRef, useState } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconClose } from '../../ui/icons.tsx'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../ui/index.ts'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { useSessionSupported } from '../session/SessionTrigger.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { AgentsList, type AgentsView, OfflineBadge, useAgentsView } from './AgentsList.tsx'
import { chipLabel } from './logic.ts'

const SessionSheet = lazy(async () => ({ default: (await import('../session/SessionSheet.tsx')).SessionSheet }))

/**
 * `header` sits next to the session mascot (640 to 1279 px); `inline` sits on the status line under the thread name on
 * narrow phones, where one more header button would truncate the name. Only the variant for the current width renders.
 */
export function AgentsChip({ threadId, variant }: { threadId: string; variant: 'header' | 'inline' }) {
  const supported = useSessionSupported()
  const view = useAgentsView()
  if (!supported || !view.snap) return null
  return <Chip threadId={threadId} view={view} variant={variant} />
}

function Chip({ threadId, view, variant }: { threadId: string; view: AgentsView; variant: 'header' | 'inline' }) {
  const wide = useMediaQuery('(min-width: 1024px)')
  const roomy = useMediaQuery('(min-width: 640px)')
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  if (roomy !== (variant === 'header')) return null
  const chip = chipLabel(view.snap)
  const offline = view.offline ? `, ${view.offline === 'mac' ? 'Mac' : 'mod'} offline` : ''
  const dot = (
    <StatusDot
      shape={chip.busy ? 'half' : 'ring'}
      className={cn(chip.busy ? 'agent-pulse text-accent-text' : 'text-text-2')}
    />
  )
  const words = (
    <>
      <span aria-live="polite" data-testid="agents-chip-count" className="tabular-nums text-text">
        {chip.count}
      </span>
      <span>{chip.unit}</span>
      <span className="sr-only">
        {' '}
        ({chip.full}
        {offline})
      </span>
    </>
  )
  const onClick = () => {
    setSeen(true)
    setOpen(true)
  }
  return (
    <>
      {variant === 'header' ? (
        <button
          ref={chipRef}
          type="button"
          aria-haspopup="dialog"
          data-testid="agents-chip"
          onClick={onClick}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill px-0.5 xl:hidden"
        >
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface px-2.5 py-1 font-mono text-[11px] leading-tight text-text-2',
              view.offline && 'italic',
            )}
          >
            {dot}
            {words}
          </span>
        </button>
      ) : (
        // A 44 px tap target without growing the status line: the hit area extends past the drawn chip.
        <button
          ref={chipRef}
          type="button"
          aria-haspopup="dialog"
          data-testid="agents-chip"
          onClick={onClick}
          className={cn(
            "relative inline-flex shrink-0 items-center gap-1 rounded-pill font-mono text-[11px] leading-tight text-text-2 before:absolute before:-inset-x-2 before:-inset-y-3 before:content-['']",
            view.offline && 'italic',
          )}
        >
          {dot}
          {words}
        </button>
      )}
      {seen &&
        (wide ? (
          <Suspense fallback={null}>
            <SessionSheet open={open} onOpenChange={setOpen} threadId={threadId} returnFocus={chipRef} />
          </Suspense>
        ) : (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
              onCloseAutoFocus={(e) => {
                // the Sheet is controlled with no Trigger, so Radix has nowhere to return focus: back to the chip
                e.preventDefault()
                chipRef.current?.focus()
              }}
              side="bottom"
              aria-describedby={undefined}
              data-testid="agents-sheet"
              className="pb-[max(1rem,env(safe-area-inset-bottom))]"
            >
              <div className="mb-3 flex items-center gap-2">
                <SheetTitle className="m-0 font-display text-xl font-semibold">Agents</SheetTitle>
                <span className="font-mono text-xs text-text-2">{chip.agents} active</span>
                <span className="ml-auto">
                  <OfflineBadge offline={view.offline} />
                </span>
                <SheetClose
                  aria-label="Close"
                  className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
                >
                  <IconClose />
                </SheetClose>
              </div>
              <AgentsList threadId={threadId} mode="push" view={view} />
            </SheetContent>
          </Sheet>
        ))}
    </>
  )
}
