// Wrong pairing codes lock out the guesser's network, never the holder of a real code (spec 5.2).
import { deriveEnrollAuth, enrollAuthHash, enrollCodeId, newEnrollCode } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { pickLockoutKey } from '../../src/client-ip.ts'
import { afterEachReset, makeHarness } from './helpers.ts'

afterEach(afterEachReset)

const WINDOW_MS = 10 * 60_000
const ipA = { 'X-Real-IP': '198.51.100.1' }
const ipB = { 'X-Real-IP': '198.51.100.2' }

async function newCode(h: Awaited<ReturnType<typeof makeHarness>>) {
  const code = newEnrollCode()
  const codeAuth = deriveEnrollAuth(code)
  const hash = enrollAuthHash(codeAuth)
  const res = await h.bridgePost('/bridge/enroll', {
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(h.fake.clock.now() + WINDOW_MS).toISOString(),
    label: 'test',
  })
  expect(res.status).toBe(200)
  return { codeAuth, codeId: enrollCodeId(hash) }
}

async function missFrom(h: Awaited<ReturnType<typeof makeHarness>>, ip: Record<string, string>, n: number) {
  for (let i = 0; i < n; i++) {
    const res = await h.post('/api/auth/enroll/options', { code_auth: `wrong-${i}` }, undefined, ip)
    expect(res.status).toBe(410)
  }
}

describe('per-IP enroll lockout', () => {
  it('five wrong codes from IP A leave the owner real code, used from IP B, working and unburned', async () => {
    const h = await makeHarness()
    const real = await newCode(h)
    await missFrom(h, ipA, 5)
    expect(h.state.core.findCode(real.codeAuth)).not.toBeNull()
    const res = await h.post('/api/auth/enroll/options', { code_auth: real.codeAuth }, undefined, ipB)
    expect(res.status).toBe(200)
    expect(h.state.core.findCode(real.codeAuth)).not.toBeNull()
  })

  it('IP A is locked for the window even with the correct code, then works again', async () => {
    const h = await makeHarness()
    const real = await newCode(h)
    await missFrom(h, ipA, 5)
    const locked = await h.post('/api/auth/enroll/options', { code_auth: real.codeAuth }, undefined, ipA)
    expect(locked.status).toBe(429)
    expect(await locked.json()).toEqual({ error: 'too_many_attempts' })
    h.fake.clock.advance(WINDOW_MS + 1000) // the first code has expired by now; a fresh one works from A again
    const fresh = await newCode(h)
    expect((await h.post('/api/auth/enroll/options', { code_auth: fresh.codeAuth }, undefined, ipA)).status).toBe(200)
  })

  it('a locked-out call records nothing, so the lockout ends when the first five misses age out', async () => {
    const h = await makeHarness()
    await missFrom(h, ipA, 5)
    for (let i = 0; i < 3; i++) {
      h.fake.clock.advance(30_000)
      expect((await h.post('/api/auth/enroll/options', { code_auth: 'x' }, undefined, ipA)).status).toBe(429)
    }
    expect(h.fake.db.prepare('select count(*) from auth_enroll_failures').pluck().get()).toBe(5)
  })
})

describe('the lockout key is never a shared address', () => {
  const miss = (h: Awaited<ReturnType<typeof makeHarness>>, headers: Record<string, string>) =>
    h.post('/api/auth/enroll/options', { code_auth: 'wrong' }, undefined, headers)

  it('X-Forwarded-For alone (hops 1) never locks anyone out', async () => {
    const h = await makeHarness()
    const real = await newCode(h)
    for (let i = 0; i < 8; i++) {
      h.fake.clock.advance(10_000)
      expect((await miss(h, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(410)
    }
    expect(h.fake.db.prepare('select count(*) from auth_enroll_failures').pluck().get()).toBe(0)
    expect(
      (
        await h.post('/api/auth/enroll/options', { code_auth: real.codeAuth }, undefined, {
          'X-Forwarded-For': '198.51.100.1',
        })
      ).status,
    ).toBe(200)
  })

  it('duplicate X-Real-IP values never lock anyone out', async () => {
    const h = await makeHarness()
    for (let i = 0; i < 8; i++) {
      h.fake.clock.advance(10_000)
      expect((await miss(h, { 'X-Real-IP': '198.51.100.1, 198.51.100.2' })).status).toBe(410)
    }
    expect(h.fake.db.prepare('select count(*) from auth_enroll_failures').pluck().get()).toBe(0)
  })

  it('a single valid X-Real-IP is the key', async () => {
    const h = await makeHarness()
    for (let i = 0; i < 5; i++) {
      h.fake.clock.advance(10_000)
      expect((await miss(h, { 'X-Real-IP': '198.51.100.1' })).status).toBe(410)
    }
    expect((await miss(h, { 'X-Real-IP': '198.51.100.1' })).status).toBe(429)
  })
})

describe('pickLockoutKey', () => {
  it('hops 0: the socket peer is the key and headers are ignored', () => {
    expect(pickLockoutKey({ hops: 0, remote: '203.0.113.5', realIp: '198.51.100.1', xff: '198.51.100.2' })).toBe(
      '203.0.113.5',
    )
    expect(pickLockoutKey({ hops: 0 })).toBeNull()
  })
  it('hops > 0: only a single valid X-Real-IP', () => {
    expect(pickLockoutKey({ hops: 1, remote: '10.0.0.1', realIp: '198.51.100.1' })).toBe('198.51.100.1')
    expect(pickLockoutKey({ hops: 1, remote: '10.0.0.1', xff: '198.51.100.1, 10.0.0.2' })).toBeNull()
    expect(pickLockoutKey({ hops: 1, remote: '10.0.0.1', realIp: 'a, b' })).toBeNull()
    expect(pickLockoutKey({ hops: 2, remote: '10.0.0.1', realIp: 'nope' })).toBeNull()
  })
})
