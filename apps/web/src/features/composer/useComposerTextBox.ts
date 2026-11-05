// The text box element: auto-grow, and reading back words that reached it without a React event.
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { followsInsert } from './followInsert.ts'

export function useComposerTextBox(o: {
  taRef: RefObject<HTMLTextAreaElement | null>
  text: string
  setText: Dispatch<SetStateAction<string>>
  /** The box is not on screen while recording; it is drawn again from `text` when the recording ends. */
  recording: boolean
}) {
  const { taRef, text, setText, recording } = o
  // Auto-grow to 6 lines, and keep the caret in sight: text added with the caret at the end (dictation, a paste, a tool
  // writing the value) scrolls to the end. An edit anywhere else leaves the view exactly where it was. The cap is read
  // from the box's own line height and padding, so it stays 6 lines when the owner picks a larger text size (a fixed
  // pixel cap would be 4 lines at Largest).
  const shownText = useRef('')
  const drawnValue = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: text drives the height
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const line = Number.parseFloat(cs.lineHeight)
    const lineH = Number.isFinite(line) ? line : 24
    const pad = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0)
    ta.style.height = `${Math.min(ta.scrollHeight, 6 * lineH + pad)}px`
    if (followsInsert(ta, shownText.current, text)) ta.scrollTop = ta.scrollHeight
    shownText.current = text
    drawnValue.current = ta.value
  }, [text, recording])

  // Dictation and accessibility tools can change the box without a React event. The element is the truth: read it.
  // Only a value React did not draw counts as a change from outside. An element still holding what React last drew
  // has nothing new to report: a pending update (the box cleared by a send, a prefill) has not reached it yet, and
  // reading it back would undo that update. Refocusing during a send fires this before the cleared text is drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: taRef and setText are stable; the list is kept as it was
  const syncFromDom = useCallback(() => {
    const v = taRef.current?.value
    if (v === undefined || v === drawnValue.current) return
    setText((cur) => (cur === v ? cur : v))
  }, [])

  // A tool that writes the value straight on the element fires no event at all. While the box has focus, notice a value
  // React did not draw. Comparing with what was last drawn (not with state) keeps a prefill that is still committing safe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: taRef is stable; the list is kept as it was
  useEffect(() => {
    const id = setInterval(() => {
      const ta = taRef.current
      if (ta && document.activeElement === ta && ta.value !== drawnValue.current) syncFromDom()
    }, 200)
    return () => clearInterval(id)
  }, [syncFromDom])

  // Dictation tools only paste into a focused editable element, so the box keeps focus through a send. Not on phones:
  // refocusing there would pop the keyboard back up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: taRef is stable; the list is kept as it was
  const keepFocus = useCallback(() => {
    if (window.matchMedia?.('(pointer: coarse)').matches) return
    taRef.current?.focus({ preventScroll: true })
  }, [])

  // The words were taken off the element: empty it now, so a refocus or a poll before the cleared text is drawn cannot
  // read them back (an event-less write is not in React's state, so the cleared state alone may not redraw the box).
  // biome-ignore lint/correctness/useExhaustiveDependencies: taRef is stable; the list is kept as it was
  const emptyBox = useCallback(() => {
    if (taRef.current) taRef.current.value = ''
    drawnValue.current = ''
  }, [])

  return { syncFromDom, keepFocus, emptyBox }
}
