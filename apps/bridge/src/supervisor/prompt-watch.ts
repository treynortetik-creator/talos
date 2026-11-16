// When a prompt nobody named counts, and when a held needs-you flag is over: the Mac's PromptWatch and DialogAbsence
// (PromptDetector.swift), ported as they are. Fed once per look at a worker's pane; times are monotonic seconds.
import type { Prompt } from './dialog-reader.ts'

export type PromptChange = { kind: 'none' } | { kind: 'appeared'; prompt: Prompt } | { kind: 'cleared' }

const sameRows = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((r, i) => r === b[i])

/**
 * A prompt is announced after its region has held still for `settle` (the transcript above it may blink; the region does not
 * include that), once, however long it stays and wherever the owner moves the cursor; a different prompt in its place is
 * announced after its own wait. `hold` (an attached client typed lately: the owner's own picker, or the owner at the keys) starts
 * the wait over with every look. It is over when it has been gone for `clearAfter` (a redraw for a moment is not the end) or at
 * once when the idle input box is on screen (`idle`); one that comes back after that is a new one.
 */
export class PromptWatch {
  /** The prompt announced and not yet over. */
  current: Prompt | null = null
  private seen: Prompt | null = null
  private stillSince = 0
  private goneSince: number | null = null

  observe(
    p: Prompt | null,
    t: number,
    o: { settle?: number; clearAfter?: number; hold?: boolean; idle?: boolean } = {},
  ): PromptChange {
    const settle = o.settle ?? 5
    const clearAfter = o.clearAfter ?? 2
    if (!p) {
      this.seen = null
      if (!this.current) return { kind: 'none' }
      if (o.idle) {
        this.current = null
        this.goneSince = null
        return { kind: 'cleared' }
      }
      if (this.goneSince === null) this.goneSince = t
      if (t - this.goneSince < clearAfter) return { kind: 'none' }
      this.current = null
      this.goneSince = null
      return { kind: 'cleared' }
    }
    this.goneSince = null
    if (!sameRows(this.seen?.region, p.region)) {
      this.seen = p
      this.stillSince = t
    }
    if (o.hold) this.stillSince = t
    if (this.current && this.current.signature === p.signature) {
      this.current = p // the cursor moved or the footer changed: the same prompt
      return { kind: 'none' }
    }
    if (o.hold || t - this.stillSince < settle) return { kind: 'none' }
    this.current = p
    return { kind: 'appeared', prompt: p }
  }
}

/**
 * How long a pane has shown no dialog shape at all, repaints or not. A held needs-you flag clears when this says gone: a pane
 * whose status line repaints faster than `settle` never has a settled screen, so stillness cannot say it.
 */
export class DialogAbsence {
  private since: number | null = null

  /** `present`: a dialog or prompt shape is on the screen now. True once none has been for `settle`; a shape back starts over. */
  gone(present: boolean, t: number, settle: number): boolean {
    if (present) {
      this.since = null
      return false
    }
    if (this.since === null) this.since = t
    return t - this.since >= settle
  }

  reset(): void {
    this.since = null
  }
}
