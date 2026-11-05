// The header's session button: the usage chip (weekly and context, both percent USED) plus, on phones only, a still mascot that is readable
// without opening the sheet. Hidden chip when nothing is known; dimmed with "Mod offline" when the mod lapsed.
import { SESSION_FEATURE } from '@talos-app/protocol'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { chipParts, phaseOf } from './logic.ts'
import { useSessionController } from './store.ts'

const SessionSheet = lazy(async () => ({ default: (await import('./SessionSheet.tsx')).SessionSheet }))

/** Nothing to show when the Mac says it does not speak `session/1`; unknown (no list) shows it. */
export function useSessionSupported(): boolean {
  const features = useTalos((s) => s.presence.features)
  return !features || features.includes(SESSION_FEATURE)
}

export function SessionChip() {
  const ctl = useSessionController()
  const state = useStore(ctl.store, (s) => s.state)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const parts = chipParts(state)
  const phase = phaseOf(state, modOnline)
  if (!parts) return null
  // No role or label of its own: the button's name is built from the text on screen, so it can never disagree with it. Text
  // that CSS hides at this width (display: none) is left out of the name too.
  return (
    <span
      data-testid="session-chip"
      className={cn(
        'flex flex-col items-end whitespace-nowrap font-mono text-[11px] leading-tight text-text-2',
        phase === 'offline' && 'italic',
      )}
    >
      {/* Phones are narrow: one caption says "used" for every row; from sm up each row says it itself. */}
      <span className="text-[9px] uppercase tracking-wider sm:hidden">used{phase === 'offline' && ' · offline'}</span>
      {parts.week !== undefined && (
        <span>
          wk {parts.week}%<span className="hidden sm:inline"> used</span>
        </span>
      )}
      {(parts.ctx !== undefined || phase === 'offline') && (
        <span>
          {parts.ctx !== undefined && (
            <>
              ctx {parts.ctx}%<span className="hidden sm:inline"> used</span>
            </>
          )}
          {phase === 'offline' && <span className="hidden sm:inline"> · mod offline</span>}
        </span>
      )}
    </span>
  )
}

/** `children` is the still mascot: shown on phones only (the desktop sidebar already carries the logo). */
export function SessionTrigger({ threadId, children }: { threadId: string; children: ReactNode }) {
  const supported = useSessionSupported()
  const hasChip = chipParts(useStore(useSessionController().store, (s) => s.state)) !== undefined
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(false)
  if (!supported) return <>{children}</>
  return (
    <>
      <button
        type="button"
        // With a reading on screen the name is "Session: " (spoken only) plus that text, so the visible words stay in the
        // name and "click Session" still finds it. Without a reading only the mascot (phones) or the word "Session"
        // (desktop) shows, so this label is what is visible, never a different wording.
        {...(hasChip ? {} : { 'aria-label': 'Session' })}
        aria-haspopup="dialog"
        data-testid="session-trigger"
        onClick={() => {
          setSeen(true)
          setOpen(true)
        }}
        className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-pill px-1 hover:bg-surface-2"
      >
        {hasChip && <span className="sr-only">Session: </span>}
        <SessionChip />
        <span className="flex md:hidden">{children}</span>
        {/* No reading yet on desktop: the trigger still needs something visible to tap. */}
        {!hasChip && <span className="hidden text-xs text-text-2 md:inline">Session</span>}
      </button>
      {seen && (
        <Suspense fallback={null}>
          <SessionSheet open={open} onOpenChange={setOpen} threadId={threadId} />
        </Suspense>
      )}
    </>
  )
}
