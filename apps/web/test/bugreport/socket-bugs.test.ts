// The socket side of the bug reporter: the report is signed by the device key and posted with the CSRF header; the relay's
// answers map to the client's errors; the Mac's answer is read defensively.
import { createDeviceKey, verifyOwnerFrame } from '@talos-app/protocol'
import { describe, expect, it, vi } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { base64Of, createSocketBugs, toBugContext } from '../../src/lib/socketBugs.ts'

const report = {
  what_went_wrong: 'x',
  versions: { app: '1', bridge: '1', relay: '1', claude_code: '1' },
  recent_errors: [],
  logs: '',
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

async function make(status = 201) {
  const key = await createDeviceKey()
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('{}', { status })
  }) as unknown as typeof fetch
  const ask = vi.fn(async () => ({ bridge_version: '9', claude_code: null, recent_errors: ['e'], logs: 'l' }))
  const bugs = createSocketBugs({
    ask,
    ensureKey: async () => key,
    signedTs: () => new Date().toISOString(),
    fetchImpl,
  })
  return { key, calls, bugs, ask }
}

describe('send', () => {
  it('posts one object signed by the device key, with the CSRF header', async () => {
    const { key, calls, bugs } = await make()
    const { id } = await bugs.send(report, { type: 'image/png', bytes: png })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/bug-reports')
    expect(((calls[0] as { init: RequestInit }).init.headers as Record<string, string>)['X-Talos-CSRF']).toBe('1')
    const sent = JSON.parse(String(calls[0]?.init.body))
    expect(sent.id).toBe(id)
    expect(sent.type).toBe('bug.report')
    expect(sent.image_b64).toBe(base64Of(png))
    expect(await verifyOwnerFrame(sent, key.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame({ ...sent, report: { ...report, what_went_wrong: 'y' } }, key.publicJwk)).toBe(false)
  })
  it('a 429 is rate_limited, any other refusal is internal, a dead network says offline', async () => {
    await expect((await make(429)).bugs.send(report, { type: 'image/png', bytes: png })).rejects.toMatchObject({
      code: 'rate_limited',
    })
    await expect((await make(507)).bugs.send(report, { type: 'image/png', bytes: png })).rejects.toBeInstanceOf(
      TalosClientError,
    )
    const key = await createDeviceKey()
    const bugs = createSocketBugs({
      ask: async () => ({}),
      ensureKey: async () => key,
      signedTs: () => new Date().toISOString(),
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch,
    })
    await expect(bugs.send(report, { type: 'image/png', bytes: png })).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('context', () => {
  it('asks for bug.context with a line count and reads the answer', async () => {
    const { bugs, ask } = await make()
    const c = await bugs.context(200)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ type: 'bug.context', lines: 200 }))
    expect(c).toEqual({ bridgeVersion: '9', claudeCode: null, recentErrors: ['e'], logs: 'l' })
  })
  it('does not trust the shape of the answer', () => {
    expect(toBugContext({ bridge_version: 5, recent_errors: 'no', logs: null })).toEqual({
      bridgeVersion: '',
      claudeCode: null,
      recentErrors: [],
      logs: '',
    })
  })
})

describe('destination', () => {
  const at = (status: number, body: unknown) =>
    createSocketBugs({
      ask: async () => ({}),
      ensureKey: async () => {
        throw new Error('not needed')
      },
      signedTs: () => new Date().toISOString(),
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe('/api/bug-reports/destination')
        expect(init.method ?? 'GET').toBe('GET')
        return new Response(JSON.stringify(body), { status })
      }) as unknown as typeof fetch,
    })
  it('reads each of the three answers', async () => {
    await expect(at(200, { to: 'relay' }).destination()).resolves.toEqual({ to: 'relay' })
    await expect(at(200, { to: 'team' }).destination()).resolves.toEqual({ to: 'team' })
    await expect(at(200, { to: 'webhook', host: 'hooks.example.com' }).destination()).resolves.toEqual({
      to: 'webhook',
      host: 'hooks.example.com',
    })
  })
  it('a refusal or an answer of another shape is not believed', async () => {
    await expect(at(404, { error: 'not_found' }).destination()).rejects.toBeInstanceOf(TalosClientError)
    await expect(at(200, { to: 'somewhere' }).destination()).rejects.toBeInstanceOf(TalosClientError)
    await expect(at(200, { to: 'webhook' }).destination()).rejects.toBeInstanceOf(TalosClientError)
  })
})
