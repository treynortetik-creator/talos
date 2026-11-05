// Option C at the relay (docs/OPTION-C.md): thread.session.control passes through like session.control; the last
// workers.status is kept for `ready` and fanned out ephemerally. The relay reads neither.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { register } from '../src/session/index.ts'
import { createFakeServices } from './helpers/fake-services.ts'

const fx = (n: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/protocol/fixtures/frames/${n}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>

function rig() {
  const f = createFakeServices()
  const extras: Array<() => Record<string, unknown>> = []
  ;(f.bus as unknown as { readyExtra: (fn: () => Record<string, unknown>) => void }).readyExtra = (fn) =>
    void extras.push(fn)
  register(f.services)
  return { ...f, ready: () => Object.assign({}, ...extras.map((e) => e())) }
}

describe('relay: Option C frames', () => {
  test('workers.status is kept for ready and fanned out ephemerally', async () => {
    const r = rig()
    const ws = fx('workers.status')
    await r.bus.injectBridgeFrame(ws)
    expect(r.ready()).toEqual({ workers_status: ws.status })
    expect(r.bus.toAppsLog.map((x) => x.frame.type)).toEqual(['workers.status'])
    expect(r.bus.toAppsLog[0]?.opts).toBeUndefined()
  })

  test('thread.session.control is queued durably for the bridge unchanged, once', async () => {
    const r = rig()
    r.bus.setBridgeOnline(true)
    const c = fx('thread.session.control')
    const replies = await r.bus.injectAppFrame(c, { deviceId: c.device_id as string })
    expect(replies[0]).toMatchObject({ type: 'ack', ref: c.id })
    expect(r.bus.toBridgeLog[0]?.frame).toBe(c)
    expect(r.bus.toBridgeLog[0]?.opts).toMatchObject({ durable: true })
    await r.bus.injectAppFrame(c, { deviceId: c.device_id as string })
    expect(r.bus.toBridgeLog).toHaveLength(1)
  })

  test('refused from another device, and mac_offline with the Mac away', async () => {
    const r = rig()
    const c = fx('thread.session.control')
    expect((await r.bus.injectAppFrame(c, { deviceId: 'd_aaaaaaaaaaaaaaaaaaaa' }))[0]).toMatchObject({
      type: 'error',
      code: 'unauthorized',
    })
    r.bus.setBridgeOnline(false)
    expect((await r.bus.injectAppFrame(c, { deviceId: c.device_id as string }))[0]).toMatchObject({
      type: 'error',
      code: 'mac_offline',
    })
  })
})
