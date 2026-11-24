// A retried share is one share: the app sends an `Idempotency-Key` header, the relay answers a repeat with the first
// answer and does nothing else (docs/SHARE.md "Sending twice"). REAL relay, real HTTP, FakeBridge behind.
import { request } from 'node:http'
import { type FakeBridge, fakeClock, sleep, t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recorderOf } from '../../src/core/problems.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, PNG } from '../core/helpers.ts'

vi.setConfig({ testTimeout: t(30_000) })

let relay: TestRelay | null = null
const bridges: FakeBridge[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const b of bridges.splice(0)) await b.close()
  await relay?.stop()
  relay = null
})

const DEV = 'd_abcdefghijklmnopqrst'
const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e'
const DAY = 86_400_000
const sess = { 'X-Test-Session': DEV, Origin: ORIGIN, 'X-Talos-CSRF': '1' }

async function world(opts: Parameters<typeof startTestRelay>[0] = {}) {
  const r = await startTestRelay(opts)
  relay = r
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(DEV, 'phone', '{}', 'b', Date.now())
  const bridge = await kit(r).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
  bridges.push(bridge)
  return { relay: r, bridge }
}

async function mint(r: TestRelay, scopes = ['text', 'files']) {
  const res = await fetch(`${r.httpBase}/api/share/tokens`, {
    method: 'POST',
    headers: { ...sess, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'iPhone', scopes }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { token: { id: string }; secret: string }
}

const share = (r: TestRelay, secret: string, obj: unknown, key?: string) =>
  fetch(`${r.httpBase}/api/share`, {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
  })

const photo = () => {
  const fd = new FormData()
  fd.append('file', new Blob([PNG as BlobPart], { type: 'image/png' }), 'shot.png')
  return fd
}

const items = (b: FakeBridge) => b.rec.frames.filter((f) => f.direction === 'in' && f.raw.type === 'share.item')
const count = (r: TestRelay, table: string) =>
  (r.relay.services.db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n
const storedRows = (r: TestRelay) =>
  (
    r.relay.services.db.prepare("select count(*) n from core_events where type = 'message.stored'").get() as {
      n: number
    }
  ).n
const settle = () => sleep(t(300))

/** A multipart POST whose body is held back: the token is checked on the headers, the rest arrives on `finish()`. */
function slowShare(r: TestRelay, secret: string, text: string, key: string) {
  const boundary = '----talosonce'
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n--${boundary}--\r\n`,
  )
  const u = new URL(`${r.httpBase}/api/share`)
  const req = request({
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'idempotency-key': key,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  })
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (res) => {
      let b = ''
      res.on('data', (d) => {
        b += d
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.on('error', reject)
  })
  req.write(body.subarray(0, Math.floor(body.length / 2)))
  return {
    answer,
    req,
    finish: () => req.end(body.subarray(Math.floor(body.length / 2))),
  }
}

/** A POST of `bytes` sent in two parts with `pauseMs` between them; resolves with the status once the whole body is out. */
function slowBigShare(r: TestRelay, secret: string, key: string, bytes: Buffer, pauseMs: number) {
  const boundary = '----talosbig'
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n`)
  const body = Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
  const u = new URL(`${r.httpBase}/api/share`)
  return new Promise<number>((resolve, reject) => {
    let status = 0
    let answered = false
    let sent = false
    const done = () => answered && sent && resolve(status)
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'idempotency-key': key,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
      },
      (res) => {
        status = res.statusCode ?? 0
        res.resume()
        res.on('end', () => {
          answered = true
          done()
        })
      },
    )
    req.on('error', reject) // the server hung up on a body it never read
    req.on('finish', () => {
      sent = true
      done()
    })
    const half = Math.floor(body.length / 2)
    req.write(body.subarray(0, half))
    setTimeout(() => req.end(body.subarray(half)), pauseMs)
  })
}

