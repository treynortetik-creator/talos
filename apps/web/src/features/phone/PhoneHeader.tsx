// The phone's thread header: ONE slim row. Menu button, thread name (with a tiny status dot), and a compact context ring
// that opens the session panel. Everything else the old header carried lives one tap away: other threads in the left
// menu, status, usage and agents in the session panel, thread settings in the menu.
import type { ThreadStatusT, ThreadT } from '@talos-app/protocol'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconSearch, IconThreads } from '../../ui/icons.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { usePalette } from '../palette/store.ts'
import { PALETTE_TEXT } from '../palette/text.ts'
import { chipParts, phaseOf, usageLabel } from '../session/logic.ts'
import { useSessionSupported } from '../session/SessionTrigger.tsx'
import { useSessionController } from '../session/store.ts'
import { useThreadContext } from '../session/threadContext.ts'
import { useNeedsYouCount } from '../threads/Nav.tsx'
import { statusMark } from '../threads/StatusPill.tsx'
import { usePhonePanel } from './phoneStore.ts'

const R = 8
const C = 2 * Math.PI * R

/** A 22 px ring filled to `pct` of context used. Never colour alone: the number sits beside it. */
export function ContextRing({ pct, warn }: { pct: number | undefined; warn?: boolean }) {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 22 22"
      aria-hidden="true"
      data-testid="context-ring-svg"
      className="shrink-0"
    >
      <circle
        cx="11"
        cy="11"
        r={R}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.35}
        strokeWidth={2.5}
        strokeDasharray={pct === undefined ? '2 3' : undefined}
      />
      {pct !== undefined && (
        <circle
          cx="11"
          cy="11"
          r={R}
          fill="none"
          stroke={warn ? 'var(--warn)' : 'var(--chrome-accent-text)'}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct / 100)}
          transform="rotate(-90 11 11)"
        />
      )}
    </svg>
  )
}

export function PhoneHeader({
  thread,
  state,
  statusLabel,
}: {
  thread: ThreadT
  state: ThreadStatusT['state'] | undefined
  statusLabel?: string | undefined
}) {
  const set = usePhonePanel((s) => s.set)
  const supported = useSessionSupported()
  const ctl = useSessionController()
  const sessionState = useStore(ctl.store, (s) => s.state)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const view = useThreadContext(thread.id)
  const parts = chipParts(sessionState, view)
  const phase = phaseOf(sessionState, modOnline)
  const ctx = parts?.ctx
  const mark = statusMark(state)
  // What the old tab strip and bottom bar showed: messages waiting in the other threads, and cards that need the owner.
  const unread = useTalos((st) => Object.entries(st.unread).reduce((n, [id, c]) => (id === thread.id ? n : n + c), 0))
  const needs = useNeedsYouCount()
  const waiting = [unread > 0 ? `${unread} unread` : '', needs > 0 ? `${needs} need you` : '']
    .filter(Boolean)
    .join(', ')
  const usage = usageLabel(parts, phase)
  return (
    <header
      data-testid="phone-header"
      className="kb-hide-short frieze flex h-[calc(2.75rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 px-1 pt-[env(safe-area-inset-top)]"
    >
      <button
        type="button"
        aria-label={waiting ? `Open menu, ${waiting}` : 'Open menu'}
        aria-haspopup="dialog"
        data-testid="phone-menu-button"
        data-phone-opener="menu"
        onClick={() => set('menu')}
        className="relative grid size-11 shrink-0 place-items-center rounded-pill hover:bg-chrome-hover"
      >
        <IconThreads />
        {waiting && (
          <span
            data-testid="phone-menu-badge"
            aria-hidden="true"
            className="absolute top-2 right-1.5 size-2.5 rounded-pill bg-accent shadow-[0_0_0_2px_var(--chrome)]"
          />
        )}
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="m-0 truncate font-display text-base font-semibold leading-tight">{thread.name}</h1>
        <span
          aria-live="polite"
          data-testid="phone-status"
          className={cn('inline-flex shrink-0 items-center', mark.tone)}
        >
          <StatusDot shape={mark.shape} size={8} className={state === 'needs_you' ? 'text-warn' : 'text-on-chrome-2'} />
          <span className="sr-only">
            {mark.word}
            {statusLabel ? `, ${statusLabel}` : ''}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={PALETTE_TEXT.searchButton}
        aria-haspopup="dialog"
        data-testid="palette-button"
        onClick={(e) => usePalette.getState().open('palette', e.currentTarget)}
        className="grid size-11 shrink-0 place-items-center rounded-pill text-on-chrome hover:bg-chrome-hover"
      >
        <IconSearch width={20} height={20} />
      </button>
      {supported && (
        <button
          type="button"
          aria-label={`Session${usage ? `: ${usage}` : ''}`}
          aria-haspopup="dialog"
          data-testid="session-trigger"
          data-phone-opener="session"
          onClick={() => set('session')}
          className={cn(
            'flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-pill px-2 font-mono text-xs text-on-chrome hover:bg-chrome-hover',
            phase === 'offline' && 'italic opacity-80',
            (view.kind === 'last' || view.kind === 'off') && 'opacity-60',
          )}
        >
          <ContextRing pct={ctx} warn={ctx !== undefined && ctx >= 85} />
          {ctx !== undefined && <span data-testid="context-pct">{ctx}%</span>}
        </button>
      )}
    </header>
  )
}
