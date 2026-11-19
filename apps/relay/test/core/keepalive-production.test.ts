// Production's keep-alive, as it is: the relay closes an idle keep-alive socket after Node's default 5 s, and a client that comes
// back after that close gets its answer on a new socket, never a network error. Every other test relay keeps idle sockets for
// TEST_KEEP_ALIVE_MS (harness.ts), so a long fake-clock jump cannot race this close; this test is where the close itself is kept.
// Real time, about 11 s: the close is Node's own timer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, TEST_KEEP_ALIVE_MS, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const IDLE_PAST_CLOSE_MS = 5_500

describe("the relay's keep-alive close at production's 5 s", () => {
  it("is Node's default, and is not what the other test relays use", async () => {
    relay = await startTestRelay({ productionKeepAlive: true })
    expect(relay.relay.http.keepAliveTimeout).toBe(5_000)
    expect(TEST_KEEP_ALIVE_MS).toBeGreaterThan(60_000)
  })

  it('a client back after the server closed its idle socket gets an answer, a read (GET) and a sender (POST) alike', async () => {
    relay = await startTestRelay({ productionKeepAlive: true })
    const r = relay
    const status = () => fetch(`${r.httpBase}/api/status`, { headers: r.appHeaders })
    // an unknown peer inbox: the relay answers 404, a full HTTP answer on the same keep-alive connection
    const post = () =>
      fetch(`${r.httpBase}/hook/peer/00000000-0000-4000-8000-000000000000`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    const first = await status()
    expect(first.ok).toBe(true)
    expect(first.headers.get('keep-alive')).toBe('timeout=5')
    await first.arrayBuffer()
    expect((await post()).status).toBeLessThan(500)
    const open = () => new Promise<number>((res, rej) => r.relay.http.getConnections((e, n) => (e ? rej(e) : res(n))))
    expect(await open()).toBeGreaterThan(0) // the client's pooled keep-alive socket(s)
    await new Promise((res) => setTimeout(res, IDLE_PAST_CLOSE_MS))
    expect(await open()).toBe(0) // the server closed them: the client's next request cannot reuse one
    const again = await status()
    expect(again.ok).toBe(true)
    await again.arrayBuffer()
    const postAgain = await post()
    expect(postAgain.status).toBeLessThan(500)
    await postAgain.arrayBuffer()
  })
})
