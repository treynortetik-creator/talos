// A device's "last used" time: written when the device is really in use (an authenticated request, a frame that shows a
// person, a signed notification action), at most once per window, never for another device and never for a revoked one.
// Not written by a socket upgrade or by the relay's own session checks (the real-socket cases are in
// device-last-used-socket.test.ts).
import { afterEach, describe, expect, it } from 'vitest'
import { noteDeviceUse, sessionActive } from '../../src/auth/contract.ts'
import { AuthCore, DEVICE_USE_INTERVAL_MS, DEVICE_USE_RETRY_MS } from '../../src/auth/core.ts'
import { afterEachReset, makeHarness, newDevice } from './helpers.ts'

afterEach(afterEachReset)

type H = Awaited<ReturnType<typeof makeHarness>>

async function phone(h: H, name: string, credentialId = 'cred-1') {
  const d = await newDevice()
  h.state.core.upsertDevice({
    id: d.id as never,
    name,
    pubkeyJwk: d.jwk,
    credentialId,
    binding: 'b',
    codeId: `c-${d.id}`,
  })
  h.state.core.setPinned(d.id, true)
  return { ...d, cookie: h.login(credentialId, d.id) }
}
const lastUsed = (h: H, id: string) => h.state.core.device(id)?.lastUsedAt ?? null
const writes = (h: H) => h.state.core.db.prepare('select total_changes()').pluck().get() as number

describe('last used is written on real device activity', () => {
  it('a device that has never been seen reads null until its session makes a request', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    expect(lastUsed(h, a.id)).toBeNull()
    expect((await h.app.request('/api/me', { headers: { Cookie: a.cookie } })).status).toBe(200)
    expect(lastUsed(h, a.id)).toBe(h.fake.clock.now())
    // and the owner-facing list says so
    const list = (await (await h.app.request('/api/devices', { headers: { Cookie: a.cookie } })).json()) as Array<{
      id: string
      last_used_at: string | null
    }>
    expect(list.find((d) => d.id === a.id)?.last_used_at).toBe(new Date(h.fake.clock.now()).toISOString())
  })

  it('a socket upgrade does not count as use (a tab left open reconnects by itself)', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    expect(
      (await h.app.request('/probe/ws', { headers: { Cookie: a.cookie, Origin: 'https://relay.example.com' } })).status,
    ).toBe(200)
    expect(lastUsed(h, a.id)).toBeNull()
  })

  it('the session check never stamps; an explicit use does, once per window', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    const session = {
      sessionId: h.state.core.lookupSession(a.cookie.split('=')[1] as string)?.id as string,
      deviceId: a.id,
    }
    const before = writes(h)
    for (let i = 0; i < 200; i++) expect(sessionActive(session)).toBe(true)
    expect(lastUsed(h, a.id)).toBeNull()
    expect(writes(h)).toBe(before)

    noteDeviceUse(a.id)
    const first = lastUsed(h, a.id)
    expect(first).toBe(h.fake.clock.now())
    const afterFirst = writes(h)
    h.fake.clock.advance(DEVICE_USE_INTERVAL_MS - 1)
    for (let i = 0; i < 50; i++) noteDeviceUse(a.id)
    expect(lastUsed(h, a.id)).toBe(first)
    expect(writes(h)).toBe(afterFirst)
    h.fake.clock.advance(2)
    noteDeviceUse(a.id)
    expect(lastUsed(h, a.id)).toBe(h.fake.clock.now())
    expect(writes(h)).toBe(afterFirst + 1)
    noteDeviceUse(null) // a session with no device is a no-op, not a throw
  })

  it("one device's activity never marks another device as used", async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    const b = await phone(h, 'Phone B')
    await h.app.request('/api/me', { headers: { Cookie: a.cookie } })
    expect(lastUsed(h, a.id)).not.toBeNull()
    expect(lastUsed(h, b.id)).toBeNull()
  })

  it('a session with no device (a passkey session that has not paired) touches nothing', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    const bare = h.login('cred-1')
    const before = writes(h)
    await h.app.request('/api/me', { headers: { Cookie: bare } })
    expect(lastUsed(h, a.id)).toBeNull()
    expect(writes(h) - before).toBe(0)
  })

  it('a revoked device is never marked as used', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    h.state.core.revokeDevice(a.id)
    h.state.core.noteDeviceUse(a.id)
    expect(lastUsed(h, a.id)).toBeNull()
  })

  it('two relay processes reporting the same device at once write once', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    const other = new AuthCore(h.fake.services) // a second process: its own memory, the same database
    const before = writes(h)
    h.state.core.noteDeviceUse(a.id)
    other.noteDeviceUse(a.id)
    expect(writes(h) - before).toBe(1)
  })

  it('a clock that went back overwrites a last-used time in the future', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    h.fake.clock.advance(3 * DEVICE_USE_INTERVAL_MS)
    h.state.core.noteDeviceUse(a.id)
    const future = lastUsed(h, a.id)
    h.fake.clock.set((future as number) - 10 * DEVICE_USE_INTERVAL_MS)
    h.state.core.noteDeviceUse(a.id)
    expect(lastUsed(h, a.id)).toBe(h.fake.clock.now())
  })

  it('a request that is refused (no session, forged cookie) marks nobody', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    const forged = `${a.cookie.split('=')[0]}=${'x'.repeat(43)}`
    expect((await h.app.request('/api/me', { headers: { Cookie: forged } })).status).toBe(401)
    expect((await h.app.request('/api/me')).status).toBe(401)
    expect(lastUsed(h, a.id)).toBeNull()
  })

  it('a failed write is logged once, does not fail the caller, and is retried after the back-off, not on every call', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    const warns = () => h.fake.logs.filter((l) => l.level === 'warn' && l.msg === 'could not record device use').length
    h.state.core.db.exec('alter table auth_devices rename to auth_devices_away')
    expect(() => h.state.core.noteDeviceUse(a.id)).not.toThrow()
    expect(warns()).toBe(1)
    for (let i = 0; i < 100; i++) h.state.core.noteDeviceUse(a.id) // a busy socket, a broken database
    expect(warns()).toBe(1)
    h.state.core.db.exec('alter table auth_devices_away rename to auth_devices')
    h.state.core.noteDeviceUse(a.id) // inside the back-off: not tried
    expect(lastUsed(h, a.id)).toBeNull()
    h.fake.clock.advance(DEVICE_USE_RETRY_MS)
    h.state.core.noteDeviceUse(a.id) // not "already done": it writes now
    expect(lastUsed(h, a.id)).toBe(h.fake.clock.now())
  })

  it('touchDevice (sign-in, enrolment) logs a failed write instead of throwing', async () => {
    const h = await makeHarness()
    const a = await phone(h, 'Phone A')
    h.state.core.db.exec(
      "create trigger no_touch before update of last_used_at on auth_devices begin select raise(abort, 'disk full'); end",
    )
    expect(() => h.state.core.touchDevice(a.id)).not.toThrow()
    expect(h.fake.logs.some((l) => l.level === 'warn' && l.msg === 'could not record device use')).toBe(true)
    expect(lastUsed(h, a.id)).toBeNull()
  })
})
