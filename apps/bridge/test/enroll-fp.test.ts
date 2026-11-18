// The setup link carries `fp=` (the bridge key's fingerprint) only when the relay answers its descriptor (BYOR).
import { describe, expect, test } from 'bun:test'
import {
  b64urlEncode,
  bridgeKeyFingerprint,
  generateBridgeKey,
  parseEnrollFragment,
  type RelayDescriptorReadT,
} from '@talos-app/protocol'
import type { BridgeEnv } from '../src/config.ts'
import { cmdEnroll, ENROLL_LINK_FP, type EnrollCli, type EnrollIO } from '../src/enroll-cli.ts'
import { RelayHttp } from '../src/relay-http.ts'
import { tempHome } from './helpers.ts'

const RELAY = 'https://relay.example'
const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const KEY = await generateBridgeKey().then((k) => ({
  privateKey: k.privateKey,
  publicKeyB64: k.publicKeyB64,
  keyId: k.keyId,
}))
const DESCRIPTOR: RelayDescriptorReadT = {
  protocol: 1,
  relay_version: '1.0.0',
  relay_id: 'r_abcdefghijklmnopqrst',
  kind: 'self',
  min_app: '1.0.0',
}

type Desc = Awaited<ReturnType<RelayHttp['descriptor']>>
const FOUND: Desc = { kind: 'found', descriptor: DESCRIPTOR }
const ABSENT: Desc = { kind: 'absent' }
const DOWN: Desc = { kind: 'unavailable' }

async function run(descriptor: () => Promise<Desc>, args: string[] = [], linkFp?: boolean) {
  const home = tempHome()
  const env = { home, relayUrl: RELAY } as BridgeEnv
  const out: string[] = []
  const events: Record<string, unknown>[] = []
  let now = 1_000_000
  const sent: unknown[] = []
  let asked = 0
  const io: EnrollIO = {
    out: (l) => out.push(l),
    emit: (l) => events.push(JSON.parse(l)),
    prompt: async () => 'n',
    sleep: async () => {
      now += 11 * 60_000 // the foreground wait gives up
    },
    now: () => now,
  }
  const cli: EnrollCli = {
    http: async () => ({
      enroll: async (b) => {
        sent.push(b)
        return { ok: true as const }
      },
      descriptor: async () => {
        asked++
        return descriptor()
      },
    }),
    relayUrl: () => RELAY,
    bridgeKeyB64: async () => b64urlEncode(RAW),
    bridge: () => ({ level: 'ok', text: 'ok' }),
    renderQr: async (t) => [`QR:${t}`],
    keyRefusedHint: async () => '',
    fail: (m) => new Error(m),
    ...(linkFp === undefined ? {} : { linkFp }),
  }
  const exit = await cmdEnroll(env, args, io, cli)
  const link = out.find((l) => l.startsWith(`${RELAY}/enroll#`)) as string
  const qr = out.find((l) => l.startsWith('QR:'))
  return { exit, link, qr, out, events, sent, asked }
}

const FP = bridgeKeyFingerprint(RAW)
const plainOf = (link: string) => link.split('&')[0] as string

// ENROLL_LINK_FP is on (the saved web bundle reads fp); off, the link is the one before BYOR phase 2, whatever the relay answers.
describe('enroll link fingerprint, switched off', () => {
  test('ENROLL_LINK_FP is on', () => expect(ENROLL_LINK_FP).toBe(true))
  test('text mode: a plain link and QR, the descriptor never asked, nothing about fp printed', async () => {
    const r = await run(async () => FOUND, [], false)
    expect(r.exit).toBe(0)
    expect(r.link).toBe(plainOf(r.link))
    expect(r.qr).toBe(`QR:${r.link}`)
    expect(r.asked).toBe(0)
    expect(r.out.some((l) => /fingerprint|phone app|older than/.test(l))).toBe(false)
  })
  test('--json: a plain link, no fp field, no fp warnings', async () => {
    const r = await run(async () => DOWN, ['--json'], false)
    expect(r.asked).toBe(0)
    const link = r.events.find((e) => e.event === 'link') as Record<string, unknown>
    expect(String(link.link)).toBe(plainOf(String(link.link)))
    expect(link.fp).toBeUndefined()
    expect(r.events.filter((e) => e.event === 'warning').map((e) => e.code)).toEqual([])
  })
})

