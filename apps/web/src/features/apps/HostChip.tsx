// A question Talos asks the owner on behalf of a view: "<label> wants to send:" + the text, or "<label> wants to go
// full screen". It is a modal sheet fixed to the bottom of the viewport, above the page and (in fullscreen) above the
// fullscreen overlay, with a backdrop that takes every tap. Nothing behind it can move the buttons, so a tap aimed at
// something else never lands on Send. The owner's tap here is the only thing that lets a view's `ui/message` or
// fullscreen request through, because a tap inside a cross-origin frame cannot be told from the view focusing itself.
// The main button ignores press, click and Enter/Space for CHIP_ARM_MS after the sheet opens (and again after the
// visual viewport resizes or scrolls: the iOS keyboard, a pinch), so a tap that was already on its way never sends.
import { useCallback, useEffect, useRef, useState } from 'react'
import { BoxSheet } from './BoxSheet.tsx'
import type { ChipAnswer } from './host.ts'

export const CHIP_ARM_MS = 600

export function HostChip({
  kind,
  text,
  label,
  container,
  onDecide,
  onClosed,
}: {
  kind: 'message' | 'fullscreen'
  /** The message text (kind=message), shown whole in a box that scrolls. */
  text?: string
  label: string
  /** Where the sheet is drawn: the app card (only the fullscreen element and its children are drawn in real fullscreen). */
  container: HTMLElement | null
  onDecide: (answer: ChipAnswer) => void
  /** The sheet has gone and focus is free: the card takes it back (not the page, not whatever had it before). */
  onClosed: () => void
}) {
  const no = useRef<HTMLButtonElement>(null)
  const shownAt = useRef(performance.now())
  const downOk = useRef(false)
  const [armed, setArmed] = useState(false)
  const [generation, setGeneration] = useState(0)

  const rearm = useCallback(() => {
    shownAt.current = performance.now()
    setArmed(false)
    setGeneration((g) => g + 1)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` restarts the wait each time the sheet is re-armed
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), CHIP_ARM_MS)
    return () => clearTimeout(t)
  }, [generation])

  // The keyboard on iOS and a pinch move the visual viewport under a fixed sheet: wait again.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    vv.addEventListener('resize', rearm)
    vv.addEventListener('scroll', rearm)
    return () => {
      vv.removeEventListener('resize', rearm)
      vv.removeEventListener('scroll', rearm)
    }
  }, [rearm])

  const ready = () => armed && performance.now() - shownAt.current >= CHIP_ARM_MS

  const ids =
    kind === 'message'
      ? { chip: 'app-message-chip', main: 'app-message-send', no: 'app-message-dismiss' }
      : { chip: 'app-fullscreen-chip', main: 'app-fullscreen-allow', no: 'app-fullscreen-no' }
  return (
    <BoxSheet
      open
      onOpenChange={(o) => !o && onDecide('no')}
      container={container}
      title={kind === 'message' ? `${label} wants to send:` : `${label} wants to go full screen`}
      testId={ids.chip}
      outsideDismisses={false}
      // keyboard users start on the safe button (Enter there declines)
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        no.current?.focus({ preventScroll: true })
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault()
        onClosed()
      }}
    >
      {kind === 'message' && (
        // The text scrolls on its own so the buttons below it stay in place, however long the message is.
        <section
          className="max-h-[40dvh] min-h-0 overflow-y-auto rounded-card border border-line bg-surface-2 p-3 text-sm"
          data-testid="app-message-scroll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus or a keyboard cannot reach the rest of a long message
          tabIndex={0}
          aria-label="Message text"
        >
          <p data-testid="app-message-text" className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {text}
          </p>
        </section>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={ids.main}
          data-armed={armed}
          aria-disabled={!armed}
          onPointerDown={() => {
            downOk.current = ready()
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !ready()) e.preventDefault()
          }}
          onClick={(e) => {
            // A pointer click needs an armed button on press AND on release; a keyboard click (detail 0) on release.
            const viaPointer = e.detail > 0
            const pressed = downOk.current
            downOk.current = false
            if (!ready() || (viaPointer && !pressed)) return
            onDecide('allow')
          }}
          className="min-h-11 rounded-pill border border-line bg-text px-4 text-surface data-[armed=false]:opacity-50"
        >
          {kind === 'message' ? 'Send' : 'Allow'}
        </button>
        <button
          ref={no}
          type="button"
          data-testid={ids.no}
          onClick={() => onDecide('no')}
          className="min-h-11 rounded-pill border border-line px-4"
        >
          {kind === 'message' ? 'Dismiss' : 'No'}
        </button>
        <button
          type="button"
          data-testid="app-chip-mute"
          onClick={() => onDecide('mute')}
          className="min-h-11 rounded-pill px-3 text-text-2 underline"
        >
          Stop asking
        </button>
      </div>
    </BoxSheet>
  )
}
