// The second delivery of an owner message to Main, asked for by the Mac's stall watchdog (src/main-resend.ts). Real Bridge + FakeRelay +
// FakeApp: a real owner message reaches the agent's channel, the request file is written as the Mac writes it, and the bridge's own
// poll acts on it. Pinned: the same notice goes out again by the same path (once), a request for a message already read, for a
// different time, from a damaged file or for a second time does nothing, and a refusal is never silent.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_RESTART } from '@talos-app/protocol'
import { nullLogger } from '../src/log.ts'
import {
  holdOwnerNotice,
  newResendMemory,
  parseRequest,
  REDELIVERED_PREFIX,
  redelivered,
  STALL_BLANK_MIN_MS,
  STALL_MIN_MS,
} from '../src/main-resend.ts'
import type { Notification } from '../src/notify.ts'
import { type Harness, startHarness } from './helpers.ts'
import { longTimeouts } from './schedules/harness.ts'

longTimeouts()

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const request = (x: Harness, body: unknown) =>
  writeFileSync(join(x.home, 'main-resend.json'), typeof body === 'string' ? body : JSON.stringify(body))
const ids = (x: Harness, id: string) => x.notes.filter((n) => n.meta.message_id === id)

const result = (x: Harness) => {
  const f = join(x.home, 'main-resend-result.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}
/** The bridge's own look at the request file, as its poll does it, with its clock `ms` ahead (a message that has waited that long). */
const look = (x: Harness, ms: number, deliver?: (n: Notification) => Promise<void>) =>
  x.bridge.ctx.seen.resendToMain(
    { paths: x.bridge.ctx.paths, log: nullLogger, clock: { now: () => Date.now() + ms } as never },
    deliver ??
      (async (n) => {
        x.notes.push(n)
      }),
  )
const STALLED = STALL_MIN_MS + 1000

test('the bridge age check is the spinner wait by default and the shorter one only for a blank-pane request', () => {
  expect(STALL_MIN_MS).toBe(MAIN_RESTART.model_stall_s * 1000)
  expect(STALL_BLANK_MIN_MS).toBe(MAIN_RESTART.model_stall_blank_s * 1000)
  expect(STALL_BLANK_MIN_MS).toBeLessThan(STALL_MIN_MS)
})

describe('main resend: the Mac asks, the bridge delivers the stalled owner messages once more', () => {
  test('a stalled message goes out again, the same notice, once; the file is gone and the answer says sent', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'are you there')
    await h.waitNotes(1)
    const first = h.notes[0]
    const id = first?.meta.message_id as string
    const unseen = h.bridge.ctx.seen.oldestUnseenAt()
    request(h, { v: 1, unseen_at: unseen })
    expect(await look(h, STALLED)).toBe(1)
    expect(ids(h, id)).toHaveLength(2)
    // the same message, owner trust and ids, marked as a resend (a normal delivery carries no marker)
    expect(first?.meta.redelivered).toBeUndefined()
    expect(ids(h, id)[1]?.meta).toEqual({ ...first?.meta, redelivered: 'stall' } as never)
    expect(ids(h, id)[1]?.content).toBe(`${REDELIVERED_PREFIX}\n${first?.content}`)
    expect(ids(h, id)[1]?.meta.trust).toBe(first?.meta.trust)
    expect(existsSync(join(h.home, 'main-resend.json'))).toBe(false)
    expect(result(h)).toMatchObject({ v: 1, unseen_at: unseen, outcome: 'sent', delivered: 1 })
    // a second request for the same message (a retry, a second process) is refused: one winner
    request(h, { v: 1, unseen_at: unseen })
    expect(await look(h, STALLED)).toBe(0)
    expect(ids(h, id)).toHaveLength(2)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'already' })
  })

  test('R1-1: only what arrived since Main last read is sent again, never a message it already took in', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'delete the draft')
    await h.waitNotes(1)
    const old = h.notes[0]?.meta.message_id as string
    await h.bridge.callTool('set_status', { thread_id: 'general', state: 'working' }) // Main acts on it: any tool call is reading
    expect(h.bridge.ctx.seen.oldestUnseenAt()).toBeNull()
    await h.app.sendMessage('general', 'and hello')
    await h.waitNotes(2)
    const fresh = h.notes[1]?.meta.message_id as string
    expect(fresh).not.toBe(old)
    expect(h.bridge.ctx.seen.unseenIds()).toEqual([fresh])
    request(h, { v: 1, unseen_at: h.bridge.ctx.seen.oldestUnseenAt() })
    expect(await look(h, STALLED)).toBe(1)
    expect(ids(h, old)).toHaveLength(1)
    expect(ids(h, fresh)).toHaveLength(2)
  })

  test('R1-1: a tool call that names no thread also ends what Main has seen', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'first')
    await h.waitNotes(1)
    h.bridge.ctx.seen.toolCalled() // Main called some tool: everything told so far is read
    expect(h.bridge.ctx.seen.unseenIds()).toEqual([])
    await h.app.sendMessage('general', 'second')
    await h.waitNotes(2)
    expect(h.bridge.ctx.seen.unseenIds()).toEqual([h.notes[1]?.meta.message_id as string])
  })

  test('R1-3: a request for a message that has not waited long enough is refused, whoever wrote it', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'just now')
    await h.waitNotes(1)
    request(h, { v: 1, unseen_at: h.bridge.ctx.seen.oldestUnseenAt() })
    await h.bridge.poll() // the real poll, the real clock: the message is seconds old
    expect(h.notes.filter((n) => n.meta.kind === 'text')).toHaveLength(1)
    expect(existsSync(join(h.home, 'main-resend.json'))).toBe(false)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'too_early', delivered: 0 })
    // and once it has waited, the same request would be acted on
    request(h, { v: 1, unseen_at: h.bridge.ctx.seen.oldestUnseenAt() })
    expect(await look(h, STALLED)).toBe(1)
  })

  test('R3-2: 90 s is enough only when the request says it is the blank-pane case; without the flag the window stays 180 s', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'frozen with no spinner')
    await h.waitNotes(1)
    const at = h.bridge.ctx.seen.oldestUnseenAt()
    const BLANK_ONLY = STALL_BLANK_MIN_MS + 1000
    request(h, { v: 1, unseen_at: at })
    expect(await look(h, BLANK_ONLY)).toBe(0)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'too_early' })
    request(h, { v: 1, unseen_at: at, blank: 'yes' }) // only a real true counts
    expect(await look(h, BLANK_ONLY)).toBe(0)
    request(h, { v: 1, unseen_at: at, blank: true })
    expect(await look(h, STALL_BLANK_MIN_MS - 1000)).toBe(0) // not even the blank wait
    request(h, { v: 1, unseen_at: at, blank: true })
    expect(await look(h, BLANK_ONLY)).toBe(1)
    expect(result(h)).toMatchObject({ outcome: 'sent' })
  })

  test('missed turn: `missed: true` is accepted at 90 s and not at 89 s; a stray value or a missing flag keeps the 180 s window', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'answered by an empty thinking block')
    await h.waitNotes(1)
    const at = h.bridge.ctx.seen.oldestUnseenAt()
    request(h, { v: 1, unseen_at: at, missed: true })
    expect(await look(h, STALL_BLANK_MIN_MS - 1000)).toBe(0) // 89 s
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'too_early' })
    request(h, { v: 1, unseen_at: at, missed: 'yes' }) // only a real true counts
    expect(await look(h, STALL_BLANK_MIN_MS + 1000)).toBe(0)
    request(h, { v: 1, unseen_at: at, missed: true })
    expect(await look(h, STALL_BLANK_MIN_MS)).toBe(1) // exactly 90 s
    expect(result(h)).toMatchObject({ outcome: 'sent', delivered: 1 })
    request(h, { v: 1, unseen_at: at, missed: true }) // once per message
    expect(await look(h, STALLED)).toBe(0)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'already' })
  })

  test('a missed-turn resend is marked missed, a stall resend stall, and the held original is never changed', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'did you get this')
    await h.waitNotes(1)
    const first = h.notes[0] as Notification
    const copy = structuredClone(first)
    request(h, { v: 1, unseen_at: h.bridge.ctx.seen.oldestUnseenAt(), missed: true })
    expect(await look(h, STALL_BLANK_MIN_MS)).toBe(1)
    const again = h.notes[1] as Notification
    expect(again.meta.redelivered).toBe('missed')
    expect(again.content.startsWith(REDELIVERED_PREFIX)).toBe(true)
    expect(again.meta.message_id).toBe(first.meta.message_id)
    expect(first).toEqual(copy) // the first delivery is untouched
    expect(redelivered(first, 'stall').meta.redelivered).toBe('stall')
    // the marked copy is never kept as the original
    const m = newResendMemory()
    holdOwnerNotice(m, again)
    expect(m.held.size).toBe(0)
  })

  test('missed turn: a message that is not the oldest unseen one is refused, whatever the flag', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'first')
    await h.waitNotes(1)
    const first = h.bridge.ctx.seen.oldestUnseenAt()
    await h.app.sendMessage('general', 'second')
    await h.waitNotes(2)
    const second = new Date(Date.parse(first as string) + 5).toISOString()
    request(h, { v: 1, unseen_at: second, missed: true })
    expect(await look(h, STALLED)).toBe(0)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'not_oldest' })
    expect(h.notes.filter((n) => n.meta.kind === 'text')).toHaveLength(2)
  })

  test('R1-2: a message that is no longer held, or a delivery that fails, is answered failed, never sent', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'one')
    await h.waitNotes(1)
    const at = h.bridge.ctx.seen.oldestUnseenAt()
    request(h, { v: 1, unseen_at: at })
    expect(await look(h, STALLED, () => Promise.reject(new Error('stopping')))).toBe(0)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'delivery_failed', delivered: 0 })
    ;(h.bridge.ctx.seen as unknown as { resend: { done: number[]; held: Map<string, unknown> } }).resend.done.length = 0
    ;(h.bridge.ctx.seen as unknown as { resend: { held: Map<string, unknown> } }).resend.held.clear()
    request(h, { v: 1, unseen_at: at })
    expect(await look(h, STALLED)).toBe(0)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'not_held', delivered: 0 })
  })

  test('a message Main has read since is not sent again', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'a question')
    await h.waitNotes(1)
    const unseen = h.bridge.ctx.seen.oldestUnseenAt()
    await h.bridge.callTool('reply', { thread_id: 'general', text: 'the answer' }) // any tool call is Main reading
    expect(h.bridge.ctx.seen.oldestUnseenAt()).toBeNull()
    request(h, { v: 1, unseen_at: unseen })
    expect(await look(h, STALLED)).toBe(0)
    expect(h.notes.filter((n) => n.meta.kind === 'text')).toHaveLength(1)
    expect(existsSync(join(h.home, 'main-resend.json'))).toBe(false)
    expect(result(h)).toMatchObject({ outcome: 'failed', why: 'not_oldest' })
  })

  test('a request naming another time, a damaged file or an unknown version delivers nothing', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'hello')
    await h.waitNotes(1)
    for (const body of [
      { v: 1, unseen_at: '2020-01-01T00:00:00.000Z' },
      { v: 2, unseen_at: h.bridge.ctx.seen.oldestUnseenAt() },
      { v: 1 },
      '{"v":1,"unseen_at":',
      '[1]',
      { v: 1, unseen_at: 'not a time' },
    ]) {
      request(h, body)
      expect(await look(h, STALLED)).toBe(0)
      expect(existsSync(join(h.home, 'main-resend.json'))).toBe(false)
    }
    expect(h.notes.filter((n) => n.meta.kind === 'text')).toHaveLength(1)
  })

  test('only the owner words the bridge itself delivered are held: a card tap, a system line or an external notice is never sent again', () => {
    const m = newResendMemory()
    for (const [id, trust, kind] of [
      ['own', 'owner', 'text'],
      ['tap', 'owner', 'card_action'],
      ['sys', 'system', 'system'],
      ['ext', 'external', 'text'],
    ] as const)
      holdOwnerNotice(m, { content: 'x', meta: { message_id: id, trust, kind } })
    expect([...m.held.keys()]).toEqual(['own'])
  })

  test("the request parser accepts the Mac's form and refuses the rest", () => {
    expect(parseRequest('{"blank":true,"unseen_at":"2026-11-19T02:48:27.675Z","v":1}')?.blank).toBe(true)
    expect(parseRequest('{"unseen_at":"2026-11-19T02:48:27.675Z","v":1}')).toEqual({
      blank: false,
      missed: false,
      unseenAt: Date.parse('2026-11-19T02:48:27.675Z'),
    })
    for (const bad of [
      '',
      'null',
      '[]',
      '{"v":1}',
      '{"v":"1","unseen_at":"2026-11-19T02:48:27.675Z"}',
      '{"v":1,"unseen_at":5}',
    ])
      expect(parseRequest(bad)).toBeNull()
  })
})
