// The sink that holds the Mac's first frames until xterm has loaded (src/features/terminal/remote/buffered.ts): held in order, played
// once, and never allowed to grow without bound when xterm does not load.
import { describe, expect, it, vi } from 'vitest'
import { bufferedSink } from '../../src/features/terminal/remote/buffered.ts'

const real = () => {
  const ops: string[] = []
  return {
    ops,
    sink: {
      write: (b: Uint8Array, done: () => void) => {
        ops.push(`w:${b.length}`)
        done()
      },
      reset: () => void ops.push('reset'),
      resize: (c: number, r: number) => void ops.push(`size:${c}x${r}`),
    },
  }
}

describe('bufferedSink', () => {
  it('plays what was held, in order, once the terminal is there; after that it passes straight through', () => {
    const b = bufferedSink(1000, () => {})
    const t = real()
    b.sink.resize(80, 24)
    b.sink.reset()
    b.sink.write(new Uint8Array(5), () => {})
    b.attach(t.sink)
    expect(t.ops).toEqual(['size:80x24', 'reset', 'w:5'])
    b.sink.write(new Uint8Array(2), () => {})
    expect(t.ops.at(-1)).toBe('w:2')
  })

  it('holds no more than its limit: past it, it says so once, drops what follows, and plays nothing late', () => {
    const over = vi.fn()
    const b = bufferedSink(100, over)
    b.sink.write(new Uint8Array(60), () => {})
    b.sink.write(new Uint8Array(60), () => {})
    b.sink.write(new Uint8Array(60), () => {})
    expect(over).toHaveBeenCalledTimes(1)
    const t = real()
    b.attach(t.sink)
    expect(t.ops).toEqual([]) // an overflowed buffer is not a partial picture
  })

  it('detach forgets what it held', () => {
    const b = bufferedSink(100, () => {})
    b.sink.write(new Uint8Array(5), () => {})
    b.detach()
    const t = real()
    b.attach(t.sink)
    expect(t.ops).toEqual([])
  })
})
