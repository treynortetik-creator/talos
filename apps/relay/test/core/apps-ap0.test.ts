// MCP Apps AP0, at the real relay: the headless post path takes app.update and refuses app rows. The relay-side app
// handling (routing, /media/:id/app) is AP2; this pins only what AP0's protocol change says about POST /bridge/post.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newUlid, signBridgeHttp } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: 20_000 })
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(import.meta.resolve(`@talos-app/protocol/fixtures/frames/${name}.json`)), 'utf8'),
  )
const fixtures = new Proxy({} as Record<string, Record<string, unknown>>, { get: (_t, name: string) => fixture(name) })

describe('AP0: POST /bridge/post and MCP app frames', () => {
  let relay: TestRelay
  afterEach(async () => relay?.stop())

  async function post(frame: Record<string, unknown>) {
    const body = JSON.stringify({ ...frame, id: newUlid(), ts: new Date().toISOString() })
    const authorization = await signBridgeHttp({
      privateKey: relay.bridgeKey.privateKey,
      keyId: relay.bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body,
    })
    return fetch(`${relay.httpBase}/bridge/post`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', authorization },
    })
  }
  const strip = (f: unknown) => {
    const { relay: _r, ...rest } = f as Record<string, unknown>
    return rest
  }

  it('accepts an app.update', async () => {
    relay = await startTestRelay()
    expect((await post(strip(fixtures['app.update']))).status).toBe(200)
  })

  it('refuses a view row and an echo row (live bridge only), and accepts the control reply', async () => {
    relay = await startTestRelay()
    expect((await post(strip(fixtures['reply.app_view']))).status).toBe(400)
    expect((await post(strip(fixtures['reply.app_echo']))).status).toBe(400)
    expect((await post(strip(fixtures.reply))).status).toBe(200)
  })

  it('refuses app.request and app.response here', async () => {
    relay = await startTestRelay()
    expect((await post(strip(fixtures['app.request']))).status).toBe(400)
    expect((await post(strip(fixtures['app.response']))).status).toBe(400)
  })
})
