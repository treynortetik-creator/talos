// O6: ten awake minutes without the relay posts once to ntfy, and once more when it returns. Sleep is not silence.
import { describe, expect, test } from 'bun:test'
import { fakeClock } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { ALERT_TEXT, BACK_TEXT, RelaySilence, TICK_MS, validNtfyUrl } from '../src/relay-silence.ts'
import { startHarness, stopRelay, waitFor } from './helpers.ts'

const URL_OK = 'https://ntfy.example.com/secret-topic-123'
const MIN = 60_000

function rig(opts: { url?: string | undefined; failPosts?: number } = {}) {
  const clock = fakeClock()
  const posts: { url: string; body: string; headers: Record<string, string> }[] = []
  let connected = true
  let fail = opts.failPosts ?? 0
  const logs: string[] = []
  const log = {
    ...nullLogger,
    warn: (m: string, f?: Record<string, unknown>) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
  }
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (fail > 0) {
      fail--
      throw new Error('network down')
    }
    posts.push({ url, body: String(init.body), headers: init.headers as Record<string, string> })
    return new Response('ok')
  }) as unknown as typeof fetch
  const s = new RelaySilence({
    url: 'url' in opts ? opts.url : URL_OK,
    connected: () => connected,
    clock,
    log,
    fetchFn,
  })
  const settle = () => new Promise((r) => setTimeout(r, 5))
  return {
    clock,
    posts,
    logs,
    s,
    setConnected: (v: boolean) => {
      connected = v
    },
    /** Awake time passes: the clock moves in ticks, the way the real timer fires. */
    async awake(ms: number) {
      for (let t = 0; t < ms; t += TICK_MS) clock.advance(Math.min(TICK_MS, ms - t))
      await settle()
    },
    /** The lid closes: time passes with no timer running, then the next tick fires late. */
    async sleep(ms: number) {
      clock.set(clock.now() + ms)
      clock.advance(TICK_MS)
      await settle()
    },
  }
}