describe('a retried share is one share', () => {
  it('the same key twice: both 202 with the same share_id, one row for the owner, one share.item for the Mac', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const first = await share(w.relay, secret, { text: 'read this', note: 'later' }, KEY)
    expect(first.status).toBe(202)
    const { share_id } = (await first.json()) as { share_id: string }
    const again = await share(w.relay, secret, { text: 'read this', note: 'later' }, KEY)
    expect(again.status).toBe(202)
    expect(await again.json()).toEqual({ share_id })
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
    const stored = w.relay.relay.services.db
      .prepare("select count(*) n from core_events where type = 'message.stored'")
      .get() as { n: number }
    expect(stored.n).toBe(1)
  })

  it('a repeat saves no media again and adds nothing to the share upload budget', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const send = () =>
      fetch(`${w.relay.httpBase}/api/share`, {
        method: 'POST',
        body: photo(),
        headers: { authorization: `Bearer ${secret}`, 'idempotency-key': KEY },
      })
    const a = await send()
    const b = await send()
    expect([a.status, b.status]).toEqual([202, 202])
    expect(((await b.json()) as { share_id: string }).share_id).toBe(
      ((await a.json()) as { share_id: string }).share_id,
    )
    expect(count(w.relay, 'core_media')).toBe(1)
    expect(count(w.relay, 'core_share_uploads')).toBe(1)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
  })

  it('a repeat does not touch the token (last used stays as the first share left it)', async () => {
    const w = await world()
    const { secret, token } = await mint(w.relay)
    await share(w.relay, secret, { text: 'x' }, KEY)
    const lastUsed = () =>
      (
        w.relay.relay.services.db.prepare('select last_used_at from core_share_tokens where id = ?').get(token.id) as {
          last_used_at: number
        }
      ).last_used_at
    const before = lastUsed()
    expect(before).toBeGreaterThan(0)
    w.relay.relay.services.db.prepare('update core_share_tokens set last_used_at = 1 where id = ?').run(token.id)
    await share(w.relay, secret, { text: 'x' }, KEY)
    expect(lastUsed()).toBe(1)
  })

  it('no key is a new share every time, as before', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const a = (await (await share(w.relay, secret, { text: 'x' })).json()) as { share_id: string }
    const b = (await (await share(w.relay, secret, { text: 'x' })).json()) as { share_id: string }
    expect(a.share_id).not.toBe(b.share_id)
    await settle()
    expect(items(w.bridge)).toHaveLength(2)
    expect(count(w.relay, 'core_share_keys')).toBe(0)
  })

  it('the key belongs to its token: another token with the same key is its own share', async () => {
    const w = await world()
    const one = await mint(w.relay)
    const two = await mint(w.relay)
    expect((await share(w.relay, one.secret, { text: 'x' }, KEY)).status).toBe(202)
    expect((await share(w.relay, two.secret, { text: 'x' }, KEY)).status).toBe(202)
    await settle()
    expect(items(w.bridge)).toHaveLength(2)
  })

  it('a key with different content is still the first share', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const a = (await (await share(w.relay, secret, { text: 'first' }, KEY)).json()) as { share_id: string }
    const b = await share(w.relay, secret, { text: 'second' }, KEY)
    expect(b.status).toBe(202)
    expect(((await b.json()) as { share_id: string }).share_id).toBe(a.share_id)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
    const sent = items(w.bridge)[0]?.raw as { message: { share_content: { text: string } } }
    expect(sent.message.share_content.text).toBe('first')
  })

  it('a malformed key is refused with a plain 400 and records nothing; a valid retry then goes through', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    for (const bad of [
      'short',
      'x'.repeat(65),
      'has space in it ok ok',
      'ünïcödé-key-1234567',
      'a/b/c/d/e/f/g/h/i/j',
    ]) {
      const res = await share(w.relay, secret, { text: 'x' }, bad)
      expect(res.status, bad).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad_request' })
    }
    await settle()
    expect(items(w.bridge)).toHaveLength(0)
    expect(count(w.relay, 'core_share_keys')).toBe(0)
    expect((await share(w.relay, secret, { text: 'x' }, KEY)).status).toBe(202)
  })

  it('a refused share (4xx) records nothing, so the fixed retry with the same key goes through', async () => {
    const w = await world()
    const text = await mint(w.relay, ['text'])
    const empty = await share(w.relay, text.secret, { note: '  ' }, KEY)
    expect(empty.status).toBe(400)
    const noFiles = await fetch(`${w.relay.httpBase}/api/share`, {
      method: 'POST',
      body: photo(),
      headers: { authorization: `Bearer ${text.secret}`, 'idempotency-key': KEY },
    })
    expect(noFiles.status).toBe(403)
    expect(count(w.relay, 'core_share_keys')).toBe(0)
    expect((await share(w.relay, text.secret, { text: 'now with words' }, KEY)).status).toBe(202)
    expect(count(w.relay, 'core_share_keys')).toBe(1)
  })

  it('a retry after a 429 goes through later with the same key', async () => {
    const clock = fakeClock()
    const w = await world({ clock })
    const { secret } = await mint(w.relay)
    for (let i = 0; i < 10; i++) expect((await share(w.relay, secret, { text: `n${i}` })).status).toBe(202) // the 10/min/IP budget
    const limited = await share(w.relay, secret, { text: 'x' }, KEY)
    expect(limited.status).toBe(429)
    expect(count(w.relay, 'core_share_keys')).toBe(0)
    clock.set(clock.now() + 61_000)
    const ok = await share(w.relay, secret, { text: 'x' }, KEY)
    expect(ok.status).toBe(202)
    expect(count(w.relay, 'core_share_keys')).toBe(1)
    await settle()
    expect(items(w.bridge)).toHaveLength(11)
  })

  it('a revoked token is refused with or without a key, even for a share it already sent', async () => {
    const w = await world()
    const { secret, token } = await mint(w.relay)
    expect((await share(w.relay, secret, { text: 'x' }, KEY)).status).toBe(202)
    const del = await fetch(`${w.relay.httpBase}/api/share/tokens/${token.id}`, { method: 'DELETE', headers: sess })
    expect(del.status).toBe(204)
    expect((await share(w.relay, secret, { text: 'x' }, KEY)).status).toBe(401)
    expect((await share(w.relay, secret, { text: 'x' })).status).toBe(401)
    expect((await share(w.relay, secret, { text: 'x' }, 'not valid')).status).toBe(401)
  })

  it('a failed step records nothing: the retry is a first attempt and the Mac gets it once', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    vi.spyOn(w.relay.runtime.hub, 'toBridge').mockRejectedValueOnce(new Error('disk full'))
    expect((await share(w.relay, secret, { text: 'x' }, KEY)).status).toBe(500)
    expect(count(w.relay, 'core_share_keys')).toBe(0)
    // The owner's apps were already told about the first attempt (their copy commits before the Mac's), so the retry
    // adds a second Inbox row there. The Mac still gets exactly one share (docs/SHARE.md "Sending twice").
    expect(storedRows(w.relay)).toBe(1)
    const ok = await share(w.relay, secret, { text: 'x' }, KEY)
    expect(ok.status).toBe(202)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
    expect(count(w.relay, 'core_share_keys')).toBe(1)
    expect(storedRows(w.relay)).toBe(2)
  })

  it('the record is written with the Mac queue entry: it holds the share_id, and rolls back with it', async () => {
    const w = await world()
    const { secret, token } = await mint(w.relay)
    const { share_id } = (await (await share(w.relay, secret, { text: 'x' }, KEY)).json()) as { share_id: string }
    expect(w.relay.relay.services.db.prepare('select token_id, idem_key, share_id from core_share_keys').all()).toEqual(
      [{ token_id: token.id, idem_key: KEY, share_id }],
    )
    // A write that fails inside the same transaction takes the record with it.
    const real = w.relay.runtime.hub.toBridge.bind(w.relay.runtime.hub)
    let handedTheRecordToTheQueueWrite = false
    vi.spyOn(w.relay.runtime.hub, 'toBridge').mockImplementationOnce((frame, opts) => {
      handedTheRecordToTheQueueWrite = typeof opts.alsoWrite === 'function'
      return real(frame, {
        ...opts,
        alsoWrite: () => {
          opts.alsoWrite?.()
          throw new Error('late failure')
        },
      })
    })
    expect((await share(w.relay, secret, { text: 'y' }, 'second-key-0123456789')).status).toBe(500)
    expect(handedTheRecordToTheQueueWrite).toBe(true)
    expect(count(w.relay, 'core_share_keys')).toBe(1)
  })
})

