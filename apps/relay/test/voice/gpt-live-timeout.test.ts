import { describe, expect, it, vi } from 'vitest'
import { GptLiveProvider, PROVIDER_CREATE_TIMEOUT_MS } from '../../src/voice/gpt-live.ts'
import { CLOSE_WAIT_MS } from '../../src/voice/manager.ts'

// The app abandons a POST after 30 s (apps/web callController.ts POST_TIMEOUT_MS). The relay's worst case is one
// superseded call closing plus one provider create; that sum must stay under the app's limit.
const APP_POST_LIMIT_MS = 30_000

describe('provider create is bounded', () => {
  it('passes a timeout and no retries to the provider call', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const p = new GptLiveProvider('sk-test', 'm', log as never)
    const create = vi.fn(async (..._a: unknown[]) => ({ session: { id: 'p1' }, transport: { sdp: 'a' } }))
    ;(p as unknown as { client: { live: { create: typeof create } } }).client.live.create = create
    await p.create({ sdp: 'v=0', instructions: 'x', voice: 'v', seed: [] } as never)
    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: PROVIDER_CREATE_TIMEOUT_MS, maxRetries: 0 })
  })

  it('the relay worst case fits inside the app POST limit with room to spare', () => {
    expect(CLOSE_WAIT_MS + PROVIDER_CREATE_TIMEOUT_MS).toBeLessThan(APP_POST_LIMIT_MS)
  })
})
