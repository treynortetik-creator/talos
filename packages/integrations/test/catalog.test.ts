import { IntegrationId, SetupSpec } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { catalog, getIntegration, listSetupSpecs } from '../src/index.ts'

describe('integration catalog (seam)', () => {
  it('has exactly one module per IntegrationId, keyed by its own id', () => {
    expect(Object.keys(catalog).sort()).toEqual([...IntegrationId.options].sort())
    for (const id of IntegrationId.options) expect(getIntegration(id).id).toBe(id)
  })
  it('every setup spec is valid', () => {
    for (const s of listSetupSpecs()) expect(SetupSpec.safeParse(s).success, s.id).toBe(true)
  })
  it('work sources are the five in spec 7.5 and route to the work thread', () => {
    const work = listSetupSpecs()
      .filter((s) => s.category === 'work')
      .map((s) => s.id)
      .sort()
    expect(work).toEqual(['gmail_work', 'jira', 'salesforce', 'slack', 'zoom'])
    for (const s of listSetupSpecs()) expect(s.default_thread).toBe(s.category === 'work' ? 'work' : 'inbox')
  })
  it('every module refuses a delivery with no headers, whether or not it has a secret, and none is a stub', async () => {
    const req = { headers: {}, rawBody: new Uint8Array(), url: 'https://relay.example.com/hook/x/y', now: 0 }
    for (const id of IntegrationId.options) {
      const m = getIntegration(id)
      for (const secrets of [['s'], []]) {
        const r = await m.verify(req, { secrets, extra: {} })
        expect(r.ok, `${id} with ${secrets.length} secret(s)`).toBe(false)
        expect(r, id).not.toEqual({ ok: false, reason: 'not_implemented' })
      }
    }
    // One reason pinned, so "refused" cannot hide a crash turned into a refusal.
    expect(await getIntegration('linear').verify(req, { secrets: ['s'], extra: {} })).toEqual({
      ok: false,
      reason: 'missing_header',
    })
  })
  it('github dispatches webhook deliveries (x-github-event) to webhooks.ts and everything else to the poller side', async () => {
    const m = getIntegration('github')
    const req = { rawBody: new Uint8Array(), url: 'https://relay.example.com/hook/github/x', now: 0 }
    const conn = { secrets: ['s'], extra: {} }
    expect(await m.verify({ ...req, headers: { 'x-github-event': 'push' } }, conn)).toEqual({
      ok: false,
      reason: 'missing_header',
    })
    // Without the header it is a polled-notifications connection (WP3), which accepts no POSTs.
    expect(await m.verify({ ...req, headers: {} }, conn)).toEqual({ ok: false, reason: 'poll_only' })
    const { webhookVerify, normalizeWebhook } = await import('../src/github/webhooks.ts')
    expect(typeof webhookVerify).toBe('function')
    expect(
      await normalizeWebhook(
        { headers: {}, rawBody: new Uint8Array(), receivedAt: 0 },
        { id: 'cn_x', integration: 'github', thread: 'inbox', work: false, extra: {} },
      ),
    ).toEqual([])
  })
})
