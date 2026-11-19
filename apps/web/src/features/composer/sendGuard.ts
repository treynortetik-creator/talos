// After a send the box empties, and the mic and the live-call button take Send's place in the row: "Start a live call" sits
// exactly where Send was. A second press on that spot (a double tap, a touch the screen registered twice, a quick re-tap) then
// started a call, which asks for the microphone: "pressing Send starts dictation" (the owner, 2026-11-19). For a moment after
// the send, a press there is swallowed before it reaches either button.
//
// Every time here is an event's own timeStamp (when the finger or key acted), never the clock when a handler happens to run:
// on a busy or slow phone the second tap can wait in the queue far longer than the moment itself, and was let through when the
// moment was measured from the re-render (red under load at 18695c5e). Two rules, both from those timestamps:
//  - a press that began before the buttons were on screen was meant for Send: always swallowed, however long it waited;
//  - a press that began within SEND_GUARD_MS of the Send press is swallowed.
// Some browsers stamp a press only when the page gets to it (WebKit as Playwright drives it: a tap made 150 ms after Send, on
// a page frozen for 1.2 s, is stamped at 1.2 s). So for a few seconds after the send the page also notes when it was frozen,
// and a press stamped as it is handled, during or just after a freeze, is judged from when the freeze began: it may have been
// made in it. A press stamped well before it was handled (Chromium, Firefox: the time it was made) is judged by its stamp.
import { type SyntheticEvent, useEffect, useLayoutEffect, useRef } from 'react'

/** How long after a send the buttons in Send's place ignore a press. A double tap is under 300 ms; a quick re-tap a bit more. */
export const SEND_GUARD_MS = 700

/** A Send press older than this when the buttons appear is not the one that emptied the box (a slow send, an unrelated clear). */
const SEND_PRESS_MAX_AGE_MS = 2000

/** Now on the same clock as Event.timeStamp (milliseconds since the page's time origin). */
const now = () => performance.now()

/** How often the page notes it is running, how long without a note counts as frozen, and for how long after the send. */
const BEAT_MS = 50
const FROZEN_MS = 150
const WATCH_MS = 3000
/** A press handled this soon after a freeze ended may have been made during it. */
const AFTER_FREEZE_MS = 100
/** A stamp this close to when the press is handled may be the handling time, not when the press was made. */
const FRESH_MS = 20
/** A pointerdown's verdict is used for a click this soon after it (a press dragged off without a click leaves none behind). */
const PRESS_MAX_MS = 2000

/**
 * The earliest a press stamped `t` and handled at `handledAt` can have been made, given the page's freezes ([start, end]) and
 * its last note of running. A stamp well before its handling is the time the press was made, and is taken as it is.
 */
export function madeBy(
  t: number,
  handledAt: number,
  freezes: readonly (readonly [number, number])[],
  lastBeat: number,
  watching: boolean,
): number {
  if (handledAt - t > FRESH_MS) return t
  let made = t
  for (const [start, end] of freezes) if (t >= start && t <= end + AFTER_FREEZE_MS) made = Math.min(made, start)
  // frozen until just now, and the note that would record it has not run yet
  if (watching && t - lastBeat > FROZEN_MS) made = Math.min(made, lastBeat)
  return made
}

/** Whether a press that began at `t` is swallowed: before the buttons were shown, or within the moment after the send. */
export function swallows(t: number, shownAt: number, sentAt: number): boolean {
  if (shownAt < 0) return false
  return t < shownAt || t - sentAt < SEND_GUARD_MS
}

type Beat = { current: ReturnType<typeof setInterval> | undefined }
function stopWatch(beat: Beat) {
  clearInterval(beat.current)
  beat.current = undefined
}

/**
 * Handlers for an element around the buttons that replace Send, plus `sent(e)` for Send's own click. `canSend` is whether
 * Send shows: when it goes from shown to hidden, the buttons are about to be painted, and the moment starts at the Send press
 * (or, with no Send press just before, as when the text was sent with the Return key or deleted, at that change).
 */
export function useSendGuard(canSend: boolean) {
  const shownAt = useRef(-1)
  const sentAt = useRef(Number.NEGATIVE_INFINITY)
  const pressAt = useRef(Number.NEGATIVE_INFINITY)
  const was = useRef(canSend)
  // each pointer's verdict, for its pointerup; and the last pointerdown's, for the click that follows it
  const verdicts = useRef(new Map<number, boolean>())
  const lastDown = useRef<{ at: number; swallow: boolean } | null>(null)
  const freezes = useRef<[number, number][]>([])
  const lastBeat = useRef(0)
  const beat: Beat = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  useEffect(() => () => stopWatch(beat), [])
  useLayoutEffect(() => {
    if (was.current && !canSend) {
      // set before the new buttons are painted: no press that reaches them can have begun before this
      const t = now()
      shownAt.current = t
      sentAt.current = t - pressAt.current < SEND_PRESS_MAX_AGE_MS ? pressAt.current : t
      pressAt.current = Number.NEGATIVE_INFINITY // used once: a later Return-key send times from its own change
      stopWatch(beat)
      freezes.current = []
      lastBeat.current = t
      beat.current = setInterval(() => {
        const b = now()
        if (b - lastBeat.current > FROZEN_MS) freezes.current.push([lastBeat.current, b])
        lastBeat.current = b
        if (b - t > WATCH_MS) stopWatch(beat)
      }, BEAT_MS)
    }
    was.current = canSend
  }, [canSend])
  const judge = (t: number) =>
    swallows(
      madeBy(t, now(), freezes.current, lastBeat.current, beat.current !== undefined),
      shownAt.current,
      sentAt.current,
    )

  const block = (e: SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  // A press is judged when it begins; its pointerup follows that verdict, however late it is handled. A click is swallowed
  // when its pointerdown was, and is also judged by its own time: its pointerdown may have landed elsewhere (on Send, just
  // before it went), or there may be none (the keyboard, assistive tech).
  const onPointerDownCapture = (e: SyntheticEvent<Element, PointerEvent>) => {
    const swallow = judge(e.timeStamp)
    verdicts.current.set(e.nativeEvent.pointerId, swallow)
    lastDown.current = { at: e.timeStamp, swallow }
    if (swallow) block(e)
  }
  const onPointerUpCapture = (e: SyntheticEvent<Element, PointerEvent>) => {
    const id = e.nativeEvent.pointerId
    if (verdicts.current.get(id)) block(e)
    verdicts.current.delete(id)
  }
  const onClickCapture = (e: SyntheticEvent<Element, MouseEvent>) => {
    const down = lastDown.current
    lastDown.current = null
    const downSwallowed = down?.swallow === true && e.timeStamp - down.at < PRESS_MAX_MS
    if (downSwallowed || judge(e.timeStamp)) block(e)
  }
  return {
    handlers: { onPointerDownCapture, onPointerUpCapture, onClickCapture },
    /** Call from Send's click with its event: the moment is measured from this press. */
    sent: (e: SyntheticEvent) => {
      pressAt.current = e.timeStamp
    },
  }
}
