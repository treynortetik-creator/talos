// D23: the upload guard is an idle timeout. A slow upload that keeps sending is not cut at 15 s; a stalled one still is.
import { fakeClock } from '@talos-app/testkit'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { bodyTimeout, idleBodyTimeout, lateRequest, limitBody, originalRequest } from '../../src/core/body-guard.ts'
import type { AppEnv } from '../../src/services.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A body that sends `chunks` pieces `gapMs` apart, then either ends or goes quiet for good. */
function trickle(chunks: number, gapMs: number, stall = false): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      await sleep(gapMs)
      if (i < chunks) {
        i++
        controller.enqueue(new Uint8Array([i]))
      } else if (stall) {
        await new Promise(() => {}) // never ends
      } else controller.close()
    },
  })
}

const post = (app: Hono<AppEnv>, body: ReadableStream<Uint8Array>) =>
  app.request(
    new Request('http://x/up', {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-length': '6' },
    } as RequestInit),
  )

function appWith(guard: ReturnType<typeof idleBodyTimeout>, saved: number[][]) {
  const app = new Hono<AppEnv>()
  app.post('/up', guard, async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
    saved.push([...bytes])
    return c.json({ n: bytes.length })
  })
  return app
}

describe('upload idle timeout (D23)', () => {
  it('a slow upload that keeps sending past the idle window completes and is saved', async () => {
    const saved: number[][] = []
    // 6 chunks x 40 ms = 240 ms in total, well past the 120 ms idle window, but no gap is longer than the window
    const res = await post(appWith(idleBodyTimeout(120), saved), trickle(6, 40))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ n: 6 })
    expect(saved).toEqual([[1, 2, 3, 4, 5, 6]])
  })

  it('an upload that goes quiet is cut with 408 and nothing is saved', async () => {
    const saved: number[][] = []
    const res = await post(appWith(idleBodyTimeout(120), saved), trickle(2, 40, true))
    expect(res.status).toBe(408)
    expect(await res.json()).toEqual({ error: 'request_timeout' })
    await sleep(50)
    expect(saved).toEqual([])
  })

  it('a client that trickles forever still hits the hard ceiling', async () => {
    const saved: number[][] = []
    const res = await post(appWith(idleBodyTimeout(120, 200), saved), trickle(100, 40))
    expect(res.status).toBe(408)
    expect(saved).toEqual([])
  })
})

describe('wrapping the body keeps the request identity (a route keyed on the first request still finds its entry)', () => {
  it('originalRequest(c) is the request the route first saw, after the idle guard and after a chunked limitBody', async () => {
    const seen: { first?: Request; later?: Request } = {}
    const app = new Hono<AppEnv>()
    app.post(
      '/id',
      (c, next) => {
        seen.first = c.req.raw
        return next()
      },
      limitBody(() => 1000),
      idleBodyTimeout(500),
      async (c) => {
        seen.later = originalRequest(c)
        return c.json({ replaced: c.req.raw !== seen.first })
      },
    )
    // no content-length: bodyLimit re-reads the body into a new request; the idle guard then wraps that one too
    const res = await app.request(
      new Request('http://x/id', { method: 'POST', body: trickle(2, 5), duplex: 'half' } as RequestInit),
    )
    expect(await res.json()).toEqual({ replaced: true })
    expect(seen.later).toBe(seen.first)
  })
})

describe('the fixed guard (routes that read the body before they can check who sent it)', () => {
  it('cuts a steady trickle at the deadline: bytes arriving do not extend it', async () => {
    const saved: number[][] = []
    // 6 chunks x 40 ms = 240 ms, no gap near the 120 ms window, but the whole request may only take 120 ms
    const res = await post(appWith(bodyTimeout(120), saved), trickle(6, 40))
    expect(res.status).toBe(408)
    await sleep(300)
    expect(saved).toEqual([])
  })

  it('lets a request that finishes inside the deadline through', async () => {
    const saved: number[][] = []
    const res = await post(appWith(bodyTimeout(400), saved), trickle(3, 10))
    expect(res.status).toBe(200)
    expect(saved).toEqual([[1, 2, 3]])
  })
})

describe('stopWhenBodyIn', () => {
  /** A body that arrives whole at once, then a handler that never finishes. Timers run on a fake clock the app owns. */
  async function stuckHandler(guard: ReturnType<typeof idleBodyTimeout>) {
    const clock = fakeClock()
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('services', { clock } as never)
      await next()
    })
    app.post('/up', guard, async (c) => {
      await c.req.arrayBuffer()
      await new Promise(() => {}) // the work after the body (a slow upstream) never ends
      return c.json({})
    })
    let status: number | undefined
    const whole = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array([1]))
        ctl.close()
      },
    })
    const pending = Promise.resolve(post(app, whole)).then((r) => {
      status = r.status
    })
    // Let the one chunk and the end of the body through; zero-delay turns, no clock involved.
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
    return { clock, pending, status: () => status }
  }

  it('is off by default: once the body is in, a handler that stalls is still cut by the idle window', async () => {
    const { clock, pending, status } = await stuckHandler(idleBodyTimeout(120, 5_000))
    expect(status()).toBeUndefined()
    clock.advance(121)
    // Bounded: a guard that stopped cutting would leave `pending` hanging and the suite waiting for the test timeout.
    let giveUp: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<void>((_, no) => {
          giveUp = setTimeout(() => no(new Error('no 408 within 2s')), 2000)
        }),
      ])
    } finally {
      clearTimeout(giveUp) // a passing run leaves no 2 s timer behind
    }
    expect(status()).toBe(408)
  })

  it('when on, the guard lets go of its timers as soon as the body is in', async () => {
    const { clock, status } = await stuckHandler(idleBodyTimeout(120, 5_000, { stopWhenBodyIn: true }))
    expect(clock.pending).toBe(0)
    clock.advance(60_000)
    expect(status()).toBeUndefined()
  })
})
