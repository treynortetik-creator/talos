// A made-up pane for the terminal service's tests: the test says what the pane printed (`emit`), what its screen looks like for a
// keyframe (`screen`), and when it ends or changes size. It has no way to write to a pane, like the real source.
import type { OpenSource, PaneSource } from '../../src/term/control.ts'

const enc = new TextEncoder()

export class FakeSource implements PaneSource {
  paneId = '%0'
  closed = false
  snapshots = 0
  total = 0
  /** What a keyframe carries (the screen as bytes); the test sets it. */
  screen = enc.encode('SCREEN')
  /** When set, `snapshot()` waits for this to be called: output can arrive while a keyframe is on its way. */
  hold: (() => void) | null = null
  private gate: Promise<void> | null = null
  private out: Array<(d: Uint8Array) => void> = []
  private resizes: Array<(s: { cols: number; rows: number }) => void> = []
  private ends: Array<(w: 'pane_gone' | 'error') => void> = []
  constructor(
    public cols = 100,
    public rows = 30,
  ) {}

  size() {
    return { cols: this.cols, rows: this.rows }
  }
  offset() {
    return this.total
  }
  onOutput(cb: (d: Uint8Array) => void) {
    this.out.push(cb)
  }
  onResize(cb: (s: { cols: number; rows: number }) => void) {
    this.resizes.push(cb)
  }
  onEnd(cb: (w: 'pane_gone' | 'error') => void) {
    this.ends.push(cb)
  }
  async snapshot() {
    this.snapshots++
    const at = this.total
    if (this.gate) await this.gate
    return { at, bytes: this.screen }
  }
  close() {
    this.closed = true
  }

  /** The pane prints `data` (a string or bytes). */
  emit(data: string | Uint8Array) {
    const b = typeof data === 'string' ? enc.encode(data) : data
    this.total += b.length
    for (const cb of this.out) cb(b)
  }
  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    for (const cb of this.resizes) cb({ cols, rows })
  }
  end(why: 'pane_gone' | 'error' = 'pane_gone') {
    for (const cb of this.ends) cb(why)
  }
  /** The next snapshot waits until `release()`. */
  holdSnapshots() {
    this.gate = new Promise<void>((r) => {
      this.hold = () => {
        this.gate = null
        r()
      }
    })
  }
}

/** An opener that hands out one FakeSource per session, remembering them; `fail` makes a session have no pane. */
export function fakeOpener(opts: { fail?: Set<string>; cols?: number; rows?: number; hold?: boolean } = {}) {
  const made: Array<{ session: string; source: FakeSource }> = []
  const open: OpenSource = async (session) => {
    if (opts.fail?.has(session)) return { error: 'no_pane' }
    const source = new FakeSource(opts.cols, opts.rows)
    if (opts.hold) source.holdSnapshots() // its first keyframe waits for `release`
    made.push({ session, source })
    return source
  }
  return { open, made, last: () => made[made.length - 1]?.source as FakeSource }
}