describe('two copies at once', () => {
  it('the second waits for the first and answers with its share_id; one share', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const slow = slowShare(w.relay, secret, 'slow words', KEY)
    await sleep(t(150)) // headers are in: the first is being processed
    const second = share(w.relay, secret, { text: 'slow words' }, KEY)
    await sleep(t(150))
    slow.finish()
    const [a, b] = [await slow.answer, await second]
    expect([a.status, b.status]).toEqual([202, 202])
    expect(((await b.json()) as { share_id: string }).share_id).toBe(
      (JSON.parse(a.body) as { share_id: string }).share_id,
    )
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
  })

  it('when the first one is refused, the waiting copy goes through on its own', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const slow = slowShare(w.relay, secret, '   ', KEY) // blank: refused as empty once it arrives
    await sleep(t(150))
    const second = share(w.relay, secret, { text: 'real words' }, KEY)
    await sleep(t(150))
    slow.finish()
    expect((await slow.answer).status).toBe(400)
    expect((await second).status).toBe(202)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
  })
})

describe('a stalled or dropped upload frees its key', () => {
  it('the idle deadline answers 408, and the same key sent again is accepted once', async () => {
    const clock = fakeClock()
    const w = await world({ clock })
    const { secret } = await mint(w.relay)
    const stalled = slowShare(w.relay, secret, 'stalled words', KEY)
    await sleep(t(200)) // headers and half the body are in; the rest never comes
    clock.advance(61_000)
    expect((await stalled.answer).status).toBe(408)
    const retry = await Promise.race([
      share(w.relay, secret, { text: 'stalled words' }, KEY),
      sleep(t(5000)).then(() => null),
    ])
    expect(retry, 'the retry waited on a dead upload').not.toBeNull()
    expect(retry?.status).toBe(202)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
    stalled.req.destroy()
  })

  it('a copy that waited behind a stalled upload and timed out takes nothing; the next retry is the one share', async () => {
    const clock = fakeClock()
    const w = await world({ clock })
    const { secret } = await mint(w.relay)
    const stalled = slowShare(w.relay, secret, 'stalled words', KEY)
    await sleep(t(200))
    const waiter = share(w.relay, secret, { text: 'stalled words' }, KEY).then((res) => res.status)
    await sleep(t(200))
    clock.advance(61_000)
    expect((await stalled.answer).status).toBe(408)
    expect(await Promise.race([waiter, sleep(t(5000)).then(() => 'stuck')])).toBe(408)
    await settle()
    expect(items(w.bridge)).toHaveLength(0)
    expect((await share(w.relay, secret, { text: 'stalled words' }, KEY)).status).toBe(202)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
    stalled.req.destroy()
  })

  it('a client that hangs up mid-upload frees the key', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const dropped = slowShare(w.relay, secret, 'dropped words', KEY)
    dropped.answer.catch(() => undefined)
    await sleep(t(200))
    dropped.req.destroy()
    await settle()
    expect((await share(w.relay, secret, { text: 'dropped words' }, KEY)).status).toBe(202)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
  })
})

