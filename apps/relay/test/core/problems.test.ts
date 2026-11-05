// Problem reports against the REAL relay (docs/ERRORS.md): the route, the hold until the Mac says it can file them, the
// two-stage ack, the 500 that stays a 500, and the fatal error that survives a restart. The rate test swaps in the real
// token bucket, because the test auth's own limiter never refuses anything.

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid, PROBLEM_LIMITS, PROBLEMS_FEATURE, type ProblemT } from '@talos-app/protocol'
import { type FakeBridge, fakeClock, waitFor } from '@talos-app/testkit'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAuthImplementation } from '../../src/auth/contract.ts'
import { RateLimiter } from '../../src/auth/limits.ts'
import { installFatalHandlers, RelayProblemRecorder, saveFatalProblem } from '../../src/core/problems.ts'
import { createTestAuth } from '../helpers/test-auth.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
const bridges: FakeBridge[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  await relay?.stop()
  relay = null
})

const DEV = 'd_abcdefghijklmnopqrst'
const sess = { 'X-Test-Session': DEV, Origin: ORIGIN, 'X-Talos-CSRF': '1', 'content-type': 'application/json' }

function addDevice(r: TestRelay) {
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(DEV, 'phone', '{}', 'b', 1, 0, Date.now())
}

function problem(over: Partial<ProblemT> = {}): ProblemT {
  return {
    id: newUlid(),
    source: 'web',
    kind: 'auto',
    fingerprint: 'a'.repeat(32),
    at: new Date().toISOString(),
    name: 'TypeError',
    message: 'x is not a function',
    frames: [{ fn: 'render', file: 'assets/index.js', line: 10, col: 4 }],
    versions: { app: '1.2.3' },
    device: 'browser',
    routes: ['thread'],
    truncated: false,
    ...over,
  }
}

const send = (r: TestRelay, body: unknown, headers: Record<string, string> = sess) =>
  fetch(`${r.httpBase}/api/problems`, { method: 'POST', headers, body: JSON.stringify(body) })

async function world(features: string[] = [PROBLEMS_FEATURE], consume: 'auto' | 'manual' = 'auto') {
  relay = await startTestRelay()
  addDevice(relay)
  const b = await kit(relay).bridge({ autoReply: false, consume, verifyOwner: false, features }).connect()
  bridges.push(b)
  return { relay, bridge: b }
}

const outboxRows = (r: TestRelay) =>
  (r.relay.services.db.prepare("select count(*) n from core_outbox where type = 'problem.item'").get() as { n: number })
    .n

