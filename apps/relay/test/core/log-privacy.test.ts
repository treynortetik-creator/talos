// gate-reads: apps/relay/src/*.ts
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, installConsoleScrub, logHashKeyFor, scrubError, scrubText } from '../../src/core/log.ts'

function capture(hashKey = 'k1') {
  const lines: string[] = []
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  })
  return { log: createLogger('debug', { hashKey, destination }), out: () => lines.join('') }
}

// Values a log line must never carry, in the shapes they really arrive in.
const IPV4 = '203.0.113.77'
const IPV6 = '2001:db8:85a3:1234:5678:8a2e:370:7334'
const IPV6_SHORT = '2001:db8::ff00:42:8329'
const MAPPED = '::ffff:198.51.100.9'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
const URLV = 'https://relay.example.test/v2/share/abc123?token=SECRETQ&u=1'
const PATHV = `/3/device/${'a1b2c3d4'.repeat(8)}`
const APNS_TOKEN = 'ab12cd34'.repeat(8)
const FCM_TOKEN = `${'fcm'.repeat(10)}:${'APA91bH'.repeat(25)}`
const DEVICE_NAME = 'Quincy’s iPhone 15 Pro'
const OSVER = 'iOS 17.4.1'
const SECRETS = [
  IPV4,
  IPV6,
  IPV6_SHORT,
  '198.51.100.9',
  'AppleWebKit',
  'iPhone OS',
  URLV,
  'SECRETQ',
  'abc123',
  PATHV,
  '/3/device',
  APNS_TOKEN,
  FCM_TOKEN,
  DEVICE_NAME,
  OSVER,
  'iPhone 15',
]

const PAYLOADS: Array<[string, Record<string, unknown>]> = [
  [
    'address keys',
    {
      ip: IPV4,
      old_ip: IPV6,
      new_ip: IPV6_SHORT,
      holder_ip: MAPPED,
      standby_ip: IPV4,
      clientIp: IPV4,
      ips: [IPV4, IPV6],
    },
  ],
  [
    'agent and url keys',
    {
      user_agent: UA,
      userAgent: UA,
      ua: UA,
      url: URLV,
      uri: URLV,
      href: URLV,
      endpoint: URLV,
      path: PATHV,
      query: 'token=SECRETQ',
      origin: URLV,
      host: 'relay.example.test',
      referer: URLV,
      headers: { 'user-agent': UA, 'x-real-ip': IPV4 },
    },
  ],
  [
    'device details',
    {
      device_name: DEVICE_NAME,
      deviceModel: 'iPhone 15 Pro',
      device_os: OSVER,
      os_version: OSVER,
      model: 'iPhone 15 Pro',
      os: OSVER,
      platform: 'ios',
      push_token: APNS_TOKEN,
      deviceToken: APNS_TOKEN,
      apns_token: APNS_TOKEN,
      fcm_token: FCM_TOKEN,
      registration_id: FCM_TOKEN,
      device: { name: DEVICE_NAME, model: 'iPhone 15 Pro', os: OSVER, token: APNS_TOKEN },
    },
  ],
  [
    'values hidden inside innocent keys',
    {
      err: `connect ECONNREFUSED ${IPV4}:443 for ${URLV}`,
      note: `from ${IPV6} with ${UA}`,
      why: `bad ${PATHV}`,
      tok: APNS_TOKEN,
      nested: { deep: { err: `${IPV6_SHORT} ${URLV}` } },
      list: [`x ${IPV4}`, URLV],
    },
  ],
  [
    'an Error object as a field',
    {
      err: Object.assign(new Error(`getaddrinfo failed ${URLV} ${IPV4}`), { code: 'EAI', stack: `Error: at ${PATHV}` }),
    },
  ],
  [
    'push-shaped',
    {
      status: 410,
      reason: 'BadDeviceToken',
      env: 'production',
      gone: true,
      device: { token: APNS_TOKEN, env: 'production', name: DEVICE_NAME },
    },
  ],
]

