// /api/me tells the app whether live voice can work, and why not (so the app can say how to turn it on).
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, makeHarness } from '../auth/helpers.ts'

afterEach(afterEachReset)

async function me(env: Record<string, string>) {
  const h = await makeHarness({ env })
  const res = await h.app.request('/api/me', { headers: { Cookie: h.login() } })
  expect(res.status).toBe(200)
  return (await res.json()) as { voice?: { available: boolean; reason?: string } }
}

describe('GET /api/me voice status', () => {
  it('no OPENAI_API_KEY -> unavailable with reason no_key', async () => {
    expect((await me({})).voice).toEqual({ available: false, reason: 'no_key' })
  })

  it('key set -> available, no reason', async () => {
    expect((await me({ OPENAI_API_KEY: 'sk-test-not-real' })).voice).toEqual({ available: true })
  })

  it('an empty key counts as missing', async () => {
    expect((await me({ OPENAI_API_KEY: '' })).voice).toEqual({ available: false, reason: 'no_key' })
  })
})
