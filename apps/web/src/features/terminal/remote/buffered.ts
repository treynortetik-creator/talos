// A TermSink that holds what it is told until the real terminal (xterm, loaded by dynamic import) is there, then plays it in order.
// The Mac's first frames can beat the download.
import type { TermSink } from './session.ts'

/**
 * `limit` bytes of output may be held; past that `onOverflow` is told once, everything held is dropped and so is whatever follows
 * (a partial picture is worse than none), so a terminal that never loads cannot make the page's memory grow.
 */
export function bufferedSink(
  limit: number,
  onOverflow: () => void,
): { sink: TermSink; attach(real: TermSink): void; detach(): void } {
  let real: TermSink | null = null
  let held: Array<(s: TermSink) => void> = []
  let bytes = 0
  let overflowed = false
  const run = (op: (s: TermSink) => void, size = 0) => {
    if (real) return op(real)
    if (overflowed) return
    bytes += size
    if (bytes > limit) {
      overflowed = true
      held = []
      return onOverflow()
    }
    held.push(op)
  }
  return {
    sink: {
      write: (b, done) => run((s) => s.write(b, done), b.length),
      reset: () => run((s) => s.reset()),
      resize: (c, r) => run((s) => s.resize(c, r)),
    },
    attach(s) {
      real = s
      for (const op of held.splice(0)) op(s)
    },
    detach() {
      real = null
      held = []
      bytes = 0
      overflowed = false
    },
  }
}
