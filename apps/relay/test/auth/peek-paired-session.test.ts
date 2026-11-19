// BYOR phase 4: the attest route reads the owner's cookie only to pick a rate bucket. The read must change nothing, or an
// unauthenticated caller with a stale or stolen-looking cookie could keep a session alive, end one, or mark a device used.
import { afterEach, describe, expect, it } from 'vitest'
import { peekPairedSession } from '../../src/auth/contract.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { afterEachReset, type Harness, makeHarness } from './helpers.ts'

const DAY = 24 * 3600_000
afterEach(afterEachReset)

async function probed(): Promise<
  Harness & { peek(cookie?: string): Promise<{ paired: boolean; setCookie: string | null }> }
> {
  const h = await makeHarness()
  h.app.post('/probe/peek', (c) => c.json({ paired: peekPairedSession(c) }))
  const peek = async (cookie?: string) => {
    const res = await h.app.request('/probe/peek', { method: 'POST', headers: cookie ? { Cookie: cookie } : {} })
    return { paired: ((await res.json()) as { paired: boolean }).paired, setCookie: res.headers.get('set-cookie') }
  }
  return Object.assign(h, { peek })
}

const rows = (h: Harness) =>
  h.fake.services.db.prepare('select id, device_id, last_seen_at, expires_at from auth_sessions order by id').all()
const ends = (h: Harness) => h.fake.services.db.prepare('select count(*) as n from auth_session_ends').get()
const lastUsed = (h: Harness) =>
  h.fake.services.db.prepare('select id, last_used_at from auth_devices order by id').all()

describe('peekPairedSession', () => {
  it("is true for a pinned device's live session, false for none, a bad cookie, or an unpinned session", async () => {
    const h = await probed()
    expect((await h.peek()).paired).toBe(false)
    expect((await h.peek(`${COOKIE_NAME}=nope`)).paired).toBe(false)
    expect((await h.peek(`${COOKIE_NAME}=${'A'.repeat(43)}`)).paired).toBe(false)
    expect((await h.peek(h.login())).paired).toBe(false) // a passkey session with no pinned device: pairing only
    expect((await h.peek(await h.loginPinned())).paired).toBe(true)
  })

  it('changes nothing: no Set-Cookie, no slid expiry, no last_seen, no device stamp', async () => {
    const h = await probed()
    const cookie = await h.loginPinned()
    h.fake.clock.advance(2 * DAY) // far past the 60 s after which a real lookup slides the session
    const before = JSON.stringify([rows(h), ends(h), lastUsed(h)])
    const res = await h.peek(cookie)
    expect(res).toEqual({ paired: true, setCookie: null })
    expect(JSON.stringify([rows(h), ends(h), lastUsed(h)])).toBe(before)
    // the real lookup WOULD have slid it: this is what the peek leaves alone
    const slid = await h.app.request('/probe/session', { headers: { Cookie: cookie } })
    expect(slid.status).toBe(200)
    expect(JSON.stringify(rows(h))).not.toBe(JSON.stringify(JSON.parse(before)[0]))
  })

  it('an expired or idle session is false and is not ended by the look', async () => {
    const h = await probed()
    const cookie = await h.loginPinned()
    // set, not advance: advance would replay the auth sweep every 10 minutes of the 400 days (57,600 runs, seconds of CPU);
    // a real clock that jumps fires it once
    h.fake.clock.set(h.fake.clock.now() + 400 * DAY)
    expect(rows(h).length).toBeGreaterThan(0) // the expired session is still stored, so the look really could end it
    const before = JSON.stringify([rows(h), ends(h)])
    expect((await h.peek(cookie)).paired).toBe(false)
    expect(JSON.stringify([rows(h), ends(h)])).toBe(before) // lookupSession would have deleted it and recorded why
  })

  it("a revoked (unpinned) device's session is false", async () => {
    const h = await probed()
    const cookie = await h.loginPinned()
    const id = (rows(h).find((r) => (r as { device_id: string | null }).device_id) as { device_id: string }).device_id
    h.state.core.setPinned(id, false)
    expect((await h.peek(cookie)).paired).toBe(false)
  })
})