describe('relay logs carry no address, user agent, URL or device detail (item 0.20)', () => {
  for (const [name, payload] of PAYLOADS) {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      it(`${name}: nothing sensitive reaches ${level}`, () => {
        const { log, out } = capture()
        log[level](payload, `message mentioning ${IPV4} and ${URLV}`)
        log.child({ mod: 'x', ...payload })[level]({ ok: 1 }, 'child line')
        const text = out()
        for (const s of SECRETS) expect(text, `leaked ${s}`).not.toContain(s)
        expect(text).toContain('message mentioning')
      })
    }
  }

  it('a plain string message and a bare Error are scrubbed too', () => {
    const { log, out } = capture()
    log.info(`peer ${IPV4} sent ${URLV}`)
    log.error(new Error(`failed for ${IPV6_SHORT} at ${URLV}`))
    for (const s of [IPV4, IPV6_SHORT, URLV, 'SECRETQ']) expect(out()).not.toContain(s)
    expect(out()).toContain('Error')
  })

  it('a client is still told apart: the same address hashes the same, another differently, and the key matters', () => {
    const a = capture('key-one')
    a.log.info({ ip: IPV4 }, 'x')
    a.log.info({ ip: IPV4 }, 'y')
    a.log.info({ ip: '203.0.113.78' }, 'z')
    const hs = a.out().match(/"ip":"(h:[0-9a-f]{10})"/g) ?? []
    expect(hs).toHaveLength(3)
    expect(hs[0]).toBe(hs[1])
    expect(hs[0]).not.toBe(hs[2])
    const b = capture('key-two')
    b.log.info({ ip: IPV4 }, 'x')
    expect(b.out().match(/"ip":"(h:[0-9a-f]{10})"/)?.[0]).not.toBe(hs[0])
  })

  it('keeps what operators need: ids, counts, codes, templates, error names', () => {
    const { log, out } = capture()
    log.warn(
      {
        device_id: 'dev_123',
        report_id: 'r-9',
        status: 410,
        template: 'session_stopped',
        err: 'TypeError',
        skew_s: 130,
        ms: 12,
      },
      'ok',
    )
    const text = out()
    for (const s of ['dev_123', 'r-9', '410', 'session_stopped', 'TypeError', '130']) expect(text).toContain(s)
  })

  it('times and version numbers are not mistaken for addresses', () => {
    expect(scrubText('at 08:30:15 on build 1.2.3 (4 of 12)')).toBe('at 08:30:15 on build 1.2.3 (4 of 12)')
  })

  it('scrubError gives one line, no stack', () => {
    const e = new Error(`bad ${URLV}`)
    const s = scrubError(e)
    expect(s).not.toContain('SECRETQ')
    expect(s).not.toContain('\n')
  })
})