describe('POST /api/problems', () => {
  it('queues one problem.item for the Mac; the relay keeps it until the Mac says consumed', async () => {
    const { relay: r, bridge } = await world([PROBLEMS_FEATURE], 'manual')
    const p = problem()
    const res = await send(r, p)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, id: p.id })
    await waitFor(() => bridge.unconsumedIds().includes(p.id), 3000, 'problem delivered')
    expect(outboxRows(r)).toBe(1) // delivered, not yet consumed: still held
    expect(bridge.consume(p.id)).toBe(true)
    await waitFor(() => outboxRows(r) === 0, 3000, 'problem consumed')
  })

  it('does not count held or in-flight problems as messages waiting for the Mac', async () => {
    const { relay: r } = await world([])
    await send(r, problem())
    expect(outboxRows(r)).toBe(1)
    expect(r.runtime.hub.presence().queue_depth).toBe(0)
  })

  it('holds the frame until the Mac advertises problems/1, then delivers it on the next hello', async () => {
    const { relay: r, bridge: old } = await world([])
    const p = problem()
    expect((await send(r, p)).status).toBe(202)
    await new Promise((res) => setTimeout(res, 300))
    expect(old.notified.filter((f) => f.type === 'problem.item')).toHaveLength(0)
    expect(old.unconsumedIds()).toEqual([])
    await old.close()
    const fresh = await kit(r)
      .bridge({ autoReply: false, verifyOwner: false, features: [PROBLEMS_FEATURE] })
      .connect()
    bridges.push(fresh)
    await fresh.waitNotified('problem.item')
    await waitFor(() => outboxRows(r) === 0, 3000, 'consumed after hello')
  })

  it('a retried POST of the same problem is one frame', async () => {
    const { relay: r, bridge } = await world()
    const p = problem()
    expect((await send(r, p)).status).toBe(202)
    expect((await send(r, p)).status).toBe(202)
    await bridge.waitNotified('problem.item')
    await new Promise((res) => setTimeout(res, 200))
    expect(bridge.notified.filter((f) => f.type === 'problem.item')).toHaveLength(1)
  })

  it('a second report that reuses the first one id as its own is not stored twice (the id is the frame id)', async () => {
    const { relay: r, bridge } = await world()
    const p = problem()
    await send(r, p)
    await send(r, { ...p, message: 'something else entirely' })
    await bridge.waitNotified('problem.item')
    await new Promise((res) => setTimeout(res, 200))
    const got = bridge.notified.filter((f) => f.type === 'problem.item') as Array<{ problem: ProblemT }>
    expect(got).toHaveLength(1)
    expect(got[0]?.problem.message).toBe('x is not a function')
  })

  it('needs a session (the CSRF check is the real auth layer, which this test auth does not run)', async () => {
    const { relay: r } = await world()
    expect(
      (await send(r, problem(), { 'content-type': 'application/json', Origin: ORIGIN, 'X-Talos-CSRF': '1' })).status,
    ).toBe(401)
    expect(outboxRows(r)).toBe(0)
  })

  it('refuses a body that is not a problem: an extra key such as text, an unknown source, and junk', async () => {
    const { relay: r } = await world()
    expect((await send(r, { ...problem(), text: 'hello' })).status).toBe(400)
    expect((await send(r, problem({ source: 'watch' as never }))).status).toBe(400)
    const junk = await fetch(`${r.httpBase}/api/problems`, { method: 'POST', headers: sess, body: '{not json' })
    expect(junk.status).toBe(400)
    expect(outboxRows(r)).toBe(0)
  })

  it('a body over 64 KiB is 413 before anything is read into a report', async () => {
    const { relay: r } = await world()
    const res = await fetch(`${r.httpBase}/api/problems`, {
      method: 'POST',
      headers: sess,
      body: JSON.stringify({ ...problem(), message: 'x'.repeat(PROBLEM_LIMITS.bodyBytes + 10) }),
    })
    expect(res.status).toBe(413)
  })

  it('scrubs again: a quoted message that got past the app never reaches the Mac', async () => {
    const { relay: r, bridge } = await world()
    await send(r, problem({ message: 'Unexpected token, "CANARY-secret-words" is not valid JSON' }))
    await bridge.waitNotified('problem.item')
    expect(JSON.stringify(bridge.notified)).not.toContain('CANARY-secret-words')
  })

  it('a screenshot the relay does not hold is refused, so the app uploads it again', async () => {
    const { relay: r } = await world()
    const p = problem({
      kind: 'owner',
      steps: 'it froze',
      screenshot: {
        media_id: `md_${'0'.repeat(26)}`,
        kind: 'image',
        role: 'attachment',
        mime: 'image/png',
        name: 'screenshot.png',
        size: 10,
        sha256: 'b'.repeat(64),
      },
    })
    const res = await send(r, p)
    expect([400]).toContain(res.status)
    expect(((await res.json()) as { error: string }).error).toBe('screenshot_missing')
  })

  it('is advertised as a relay feature so the app can send with the Mac offline', async () => {
    const { relay: r } = await world()
    const app = kit(r).app()
    const ready = await app.connect()
    expect(ready.features).toContain(PROBLEMS_FEATURE)
    await app.close()
  })
})

describe('the problems bucket (real token bucket)', () => {
  it('lets 30 an hour through and answers the 31st with 429 and Retry-After', async () => {
    const { relay: r, bridge } = await world()
    const real = new RateLimiter(r.relay.services.clock)
    const base = createTestAuth({ bridgeKey: r.bridgeKey })
    setAuthImplementation(
      {
        ...base,
        rateLimit: (name) => async (c, next) => {
          const t = real.take(name, '127.0.0.1')
          if (!t.ok) {
            c.header('Retry-After', String(t.retryAfterS))
            return c.json({ error: 'rate_limited' }, 429)
          }
          await next()
        },
      },
      { test: true },
    )
    for (let i = 0; i < PROBLEM_LIMITS.perHour; i++) expect((await send(r, problem())).status).toBe(202)
    const over = await send(r, problem())
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    await bridge.waitNotified('problem.item', PROBLEM_LIMITS.perHour)
    await new Promise((res) => setTimeout(res, 150))
    expect(bridge.notified.filter((f) => f.type === 'problem.item')).toHaveLength(PROBLEM_LIMITS.perHour) // the 31st queued nothing
  })
})

