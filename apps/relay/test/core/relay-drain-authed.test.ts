// The sockets that matter at a deploy are the signed-in bridge and the app: the hub closes those itself when the relay stops,
// so the hub must say 1012 too, or the clients never see "restarting" and wait out their backoff (review of 56c43223: they got
// 1001). Real relay, real sockets.
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTestRelay, type TestRelay } from './harness.ts'
import { silentBridge } from './helpers.ts'

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop().catch(() => {})
  relay = null
})

describe('a stopping relay tells live clients it is restarting', () => {
  it('the signed-in bridge and an app socket both get 1012 "restarting"', async () => {
    const r = await startTestRelay()
    relay = r
    const b = await silentBridge(r, r.bridgeKey)
    const bridgeClosed = new Promise<[number, string]>((res) => b.ws.on('close', (c, why) => res([c, why.toString()])))
    const app = new WebSocket(`${r.wsBase}/ws`, { headers: r.appHeaders })
    await new Promise((res, rej) => {
      app.on('open', res)
      app.on('error', rej)
    })
    const appClosed = new Promise<[number, string]>((res) => app.on('close', (c, why) => res([c, why.toString()])))
    await r.stop()
    relay = null
    expect(await bridgeClosed).toEqual([1012, 'restarting'])
    expect(await appClosed).toEqual([1012, 'restarting'])
  }, 30_000)
})
