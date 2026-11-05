// Adversarial review of PR #32 (Claude Code C0): checks the "only the live bridge mints kind:'permission'" claim at the
// real relay. These PASS on feat/cc-c0; they pin the behaviour so a later WP can't loosen it.
import { bindingFrom, composePermissionCard, newUlid, payloadHash, signBridgeHttp } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: 20_000 })

const permissionCard = () =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'List files',
      input_preview: '{"command": "ls"}',
    },
    card_id: `c_${newUlid()}`,
    thread_id: 'general',
    now: Date.now(),
  })

describe('review C0: headless POST /bridge/post cannot mint a permission card', () => {
  let relay: TestRelay
  afterEach(async () => relay?.stop())

  it('a correctly hashed kind:permission card.create is refused with 400', async () => {
    relay = await startTestRelay()
    const body = JSON.stringify({
      v: 1,
      type: 'card.create',
      id: newUlid(),
      ts: new Date().toISOString(),
      card: permissionCard(),
    })
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
    expect(res.status).toBe(400)
  })

  it('control: the same card as kind:generic is accepted, so the 400 above is the kind check', async () => {
    relay = await startTestRelay()
    const p = permissionCard()
    const g = { ...p, kind: 'generic' as const, warning: undefined }
    const c = { ...g, payload_hash: payloadHash(bindingFrom(g)) }
    const body = JSON.stringify({ v: 1, type: 'card.create', id: newUlid(), ts: new Date().toISOString(), card: c })
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
    expect(res.status).toBe(200)
  })

  it('an unknown future kind is refused too (allowlist, not denylist)', async () => {
    relay = await startTestRelay()
    const c = { ...permissionCard(), kind: 'brand_new' }
    const body = JSON.stringify({ v: 1, type: 'card.create', id: newUlid(), ts: new Date().toISOString(), card: c })
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
    expect(res.status).toBe(400)
  })
})