describe('the relay own errors', () => {
  it('a thrown error is still the same plain 500, and is told to the Mac once', async () => {
    const { relay: r, bridge } = await world()
    const reference = await new Hono()
      .use('*', async () => {
        throw new Error('boom')
      })
      .request('/x')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Only the request's own frame fails: the report to the Mac needs the store to work.
    const lookup = r.runtime.store.getEventByFrameId.bind(r.runtime.store)
    const sent = problem()
    r.runtime.store.getEventByFrameId = (id, ...rest) => {
      if (id === sent.id) throw new Error('disk exploded')
      return lookup(id, ...rest)
    }
    const a = await send(r, sent)
    const b = await send(r, sent)
    spy.mockRestore()
    for (const res of [a, b]) {
      expect(res.status).toBe(reference.status)
      expect(await res.text()).toBe(await reference.clone().text())
      expect(res.headers.get('content-type')).toBe(reference.headers.get('content-type'))
    }
    await bridge.waitNotified('problem.item')
    await new Promise((res) => setTimeout(res, 200))
    const got = bridge.notified.filter((f) => f.type === 'problem.item') as Array<{ problem: ProblemT }>
    expect(got).toHaveLength(1) // the same error twice is one report
    expect(got[0]?.problem).toMatchObject({ source: 'relay', kind: 'auto', device: 'relay', message: 'disk exploded' })
  })

  it('a failure while recording is a warning, never an error, and never loops', async () => {
    relay = await startTestRelay()
    const services = relay.relay.services
    const errors = vi.spyOn(services.log, 'error')
    const warns = vi.spyOn(services.log, 'warn')
    relay.runtime.hub.toBridge = () => Promise.reject(new Error('queue broke'))
    const rec = new RelayProblemRecorder(services)
    expect(rec.record(new Error('first'))).toBe(true)
    await new Promise((res) => setTimeout(res, 50))
    expect(errors).not.toHaveBeenCalled()
    expect(warns).toHaveBeenCalled()
    // reentry: a record() made while one is running is refused
    let inner: boolean | undefined
    relay.runtime.hub.toBridge = (() => {
      inner = rec.record(new Error('nested'))
      return Promise.resolve({ queued: false })
    }) as never
    rec.record(new Error('second'))
    expect(inner).toBe(false)
  })

  it('caps what one process reports, and says how many it dropped', async () => {
    relay = await startTestRelay()
    relay.runtime.hub.toBridge = () => Promise.resolve({ queued: true })
    const rec = new RelayProblemRecorder(relay.relay.services)
    let sent = 0
    for (let i = 0; i < PROBLEM_LIMITS.perSession + 5; i++)
      if (rec.record(new Error(`distinct failure ${'z'.repeat(i + 1)}`))) sent++
    expect(sent).toBe(PROBLEM_LIMITS.perSession)
    expect(rec.dropped).toBe(5)
  })
})

describe('the relay own errors: the cap is a rolling hour', () => {
  it('one bug repeating all day does not mute the other errors after the first 20: the window rolls', async () => {
    const clock = fakeClock()
    relay = await startTestRelay({ clock })
    relay.runtime.hub.toBridge = () => Promise.resolve({ queued: true })
    const rec = new RelayProblemRecorder(relay.relay.services)
    const burst = (tag: string, n: number) => {
      let sent = 0
      for (let i = 0; i < n; i++) if (rec.record(new Error(`${tag} failure ${'z'.repeat(i + 1)}`))) sent++
      return sent
    }
    expect(burst('first', PROBLEM_LIMITS.perSession + 5)).toBe(PROBLEM_LIMITS.perSession)
    clock.advance(PROBLEM_LIMITS.perProcessWindowMs - 60_000)
    expect(burst('still inside the hour', 3)).toBe(0)
    clock.advance(2 * 60_000)
    expect(burst('second hour', PROBLEM_LIMITS.perSession + 5)).toBe(PROBLEM_LIMITS.perSession)
  })
})

