// Independent review of PR #84: POST /bridge/post validates a parsed copy (where a bad `app` reads as absent) but
// stores and fans out the RAW body, so an `app` object rides into the event log and to every app on a headless post.
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

describe('review: headless POST /bridge/post never stores an app view', () => {
  let relay: TestRelay
  afterEach(async () => relay?.stop())

  it('an agent text row carrying a (schema-invalid) app view is refused, not stored raw', async () => {
    relay = await startTestRelay()
    const { relay: _r, ...reply } = fixture('reply')
    const view = structuredClone((fixture('reply.app_view').message as { app: Record<string, unknown> }).app)
    view.label = 'x'.repeat(61) // one char over: this build reads the view as absent; a looser build would render it
    const id = newUlid()
    const message = { ...(reply.message as Record<string, unknown>), app: view }
    const body = JSON.stringify({ ...reply, message, id, ts: new Date().toISOString() })
    const authorization = await signBridgeHttp({
      privateKey: relay.bridgeKey.privateKey,
      keyId: relay.bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body,
    })
    const res = await fetch(`${relay.httpBase}/bridge/post`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', authorization },
    })
    const stored = relay.runtime.store.getEventByFrameId(id) as { message?: { app?: unknown } } | null
    expect(stored?.message?.app).toBeUndefined()
    expect(res.status).toBe(400)
  })
})
