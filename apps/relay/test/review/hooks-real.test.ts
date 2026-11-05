// Review fixes #2 and #3 against the real relay over HTTP: real auth rate limits, real hook pipeline, real sockets.
import { connect } from 'node:net'
import { signStandard } from '@talos-app/integrations'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Owner, type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

type Created = { id: string; hook_url: string; secret?: string; claim_code?: string }

async function create(rr: RealRelay, o: Owner, integration: string): Promise<Created> {
  const res = await rr.post('/api/connections', { integration, name: `${integration} test` }, o)
  if (res.status !== 201) throw new Error(`create ${integration}: ${res.status} ${await res.text()}`)
  return (await res.json()) as Created
}

function signed(rr: RealRelay, c: Created, n: number, secret = c.secret as string) {
  const body = JSON.stringify({ title: `event ${n}` })
  return fetch(`${rr.httpBase}/hook/generic/${c.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signStandard({
        secret,
        id: `msg_${n}_${Math.random().toString(36).slice(2)}`,
        timestampS: Math.floor(rr.relay.services.clock.now() / 1000),
        body,
      }),
    },
    body,
  })
}

/** A raw HTTP/1.1 request that sends its headers and a few body bytes, then waits for the status line. 0 = no answer. */
function rawPost(port: number, path: string, headers: string[], bodySoFar: string, waitMs = 1500): Promise<number> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    let done = false
    const finish = (n: number) => {
      if (done) return
      done = true
      s.destroy()
      resolve(n)
    }
    s.on('data', (d) => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(d.toString())
      if (m) finish(Number(m[1]))
    })
    s.on('error', () => finish(-1))
    s.on('connect', () => {
      s.write(
        [`POST ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Content-Type: application/json', ...headers, '', ''].join('\r\n'),
      )
      s.write(bodySoFar)
    })
    setTimeout(() => finish(0), waitMs)
  })
}

describe('#3 junk cannot 429 real senders', () => {
  it('700 requests to unknown connection ids do not touch a real connection budget', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const c = await create(r, owner, 'generic')
    const junkId = (i: number) => `cn_${String(i).padStart(22, 'x')}`
    for (let batch = 0; batch < 14; batch++) {
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          fetch(`${r?.httpBase}/hook/generic/${junkId(batch * 50 + i)}`, { method: 'POST', body: '{}' }).then((x) =>
            x.arrayBuffer(),
          ),
        ),
      )
    }
    const res = await signed(r, c, 1)
    expect(res.status).toBe(200)
  })

  it('unsigned junk aimed at a real connection id does not spend its budget', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const c = await create(r, owner, 'generic')
    for (let i = 0; i < 150; i++) {
      const x = await fetch(`${r.httpBase}/hook/generic/${c.id}`, { method: 'POST', body: '{}' })
      await x.arrayBuffer()
    }
    expect((await signed(r, c, 2)).status).toBe(200)
  })

  it('one connection is held to 120 a minute and its neighbour is not', async () => {
    // The bucket refills at 2 tokens a second on whatever clock the relay runs on. On the real clock a loaded machine
    // spreads the 130 requests over seconds and refills extra tokens mid-burst, so the count drifted (123 seen). A
    // frozen injected clock makes the burst one instant: exactly the 120-token capacity is admitted.
    r = await startRealRelay({ clock: fakeClock(new Date().toISOString()) })
    const owner = await r.owner()
    const a = await create(r, owner, 'generic')
    const b = await create(r, owner, 'generic')
    const codes = await Promise.all(
      Array.from({ length: 130 }, (_, i) => signed(r as RealRelay, a, i).then((x) => x.status)),
    )
    expect(codes.filter((s) => s === 200).length).toBe(120)
    expect(codes.filter((s) => s === 429).length).toBe(10)
    expect((await signed(r, b, 1)).status).toBe(200)
  })
})

describe('#2 the claim endpoint never buffers an anonymous body', () => {
  it('an unknown connection answers 404 without waiting for a 100 MB body', async () => {
    r = await startRealRelay()
    const id = `cn_${'q'.repeat(22)}`
    const status = await rawPost(r.relay.port, `/hook/gmail/${id}/claim`, ['Content-Length: 100000000'], '{"claim_')
    expect(status).toBe(404)
  })

  it('a real connection answers 413 to a body that declares more than a kilobyte', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const c = await create(r, owner, 'gmail')
    const status = await rawPost(r.relay.port, `/hook/gmail/${c.id}/claim`, ['Content-Length: 100000000'], '{"claim_')
    expect(status).toBe(413)
  })

  it('a chunked body that outgrows a kilobyte is cut off with 413', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const c = await create(r, owner, 'gmail')
    const chunk = 'a'.repeat(4096)
    const status = await rawPost(
      r.relay.port,
      `/hook/gmail/${c.id}/claim`,
      ['Transfer-Encoding: chunked'],
      `${(4096).toString(16)}\r\n${chunk}\r\n`,
    )
    expect(status).toBe(413)
  })

  it('a normal claim still works', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const c = await create(r, owner, 'gmail')
    const res = await fetch(`${r.httpBase}/hook/gmail/${c.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_code: c.claim_code }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { secret: string }).secret).toMatch(/^whsec_/)
  })
})