describe('what the relay adds', () => {
  it('stamps its own version on a report from the app, so the app need not know it', async () => {
    const { relay: r, bridge } = await world()
    const p = problem({ versions: { app: '1.2.3' } })
    expect((await send(r, p)).status).toBe(202)
    await waitFor(() => bridge.notified.some((f) => f.type === 'problem.item'), 3000, 'delivered')
    const f = bridge.notified.find((x) => x.type === 'problem.item') as unknown as { problem: ProblemT }
    expect(f.problem.versions.relay).toMatch(/\S/)
  })

  it('a client cannot set the relay version: what the relay holds is its own', async () => {
    const { relay: r, bridge } = await world()
    const p = problem({ versions: { app: '1.2.3', relay: 'forged-9.9.9' } })
    expect((await send(r, p)).status).toBe(202)
    await waitFor(() => bridge.notified.some((f) => f.type === 'problem.item'), 3000, 'delivered')
    const f = bridge.notified.find((x) => x.type === 'problem.item') as unknown as { problem: ProblemT }
    expect(f.problem.versions.relay).not.toBe('forged-9.9.9')
    expect(f.problem.versions.relay).toMatch(/\S/)
  })

  it('warns, once the window rolls, how many errors the cap held back', async () => {
    const clock = fakeClock()
    relay = await startTestRelay({ clock })
    relay.runtime.hub.toBridge = () => Promise.resolve({ queued: true })
    const warn = vi.spyOn(relay.relay.services.log, 'warn')
    const rec = new RelayProblemRecorder(relay.relay.services)
    for (let i = 0; i < PROBLEM_LIMITS.perSession + 5; i++) rec.record(new Error(`failure ${'z'.repeat(i + 1)}`))
    clock.advance(PROBLEM_LIMITS.perProcessWindowMs + 1000)
    rec.record(new Error('a different failure after the hour'))
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: 5 }), expect.stringMatching(/held back/))
  })
})

describe('source maps', () => {
  it('are built for a fixer but never served by the relay', async () => {
    const web = mkdtempSync(join(tmpdir(), 'talos-web-'))
    mkdirSync(join(web, 'assets'))
    writeFileSync(join(web, 'index.html'), '<html></html>')
    writeFileSync(join(web, 'assets', 'a.js'), 'console.log(1)')
    writeFileSync(join(web, 'assets', 'a.js.map'), '{"version":3}')
    relay = await startTestRelay({ webDir: web })
    expect((await fetch(`${relay.httpBase}/assets/a.js`)).status).toBe(200)
    expect((await fetch(`${relay.httpBase}/assets/a.js.map`)).status).toBe(404)
  })
})

describe('fatal errors', () => {
  it('saves one row, still exits 1, and keeps only the first of two', () => {
    const dir = require_tmp()
    const proc = new EventEmitter()
    const exit = vi.fn()
    const print = vi.fn()
    const off = installFatalHandlers({ dataDir: dir, proc, exit, print })
    proc.emit('uncaughtException', new Error('first fatal'))
    proc.emit('unhandledRejection', new Error('second fatal'))
    off()
    expect(exit).toHaveBeenCalledTimes(2)
    expect(exit).toHaveBeenCalledWith(1)
    expect(print).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(readFileSync(join(dir, 'fatal-problem.json'), 'utf8')) as ProblemT
    expect(saved.message).toBe('first fatal')
    expect(saved.name.startsWith('fatal')).toBe(true)
    expect(readdirSync(dir).filter((f) => f.startsWith('fatal'))).toHaveLength(1)
  })

  it('is filed on the next boot, once, and the file is removed', async () => {
    relay = await startTestRelay()
    const dir = relay.dir
    await relay.stopKeepData()
    saveFatalProblem(dir, new Error('crashed last night'))
    expect(existsSync(join(dir, 'fatal-problem.json'))).toBe(true)
    relay = await startTestRelay({ dir })
    expect(existsSync(join(dir, 'fatal-problem.json'))).toBe(false)
    const b = await kit(relay)
      .bridge({ autoReply: false, verifyOwner: false, features: [PROBLEMS_FEATURE] })
      .connect()
    bridges.push(b)
    await b.waitNotified('problem.item')
    const got = b.notified.filter((f) => f.type === 'problem.item') as Array<{ problem: ProblemT }>
    expect(got).toHaveLength(1)
    expect(got[0]?.problem.message).toBe('crashed last night')
  })

  it('an unreadable fatal file is dropped with a warning, and the relay still boots', async () => {
    relay = await startTestRelay()
    const dir = relay.dir
    await relay.stopKeepData()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'fatal-problem.json'), '{"not":"a problem"}')
    relay = await startTestRelay({ dir })
    expect(existsSync(join(dir, 'fatal-problem.json'))).toBe(false)
  })
})

function require_tmp() {
  return mkdtempSync(join(tmpdir(), 'talos-fatal-'))
}
