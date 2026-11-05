// RSS polling resolves hostnames and refuses private answers on every hop. The address verdicts themselves are tested once,
// over the shared corpus, in packages/protocol/test/address.test.ts.
import { describe, expect, it } from 'vitest'
import { getIntegration } from '../../src/index.ts'
import type { PollContext } from '../../src/types.ts'
import { NOW } from './helpers.ts'

const RSS =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>a</title><guid>1</guid></item></channel></rss>'

describe('rss poll resolves hostnames', () => {
  const ctx = (
    resolve: PollContext['resolve'],
    fetchFn: typeof fetch,
    extra = 'https://feeds.example.org/rss',
  ): PollContext => ({
    cursor: null,
    secrets: {},
    extra: { feed_url: extra },
    now: NOW,
    fetch: fetchFn,
    ...(resolve ? { resolve } : {}),
  })
  it('refuses a name that resolves to a private address (even one of several)', async () => {
    const rss = getIntegration('rss')
    let called = 0
    const f = (async () => {
      called++
      return new Response(RSS)
    }) as typeof fetch
    await expect(rss.poll?.(ctx(async () => ['93.184.216.34', '10.0.0.5'], f))).rejects.toThrow(/private/)
    expect(called).toBe(0)
  })
  it('re-resolves and refuses on every redirect hop', async () => {
    const rss = getIntegration('rss')
    const hosts: string[] = []
    const resolve = async (h: string) => {
      hosts.push(h)
      return h === 'evil.example.net' ? ['169.254.169.254'] : ['93.184.216.34']
    }
    const f = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } })) as typeof fetch
    await expect(rss.poll?.(ctx(resolve, f))).rejects.toThrow(/private/)
    expect(hosts).toEqual(['feeds.example.org', 'evil.example.net'])
  })
  it('fetches when every address is public', async () => {
    const rss = getIntegration('rss')
    const f = (async () => new Response(RSS)) as typeof fetch
    const r = await rss.poll?.(ctx(async () => ['93.184.216.34', '2606:4700:4700::1111'], f))
    expect(r?.deliveries).toEqual([]) // first poll marks seen
  })
})
