// The Session button for a wide screen: the usage chip (weekly and context, both percent USED), small and quiet in the far
// top-right corner of the screen, out of the reading line. On a desktop it opens and closes the docked panel; on a tablet it
// opens the sheet. Dimmed with "Mod offline" when the mod lapsed. Phones have the context ring in their header instead.
import { SESSION_FEATURE } from '@talos-app/protocol'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { useMediaQuery } from '../settings/useMedia.ts'
import { toggleSessionDock, useSessionDockOpen } from './dockPref.ts'
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
        'relative flex flex-col items-end whitespace-nowrap font-mono text-[11px] leading-tight text-text-2',
        phase === 'offline' && 'italic',
      )}
    >
      {/* A lapsed mod is a dot, not words: the chip keeps its width, and the words are in the button's name and tooltip. */}
      {phase === 'offline' && (
        <span
          data-testid="session-offline-dot"
          aria-hidden="true"
          className="absolute top-0.5 -left-1.5 size-1.5 rounded-pill bg-warn"
        />
      )}
      {/* Phones are narrow: one caption says "used" for every row; from sm up each row says it itself. */}
      <span className="text-[9px] uppercase tracking-wider sm:hidden">used</span>
      {parts.week !== undefined && (
        <span>
          wk {parts.week}%<span className="hidden sm:inline"> used</span>
        </span>
      )}
      {/* a real space between the two rows, so the words read "wk 60% used ctx 31% used" to anything that joins the text */}
      {parts.week !== undefined && parts.ctx !== undefined && ' '}
      {parts.ctx !== undefined && (
        <span>
          ctx {parts.ctx}%<span className="hidden sm:inline"> used</span>
        </span>
      )}
    </span>
  )
}

/** At this width and up the panel docks beside the chat; below it (a tablet) it is a sheet. */
export const DOCK_QUERY = '(min-width: 1024px)'

/** The chip, pinned to the top-right corner of the box it sits in (the shell's centre column). */
export function SessionTrigger({ threadId }: { threadId: string }) {
  const supported = useSessionSupported()
  const docked = useMediaQuery(DOCK_QUERY)
  const dockOpen = useSessionDockOpen()
  const ctl = useSessionController()
  const state = useStore(ctl.store, (s) => s.state)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const parts = chipParts(state)
  const hasChip = parts !== undefined
  const offline = phaseOf(state, modOnline) === 'offline'
  // What the chip shows, as words, for the name of the button when the mod has lapsed (a dot alone says nothing aloud).
  const reading = [
    parts?.week !== undefined ? `wk ${parts.week}% used` : null,
    parts?.ctx !== undefined ? `ctx ${parts.ctx}% used` : null,
  ]
    .filter(Boolean)
    .join(' ')
  const [sheet, setSheet] = useState(false)
  const [seen, setSeen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { pathname } = useLocation()
  // the sheet belongs to the screen it was opened on: a link inside it (to Settings) must not leave it hanging over the next
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setSheet(false), [pathname])
  // Widening to a desktop turns the sheet into the docked panel: narrowing again must not bring the old sheet back.
  useEffect(() => {
    if (docked) setSheet(false)
  }, [docked])
  if (!supported) return null
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // With a reading on screen the name is "Session: " (spoken only) plus that text, so the visible words stay in the
        // name and "click Session" still finds it. Without a reading only the word "Session" shows, so this label is what
        // is visible, never a different wording. A lapsed mod is drawn as a dot, so there the name and the tooltip say so.
        {...(hasChip && !offline
          ? {}
          : {
              'aria-label': hasChip ? `Session: ${reading}, mod offline` : offline ? 'Session, mod offline' : 'Session',
            })}
        {...(offline ? { title: 'Session: mod offline' } : {})}
        {...(docked ? { 'aria-expanded': dockOpen, 'aria-controls': 'session-dock' } : { 'aria-haspopup': 'dialog' })}
        data-testid="session-trigger"
        onClick={() => {
          if (docked) return toggleSessionDock()
          setSeen(true)
          setSheet(true)
        }}
        // A 44 px touch without growing the drawn chip: the hit area reaches past it.
        className="absolute top-2 right-3 z-10 flex items-center rounded-button px-1.5 py-1 hover:bg-surface-2 before:absolute before:-inset-2 before:content-['']"
      >
        {hasChip && <span className="sr-only">Session: </span>}
        <SessionChip />
        {/* No reading yet: the trigger still needs something visible to tap. */}
        {!hasChip && <span className="text-[11px] text-text-2">Session</span>}
      </button>
      {seen && !docked && (
        <Suspense fallback={null}>
          <SessionSheet open={sheet} onOpenChange={setSheet} threadId={threadId} returnFocus={buttonRef} />
        </Suspense>
      )}
    </>
  )
}
