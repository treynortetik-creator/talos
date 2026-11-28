// An ack that says the Mac applied a Save from the schedule form is passed on to the form before the wait ends; every other ack is
// handled exactly as it was (nothing emitted).
import { describe, expect, it, vi } from 'vitest'
import { onAck } from '../../src/lib/socket-frames-delivery.ts'

function ctx() {
  const emit = vi.fn()
  const resolve = vi.fn()
  const order: string[] = []
  emit.mockImplementation(() => order.push('emit'))
  resolve.mockImplementation(() => order.push('resolve'))
  const pending = new Map([
    ['01JAAAAAAAAAAAAAAAAAAAAAA1', { resolve, reject: vi.fn(), timer: setTimeout(() => {}, 0) }],
  ])
  return { c: { pending, onAcked: vi.fn(async () => {}), emit } as never, emit, resolve, order }
}
const ack = (extra: Record<string, unknown> = {}) =>
  ({
    v: 1,
    type: 'ack',
    id: '01JAAAAAAAAAAAAAAAAAAAAAA2',
    ts: new Date().toISOString(),
    ref: '01JAAAAAAAAAAAAAAAAAAAAAA1',
    ...extra,
  }) as never

describe('onAck and applied', () => {
  it('emits an applied ack, before it settles the wait', () => {
    const x = ctx()
    onAck(x.c, ack({ applied: true }))
    expect(x.order).toEqual(['emit', 'resolve'])
  })
  it('emits nothing for a plain ack (an older Mac, or any other frame)', () => {
    const x = ctx()
    onAck(x.c, ack())
    expect(x.emit).not.toHaveBeenCalled()
    expect(x.resolve).toHaveBeenCalledTimes(1)
  })
})