describe('enroll link fingerprint, text mode', () => {
  test('a person at a terminal: the link and its QR carry fp= of this bridge key', async () => {
    const r = await run(async () => FOUND)
    expect(r.exit).toBe(0)
    expect(r.link.endsWith(`&fp=${FP}`)).toBe(true)
    expect(r.qr).toBe(`QR:${r.link}`)
    const p = parseEnrollFragment(r.link)
    expect(p.ok && p.fp).toBe(FP)
  })

  test('--no-qr: the FIRST link line is plain (the Mac app), a labelled second line has the fp link', async () => {
    const r = await run(async () => FOUND, ['--no-qr'])
    const i = r.out.findIndex((l) => l.startsWith(`${RELAY}/enroll#`))
    const p = parseEnrollFragment(r.out[i] as string)
    expect(p.ok && p.fp).toBeUndefined()
    if (p.ok) expect(r.out[i]).toBe(`${RELAY}/enroll#${p.code}`)
    const second = r.out[i + 1] as string
    expect(second).toBe(`For the Talos phone app: ${r.out[i]}&fp=${FP}`)
    // EnrollOutput.swift takes a line only if what precedes "/enroll#" is a bare relay origin: this one starts with words
    expect(second.startsWith(RELAY)).toBe(false)
    expect(r.out.filter((l) => l.startsWith(RELAY))).toHaveLength(1)
    expect(r.qr).toBeUndefined()
    expect(r.sent).toHaveLength(1)
  })

  test('404: a plain link and the one quiet old-relay line', async () => {
    const r = await run(async () => ABSENT)
    expect(r.link).toBe(plainOf(r.link))
    expect(r.out.some((l) => l.includes('no key fingerprint'))).toBe(false)
    expect(r.out).toContain('This relay is older than the Talos phone app needs; browsers are fine.')
    expect(r.sent).toHaveLength(1)
  })

  test('the descriptor unreadable: a plain link, the visible line, and enroll still succeeds', async () => {
    const r = await run(async () => DOWN)
    expect(r.exit).toBe(0)
    expect(r.link).toBe(plainOf(r.link))
    expect(r.out.some((l) => l.startsWith('This link carries no key fingerprint'))).toBe(true)
    expect(r.sent).toHaveLength(1)
  })

  test('--no-qr asks for the descriptor too, and says so when it cannot be read', async () => {
    const r = await run(async () => DOWN, ['--no-qr'])
    expect(r.asked).toBe(1)
    expect(r.out.some((l) => l.startsWith('This link carries no key fingerprint'))).toBe(true)
    expect(r.out.filter((l) => l.startsWith(RELAY))).toHaveLength(1)
  })
})

describe('enroll link fingerprint, --json', () => {
  test('the link event keeps the PLAIN link and adds fp', async () => {
    const r = await run(async () => FOUND, ['--json'])
    const ev = r.events.find((e) => e.event === 'link') as { link: string; fp?: string }
    expect(ev.fp).toBe(FP)
    expect(ev.link).toBe(plainOf(ev.link))
    expect(ev.link).toMatch(/^https:\/\/relay\.example\/enroll#[0-9A-Z]{26}$/)
    expect(r.events.some((e) => e.event === 'warning')).toBe(false)
  })

  test('404: no fp field, an old_relay warning', async () => {
    const r = await run(async () => ABSENT, ['--json'])
    const ev = r.events.find((e) => e.event === 'link') as Record<string, unknown>
    expect('fp' in ev).toBe(false)
    expect(r.events.filter((e) => e.event === 'warning').map((e) => e.code)).toEqual(['old_relay'])
  })

  test('unreadable descriptor: a no_fp warning before the link, no fp field', async () => {
    const r = await run(async () => DOWN, ['--json'])
    expect(r.events.map((e) => e.event).slice(0, 2)).toEqual(['warning', 'link'])
    expect(r.events[0]).toMatchObject({ event: 'warning', code: 'no_fp' })
    expect('fp' in (r.events[1] as object)).toBe(false)
  })
})

describe('RelayHttp.descriptor', () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const mk = (...answers: Array<() => Promise<Response>>) => {
    calls.length = 0
    let i = 0
    const f = (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) })
      return (answers[Math.min(i++, answers.length - 1)] as () => Promise<Response>)()
    }
    return new RelayHttp(RELAY, () => KEY, f as never, 30)
  }
  const res =
    (status: number, body = '') =>
    () =>
      Promise.resolve(new Response(body, { status }))
  const good = res(200, JSON.stringify({ ...DESCRIPTOR, extra: 1 }))

  test('200 valid is found; extra fields are ignored', async () => {
    expect(await mk(good).descriptor()).toEqual({ kind: 'found', descriptor: DESCRIPTOR })
  })
  test('404 is absent, asked once', async () => {
    expect(await mk(res(404)).descriptor()).toEqual({ kind: 'absent' })
    expect(calls).toHaveLength(1)
  })
  test('500 twice is unavailable (one retry)', async () => {
    expect(await mk(res(500)).descriptor()).toEqual({ kind: 'unavailable' })
    expect(calls).toHaveLength(2)
  })
  test('500 then 200 is found', async () => {
    expect(await mk(res(500), good).descriptor()).toEqual({ kind: 'found', descriptor: DESCRIPTOR })
    expect(calls).toHaveLength(2)
  })
  test('bad JSON and a wrong shape are unavailable', async () => {
    expect(await mk(res(200, '{')).descriptor()).toEqual({ kind: 'unavailable' })
    expect(await mk(res(200, '{"kind":"x"}')).descriptor()).toEqual({ kind: 'unavailable' })
  })
  test('a timeout is unavailable', async () => {
    const http = new RelayHttp(
      RELAY,
      () => KEY,
      ((_u: string, init?: RequestInit) =>
        new Promise<Response>((_, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new Error('timeout'))),
        )) as never,
      20,
    )
    expect(await http.descriptor()).toEqual({ kind: 'unavailable' })
  })
  test('the request carries no Authorization header, and goes to the descriptor path', async () => {
    await mk(good).descriptor()
    const h = new Headers(calls[0]?.init?.headers)
    expect(h.has('authorization')).toBe(false)
    expect(calls[0]?.url).toBe(`${RELAY}/.well-known/talos-relay`)
  })
})
