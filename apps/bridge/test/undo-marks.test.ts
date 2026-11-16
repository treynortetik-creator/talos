// A message's undo point on its receipt (undo/marks.ts): sent only to a relay that says undo/1; one recorded after the
// receipt went, or replaced since (another folder), goes on a second `delivered` receipt; never one before delivery.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { UNDO_FEATURE } from '@talos-app/protocol'
import type { BridgeContext } from '../src/context.ts'
import { UndoMarks } from '../src/undo/marks.ts'
import { UndoPoints } from '../src/undo/points.ts'

function rig() {
  const db = new Database(':memory:')
  const points = new UndoPoints(db)
  const sent: Array<Record<string, unknown>> = []
  const ctx = {
    store: { db },
    clock: { now: () => Date.now() },
    transport: { sendEphemeral: (f: Record<string, unknown>) => sent.push(f) },
  } as unknown as BridgeContext
  const marks = new UndoMarks(ctx)
  marks.setRelayFeatures([UNDO_FEATURE])
  const record = (id: string, state: 'ready' | 'not_saved', replace = false) =>
    points.record(
      {
        message_id: id,
        thread_id: 'general',
        turn: id,
        snapshot:
          state === 'ready'
            ? { state: 'ready', kind: 'copy', root: '/tmp/x', path: '/tmp/undo/x' }
            : { state: 'not_saved', kind: 'copy', root: '/tmp/x', why: 'test' },
        at: Date.now(),
      },
      { replace },
    )
  return { marks, sent, record }
}
const M1 = 'm_01JBF3V7Q8K2M4N6P8R0S2T40Q'
const M2 = 'm_01JBF3V7Q8K2M4N6P8R0S2T40R'

describe('UndoMarks', () => {
  test('a point recorded before delivery rides on the receipt; nothing more is sent', () => {
    const { marks, sent, record } = rig()
    record(M1, 'ready')
    marks.recorded([M1]) // before delivery: nothing to send yet
    expect(sent).toHaveLength(0)
    expect(marks.delivered(M1)).toEqual({ state: 'ready' })
    marks.recorded([M1])
    expect(sent).toHaveLength(0)
  })

  test('one recorded after the receipt goes on a second delivered receipt, once', () => {
    const { marks, sent, record } = rig()
    expect(marks.delivered(M1)).toBeUndefined()
    record(M1, 'not_saved')
    marks.recorded([M1])
    marks.recorded([M1])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'receipt', message_id: M1, state: 'delivered', undo: { state: 'not_saved' } })
  })

  test('a point replaced after delivery is sent again with its new state', () => {
    const { marks, sent, record } = rig()
    record(M1, 'ready')
    marks.delivered(M1)
    record(M1, 'not_saved', true)
    marks.recorded([M1])
    expect(sent.map((f) => f.undo)).toEqual([{ state: 'not_saved' }])
  })

  test('never for a message not delivered, and nothing at all without undo/1', () => {
    const { marks, sent, record } = rig()
    record(M2, 'ready')
    marks.recorded([M2]) // recorded, never delivered: its own receipt will carry it
    expect(sent).toHaveLength(0)
    marks.setRelayFeatures(['schedules/1'])
    expect(marks.delivered(M2)).toBeUndefined()
    expect(marks.of(M2)).toBeUndefined()
    marks.recorded([M2])
    expect(sent).toHaveLength(0)
  })
})