describe('RelaySilence', () => {
  test('inert without a URL: no timer, no post', async () => {
    const r = rig({ url: undefined })
    r.s.start()
    r.setConnected(false)
    await r.awake(60 * MIN)
    expect(r.s.enabled).toBe(false)
    expect(r.clock.pending).toBe(0)
    expect(r.posts).toEqual([])
  })

  test('connected the whole time: nothing is sent', async () => {
    const r = rig()
    r.s.start()
    await r.awake(120 * MIN)
    expect(r.posts).toEqual([])
  })

  test('nine minutes without the relay is quiet; ten posts once, and an hour more posts nothing further', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false)
    await r.awake(9 * MIN)
    expect(r.posts).toEqual([])
    await r.awake(MIN)
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]?.body).toBe(ALERT_TEXT)
    expect(r.posts[0]?.url).toBe(URL_OK)
    expect(r.posts[0]?.headers.Tags).toBe('warning')
    await r.awake(60 * MIN)
    expect(r.posts).toHaveLength(1)
    expect(r.s.inOutage).toBe(true)
  })

  test('when the relay returns it says so once, and a second outage alerts again', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false)
    await r.awake(11 * MIN)
    r.setConnected(true)
    await r.awake(TICK_MS)
    await r.awake(5 * MIN)
    expect(r.posts.map((p) => p.body)).toEqual([ALERT_TEXT, BACK_TEXT])
    r.setConnected(false)
    await r.awake(11 * MIN)
    expect(r.posts.map((p) => p.body)).toEqual([ALERT_TEXT, BACK_TEXT, ALERT_TEXT])
  })

  test('a blip that comes back before ten minutes sends nothing, not even a "back"', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false)
    await r.awake(8 * MIN)
    r.setConnected(true)
    await r.awake(MIN)
    r.setConnected(false)
    await r.awake(8 * MIN) // the count restarted when it reconnected
    expect(r.posts).toEqual([])
  })

  test('sleep is not silence: a Mac that slept for hours does not alert on waking', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false) // the socket dies as the lid closes
    await r.sleep(6 * 60 * MIN)
    await r.awake(MIN)
    expect(r.posts).toEqual([])
  })

  test('sleep in the middle of silence restarts the count: nine minutes, sleep, nine more is still quiet; ten awake after wake alerts', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false)
    await r.awake(9 * MIN)
    await r.sleep(2 * 60 * MIN)
    await r.awake(9 * MIN)
    expect(r.posts).toEqual([])
    await r.awake(2 * MIN)
    expect(r.posts).toHaveLength(1)
  })

  test('a clock set backwards does not count either', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false)
    await r.awake(9 * MIN)
    r.clock.set(r.clock.now() - 3 * 60 * MIN)
    await r.awake(TICK_MS)
    await r.awake(5 * MIN)
    expect(r.posts).toEqual([])
  })

  test('a failed post is retried once, then logged without the URL, and is not repeated every tick', async () => {
    const r = rig({ failPosts: 2 })
    r.s.start()
    r.setConnected(false)
    await r.awake(11 * MIN)
    await r.awake(30 * MIN)
    expect(r.posts).toEqual([])
    expect(r.logs.join('\n')).toContain('could not be sent')
    expect(r.logs.join('\n')).not.toContain('secret-topic')
  })

  test('an alert that never went out gets no "connected again"', async () => {
    const r = rig({ failPosts: 2 })
    r.s.start()
    r.setConnected(false)
    await r.awake(11 * MIN)
    expect(r.posts).toEqual([])
    r.setConnected(true)
    await r.awake(TICK_MS)
    await r.awake(5 * MIN)
    expect(r.posts).toEqual([]) // the next post would have succeeded: only the missing alert kept it quiet
    expect(r.s.inOutage).toBe(false)
  })

  test('one retry rescues a single failure', async () => {
    const r = rig({ failPosts: 1 })
    r.s.start()
    r.setConnected(false)
    await r.awake(11 * MIN)
    expect(r.posts).toHaveLength(1)
  })

  test('stop() ends the watch', async () => {
    const r = rig()
    r.s.start()
    r.setConnected(false)
    r.s.stop()
    await r.awake(60 * MIN)
    expect(r.posts).toEqual([])
    expect(r.clock.pending).toBe(0)
  })

  test('only https (or a topic on this machine) is accepted; a bad URL is ignored and never logged', () => {
    expect(validNtfyUrl('https://ntfy.sh/abc')).toBe(true)
    expect(validNtfyUrl('http://127.0.0.1:9/abc')).toBe(true)
    expect(validNtfyUrl('http://ntfy.sh/abc')).toBe(false)
    expect(validNtfyUrl('ntfy.sh/abc')).toBe(false)
    const r = rig({ url: 'http://ntfy.sh/secret-topic-123' })
    expect(r.s.enabled).toBe(false)
    expect(r.logs.join('\n')).toContain('ignored')
    expect(r.logs.join('\n')).not.toContain('secret-topic')
  })
})

describe('the bridge wires it', () => {
  test('a bridge that loses the relay for the threshold posts to the topic from bridge.env, once', async () => {
    const got: string[] = []
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        got.push(await req.text())
        return new Response('ok')
      },
    })
    const h = await startHarness({
      env: { TALOS_APP_ALERT_NTFY_URL: `http://127.0.0.1:${srv.port}/topic` },
      bridge: { relaySilence: { tickMs: 40, silenceMs: 250 } },
    })
    try {
      expect(got).toEqual([])
      await stopRelay(h.relay) // the relay is gone; the Mac is awake
      await waitFor(() => got.length >= 1, 8000, 'the ntfy post')
      await new Promise((r) => setTimeout(r, 600))
      expect(got).toEqual([ALERT_TEXT])
    } finally {
      await h.bridge.stop()
      await h.app.close()
      await srv.stop(true)
    }
  })

  test('with no topic set the same outage posts nothing', async () => {
    const got: string[] = []
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        got.push(await req.text())
        return new Response('ok')
      },
    })
    const h = await startHarness({
      bridge: {
        relaySilence: {
          tickMs: 40,
          silenceMs: 250,
          fetchFn: ((_u: string, i: RequestInit) =>
            fetch(`http://127.0.0.1:${srv.port}/`, i)) as unknown as typeof fetch,
        },
      },
    })
    try {
      await stopRelay(h.relay)
      await new Promise((r) => setTimeout(r, 900))
      expect(got).toEqual([])
    } finally {
      await h.bridge.stop()
      await h.app.close()
      await srv.stop(true)
    }
  })
})
