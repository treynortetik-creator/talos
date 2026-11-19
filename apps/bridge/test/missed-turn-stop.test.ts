// The missed-turn resend is only for a response that really went missing. When the owner pressed Stop in the app (a `session.control`
// stop the mod answered "Stopped."), the turn ended because they ended it: no re-delivery, whatever the transcript's tail looks like.
// Real bridge, owner-signed control, ModLink and FakeMod; the request file is written as the Mac writes it.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModControlT } from '@talos-app/protocol'
import { FakeMod, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { STALL_BLANK_MIN_MS } from '../src/main-resend.ts'
import { type Harness, startHarness } from './helpers.ts'
import { signingLink } from './mod-sign.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function liveMod(x: Harness) {
  const mod = new FakeMod({ clock: fakeClock() })
  const link = signingLink(x.bridge.ctx.mod, () => Date.now())
  const file = () => readFileSync(x.bridge.ctx.paths.modKey, 'utf8').trim()
  expect(link.hello(file())).toEqual({ ok: true })
  const sync = () => {
    const r = link.sync(mod.syncRequest(file()))
    if (!r.ok) throw new Error(r.message)
    return r.response.controls
  }
  sync()
  return { mod, sync }
}

/** The owner presses Stop on `turn`: the control reaches the mod, which stops it. Resolves with the result frame. */
async function stop(x: Harness, m: Awaited<ReturnType<typeof liveMod>>, turn: string) {
  m.mod.engine.startTurn(turn)
  m.sync()
  const f = await x.app.sendSessionControl('general', { action: 'stop', turn_id: turn })
  let controls: ModControlT[] = []
  await waitFor(
    () => {
      controls = m.sync()
      return controls.length > 0
    },
    4000,
    'stop delivered',
  )
  await m.mod.execute(controls[0] as ModControlT)
  m.sync()
  return x.app.expectFrame('session.control.result', (r) => r.control_id === f.control_id, { timeoutMs: 4000 })
}

const request = (x: Harness, body: unknown) => writeFileSync(join(x.home, 'main-resend.json'), JSON.stringify(body))
const answer = (x: Harness) => JSON.parse(readFileSync(join(x.home, 'main-resend-result.json'), 'utf8'))
const look = (x: Harness, ms: number) =>
  x.bridge.ctx.seen.resendToMain(
    { paths: x.bridge.ctx.paths, log: nullLogger, clock: { now: () => Date.now() + ms } as never },
    async (n) => {
      x.notes.push(n)
    },
  )

test('delivery, then a Stop the mod carried out, then 90 s: the missed-turn request is refused as stopped, nothing is re-delivered', async () => {
  h = await startHarness()
  const infos: string[] = []
  const orig = h.bridge.ctx.log.info.bind(h.bridge.ctx.log)
  h.bridge.ctx.log.info = ((msg: string, f?: Record<string, unknown>) => {
    infos.push(`${msg} ${JSON.stringify(f ?? {})}`)
    return orig(msg, f as never)
  }) as never
  const m = await liveMod(h)
  await h.app.sendMessage('general', 'are you there')
  await h.waitNotes(1)
  const at = h.bridge.ctx.seen.oldestUnseenAt()
  await sleep(5)
  expect(await stop(h, m, 'turn_1')).toMatchObject({ ok: true })
  // the one log line a check can read, with the thread and the time and no message content
  const line = infos.find((l) => l.startsWith('session control: stopped by owner'))
  expect(line).toBeDefined()
  expect(line).toContain('"thread_id"')
  expect(line).toContain('"at"')
  expect(line).not.toContain('are you there')
  expect(h.bridge.ctx.seen.lastStopAt()).not.toBeNull()
  // the owner sees it in the thread
  const row = await h.relay.expectFrame(
    'reply',
    (f) => f.message.author === 'system' && f.message.text === 'You stopped your agent',
    { timeoutMs: 4000 },
  )
  expect(row.message.thread_id).toBeDefined()
  request(h, { v: 1, unseen_at: at, missed: true })
  expect(await look(h, STALL_BLANK_MIN_MS + 1000)).toBe(0)
  expect(answer(h)).toMatchObject({ outcome: 'failed', why: 'stopped', delivered: 0 })
  expect(h.notes.filter((n) => n.meta.kind === 'text')).toHaveLength(1)
  expect(existsSync(join(h.home, 'main-resend.json'))).toBe(false)
})

test('a Stop for an EARLIER turn does not suppress a later genuine miss', async () => {
  h = await startHarness()
  const m = await liveMod(h)
  expect(await stop(h, m, 'turn_1')).toMatchObject({ ok: true })
  await sleep(20)
  await h.app.sendMessage('general', 'a later message')
  await h.waitNotes(1)
  const at = h.bridge.ctx.seen.oldestUnseenAt()
  request(h, { v: 1, unseen_at: at, missed: true })
  expect(await look(h, STALL_BLANK_MIN_MS)).toBe(1)
  expect(answer(h)).toMatchObject({ outcome: 'sent' })
})

test('a Stop the bridge refused (a turn that is gone) stopped nothing, so it suppresses nothing', async () => {
  h = await startHarness()
  const m = await liveMod(h)
  await h.app.sendMessage('general', 'hello')
  await h.waitNotes(1)
  const at = h.bridge.ctx.seen.oldestUnseenAt()
  m.mod.engine.startTurn('turn_2')
  m.sync()
  const f = await h.app.sendSessionControl('general', { action: 'stop', turn_id: 'turn_1' })
  expect(
    await h.app.expectFrame('session.control.result', (r) => r.control_id === f.control_id, { timeoutMs: 4000 }),
  ).toMatchObject({
    ok: false,
    code: 'turn_mismatch',
  })
  expect(h.bridge.ctx.seen.lastStopAt()).toBeNull()
  request(h, { v: 1, unseen_at: at, missed: true })
  expect(await look(h, STALL_BLANK_MIN_MS)).toBe(1)
})

test('the stop is in status.json as a time only, and survives a restart of the tracker', async () => {
  h = await startHarness()
  const m = await liveMod(h)
  expect(await stop(h, m, 'turn_1')).toMatchObject({ ok: true })
  const t = h.bridge.ctx.seen.lastStopAt()
  expect(t).not.toBeNull()
  expect(h.bridge.ctx.store.kvGet('last_stop_at')).toBe(String(Date.parse(t as string)))
  const { SeenTracker } = await import('../src/context.ts')
  const fresh = new SeenTracker()
  fresh.restoreStop(h.bridge.ctx.store.kvGet('last_stop_at'))
  expect(fresh.lastStopAt()).toBe(t)
})