describe('a repeat of a big upload is answered after its body is read', () => {
  it('a 3 MB photo retried over a slow socket still gets its 202, and nothing is saved again', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const first = await fetch(`${w.relay.httpBase}/api/share`, {
      method: 'POST',
      body: photo(),
      headers: { authorization: `Bearer ${secret}`, 'idempotency-key': KEY },
    })
    expect(first.status).toBe(202)
    // The server drops a connection whose request body is still unread half a second after it answered.
    const status = await slowBigShare(w.relay, secret, KEY, Buffer.alloc(3 * 1024 * 1024, 7), t(1200))
    expect(status).toBe(202)
    expect(count(w.relay, 'core_media')).toBe(1)
    await settle()
    expect(items(w.bridge)).toHaveLength(1)
  })
})

describe('a body over the cap', () => {
  it('a chunked share past the cap is a plain 413 and files no relay problem, with or without a key', async () => {
    const w = await world()
    const { secret } = await mint(w.relay, ['text'])
    const record = vi.spyOn(recorderOf(w.relay.relay.services), 'record')
    for (const key of [undefined, KEY]) {
      const u = new URL(`${w.relay.httpBase}/api/share`)
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: {
              authorization: `Bearer ${secret}`,
              'content-type': 'application/json',
              ...(key ? { 'idempotency-key': key } : {}),
            },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.write(Buffer.alloc(200 * 1024, 0x61)) // no Content-Length: chunked, over the 128 KiB text cap
        setTimeout(() => req.destroy(), t(2000)) // the relay must answer by itself, not wait for the end
      })
      expect(status).toBe(413)
    }
    await settle()
    expect(record).not.toHaveBeenCalled()
    expect(count(w.relay, 'core_share_keys')).toBe(0)
  })
})

describe('how long a key is kept', () => {
  it('kept for a day, and pruned (with a fresh share allowed) once old; each record prunes the old ones', async () => {
    const clock = fakeClock()
    const w = await world({ clock })
    const { secret } = await mint(w.relay)
    const first = (await (await share(w.relay, secret, { text: 'x' }, KEY)).json()) as { share_id: string }
    clock.set(clock.now() + DAY + 60_000)
    const sameDay = (await (await share(w.relay, secret, { text: 'x' }, KEY)).json()) as { share_id: string }
    expect(sameDay.share_id).toBe(first.share_id)
    clock.set(clock.now() + 3 * DAY)
    const later = (await (await share(w.relay, secret, { text: 'x' }, KEY)).json()) as { share_id: string }
    expect(later.share_id).not.toBe(first.share_id)
    expect(count(w.relay, 'core_share_keys')).toBe(1)
  })
})
