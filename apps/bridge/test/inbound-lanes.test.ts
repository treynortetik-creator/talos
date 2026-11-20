// lanePlan (inbound-lanes.ts): which lane a frame waits on behind an owner message's undo point.
import { describe, expect, test } from 'bun:test'
import { lanePlan, MAIN_LANE } from '../src/inbound-lanes.ts'
import type { Item } from '../src/inbound-shared.ts'

const thread = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kind: 'fixed', ...extra })
const ctx = (cardKind?: string) =>
  ({
    config: {
      config: {
        threads: [thread('general'), thread('trip', { session: 'dedicated' })],
        default_thread: 'general',
        dedicated: { enabled: true },
      },
    },
    ledger: { get: () => (cardKind ? { thread_id: 'trip', binding: { kind: cardKind } } : undefined) },
  }) as never
const item = (frame: Record<string, unknown>) => ({ frame, raw: {} }) as unknown as Item

describe('lanePlan', () => {
  test("a session control waits on main's lane as well as its thread's (it acts on main's session)", () => {
    expect(lanePlan(ctx(), item({ type: 'session.control', thread_id: 'trip' }))).toEqual({
      keys: [MAIN_LANE, 'trip'],
      always: false,
    })
  })
  test('an answer to a card that changes settings waits for every lane', () => {
    expect(lanePlan(ctx('config'), item({ type: 'card.resolve', card_id: 'c_1' }))).toBe('barrier')
    expect(lanePlan(ctx('generic'), item({ type: 'card.resolve', card_id: 'c_1' }))).toEqual({
      keys: ['trip'],
      always: false,
    })
  })
  test("an integration event keeps its place behind main's messages", () => {
    expect(lanePlan(ctx(), item({ type: 'hook.event' }))).toEqual({ keys: [MAIN_LANE], always: false, anyBusy: true })
  })
  test('an answer to an undo card always waits its turn on its session (it rewrites the files that session works on)', () => {
    expect(lanePlan(ctx('undo'), item({ type: 'card.resolve', card_id: 'c_1' }))).toEqual({
      keys: ['trip'],
      always: true,
    })
  })
})