describe('no output path goes around the logger', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = join(import.meta.dirname, '../../src')
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) files.push(p)
    }
  }
  walk(src)

  it('only log.ts builds a pino instance or writes to stdout/stderr streams', () => {
    for (const f of files) {
      if (f.endsWith('core/log.ts')) continue
      const t = readFileSync(f, 'utf8')
      expect(t, f).not.toMatch(/from 'pino'|process\.std(out|err)\.write/)
    }
  })

  it('every console.* call prints a fixed string or exactly scrubError(name), and no console method is passed by reference', () => {
    for (const f of files) {
      if (f.endsWith('core/log.ts')) continue // the one place that wraps the console
      const t = readFileSync(f, 'utf8')
      for (const m of t.matchAll(/console\.(log|info|warn|error|debug)\(([^;\n]*)/g)) {
        const arg = (m[2] ?? '').trim()
        const ok = /^(['"][^'"$]*['"]|`[^`$]*`)\)$/.test(arg) || /^scrubError\(\w+\)\)+$/.test(arg)
        expect(ok, `${f}: console.${m[1]}(${arg}`).toBe(true)
      }
      for (const m of t.matchAll(/console\.(log|info|warn|error|debug)(?!\w)(?!\()/g))
        expect(f.endsWith('version.ts') || f.endsWith('core/log.ts'), `${f}: console.${m[1]} used by reference`).toBe(
          true,
        )
    }
  })

  it('pino is not imported in any form outside log.ts', () => {
    for (const f of files) {
      if (f.endsWith('core/log.ts')) continue
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/pino/)
    }
  })
})

describe('a real relay with the real logger', () => {
  it('two bridges, a refused hello and a push: the lines name no address', async () => {
    const { startRealRelay } = await import('../review/real-relay.ts')
    const { FakeBridge, waitFor } = await import('@talos-app/testkit')
    const { log, out } = capture('relay-key')
    const r = await startRealRelay({ log })
    try {
      const first = await r.bridge().connect()
      await r.bridge().connect()
      await waitFor(() => first.closeCode === 4409, 10_000, 'first bridge replaced')
      expect(
        await new FakeBridge({ relayWs: r.wsBase, key: r.bridgeKey, standby: true }).connectExpectingRefusal(),
      ).toBe(4409)
      const text = out()
      expect(text).toContain('two bridges are connected')
      expect(text).toContain('a new bridge hello replaced')
      expect(text).toMatch(/"holder_ip":"h:[0-9a-f]{10}"/)
      expect(text).not.toMatch(/127\.0\.0\.1|::1|localhost/)
    } finally {
      await r.stop()
    }
  })
})

describe('second round (review L-1 to L-10)', () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['v6 after colon', { n: 'peer:2001:db8::1 hung up' }, ['2001:db8']],
    ['v6 after underscore', { n: 'ip_2001:db8::1' }, ['2001:db8']],
    ['v6 full after colon', { n: 'client:2001:db8:85a3:1234:5678:8a2e:370:7334' }, ['85a3']],
    ['v4 after underscore', { n: 'from_203.0.113.7' }, ['203.0.113.7']],
    ['v4 after letter', { n: 'x203.0.113.7' }, ['203.0.113.7']],
    ['dashed rdns', { n: 'host ec2-203-0-113-7.compute.example' }, ['203-0-113-7']],
    ['v6 zone', { n: 'fe80:0:0:0:1:2:3:4%en0' }, ['fe80', 'en0']],
    ['v6 brackets and port', { n: '[2001:db8::1]:443' }, ['2001:db8']],
    ['buffer', { blob: Buffer.from('203.0.113.7') }, ['"0":50', '203.0.113.7']],
    ['typed array', { blob: new Uint8Array(Buffer.from('2001:db8::1')) }, ['"0":50']],
    [
      'deep secrets',
      {
        a: {
          b: {
            token: 'tok-SHORTSECRET',
            code: 'ABCD-1234',
            cookie: 'sid=XYZ',
            password: 'hunter2',
            api_key: 'sk_live_abc',
          },
        },
      },
      ['SHORTSECRET', 'ABCD-1234', 'sid=XYZ', 'hunter2', 'sk_live_abc'],
    ],
    [
      'secret in array',
      { list: [{ token: 'tok-INARRAY' }, { Authorization: 'Bearer abcdef' }] },
      ['INARRAY', 'abcdef'],
    ],
    ['email', { n: 'owner alex@example.com wrote' }, ['alex@example.com']],
    ['bare query', { n: 'GET ?token=SECRETQ&x=1' }, ['SECRETQ']],
    ['schemeless url', { n: 'relay.example.test/v2/share/abc?token=SECRETQ' }, ['SECRETQ', 'v2/share']],
    [
      'upper-case address keys',
      {
        IP: '203.0.113.7',
        clientIP: '203.0.113.7',
        'x-forwarded-for': '203.0.113.7, 198.51.100.2',
        remote_addr: '198.51.100.2',
      },
      ['203.0.113.7', '198.51.100.2'],
    ],
    ['map with address key', { m: new Map([['ip', '203.0.113.7']]) }, ['203.0.113.7']],
    ['error cause', { err: new Error('outer', { cause: new Error('cause at 203.0.113.7') }) }, ['203.0.113.7']],
    ['aggregate', { err: new AggregateError([new Error('203.0.113.7')], 'all failed') }, ['203.0.113.7']],
  ]
  for (const [name, payload, banned] of cases) {
    it(`${name}: nothing sensitive is printed`, () => {
      const { log, out } = capture()
      log.info(payload, 'm')
      for (const b of banned) expect(out(), `leaked ${b}`).not.toContain(b)
    })
  }

  it('address keys in any case or spelling hash the same way (clients stay distinguishable)', () => {
    const { log, out } = capture()
    log.info(
      { IP: '203.0.113.7', clientIP: '203.0.113.7', 'x-forwarded-for': '203.0.113.7', remote_addr: '203.0.113.7' },
      'm',
    )
    const hs = out().match(/h:[0-9a-f]{10}/g) ?? []
    expect(hs).toHaveLength(4)
    expect(new Set(hs).size).toBe(1)
  })

  it('a buffer prints only its length', () => {
    const { log, out } = capture()
    log.info({ blob: Buffer.alloc(5000) }, 'm')
    expect(out()).toContain('[bytes 5000]')
    expect(out().length).toBeLessThan(300)
  })

  it('keeps useful error data: code, a scrubbed cause, aggregate members; and device numbers, booleans and dates', () => {
    const { log, out } = capture()
    log.error(
      { err: Object.assign(new Error('x', { cause: new Error('inner problem') }), { code: 'ECONNREFUSED' }) },
      'm',
    )
    log.info({ device_count: 3, devices: 2, device_pinned: true, device_name: 'Quincy phone', at: new Date(0) }, 'm')
    const t = out()
    expect(t).toContain('ECONNREFUSED')
    expect(t).toContain('inner problem')
    expect(t).toContain('"device_count":3')
    expect(t).toContain('"device_pinned":true')
    expect(t).toContain('1970-01-01T00:00:00.000Z')
    expect(t).not.toContain('Quincy phone')
  })

  it('the default hash key comes from DATA_KEY: stable, different per key, and not the key itself', () => {
    const dk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    expect(logHashKeyFor(dk, undefined)).toBe(logHashKeyFor(dk, undefined))
    expect(logHashKeyFor(dk, undefined)).not.toBe(
      logHashKeyFor('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', undefined),
    )
    expect(logHashKeyFor(dk, undefined)).not.toContain(dk)
    expect(logHashKeyFor(dk, 'override-key')).toBe('override-key')
  })

  it('a console wrapper scrubs everything any code prints, including a dependency handing it a raw error', () => {
    const seen: unknown[][] = []
    const fake = {
      error: (...a: unknown[]) => void seen.push(a),
      warn: (...a: unknown[]) => void seen.push(a),
      info: (...a: unknown[]) => void seen.push(a),
      log: (...a: unknown[]) => void seen.push(a),
      debug: (...a: unknown[]) => void seen.push(a),
    } as unknown as Console
    const restore = installConsoleScrub(fake, 'shared-key')
    fake.error(new Error(`boom at ${URLV} from ${IPV4}`), `raw ${IPV6_SHORT}`, { ip: IPV4, url: URLV })
    fake.warn(`warn ${IPV4}`)
    const text = JSON.stringify(seen)
    for (const s of [IPV4, IPV6_SHORT, 'SECRETQ', URLV]) expect(text).not.toContain(s)
    expect(seen).toHaveLength(2)
    // the wrapper hashes with the logger's key: the same address gives the same hash in both
    seen.length = 0
    fake.info({ ip: IPV4 })
    const lg = capture('shared-key')
    lg.log.info({ ip: IPV4 }, 'x')
    const wrapped = /h:[0-9a-f]{10}/.exec(JSON.stringify(seen))?.[0]
    expect(wrapped).toBeDefined()
    expect(lg.out()).toContain(wrapped as string)
    restore()
  })

  it('a WebSocket handler that throws reaches the logger, not the raw console', async () => {
    const { startRealRelay } = await import('../review/real-relay.ts')
    const { log, out } = capture()
    const r = await startRealRelay({ log })
    try {
      const hub = r.runtime.hub as unknown as { attachApp: (...a: unknown[]) => unknown }
      hub.attachApp = () => {
        throw new Error(`handler failed for ${IPV4}`)
      }
      const owner = await r.owner()
      const app = r.app(owner)
      void app.connect().catch(() => {}) // never becomes ready: the handler throws, so do not wait for it
      const { waitFor } = await import('@talos-app/testkit')
      await waitFor(() => out().includes('socket handler threw'), 10_000, 'the handler error reaches the logger')
      expect(out()).not.toContain(IPV4)
      await app.close().catch(() => {})
    } finally {
      await r.stop()
    }
  })
})
