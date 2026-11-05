// Rich iPhone notifications, the web half: the grant that lets a phone show message text and press Reply / Approve without
// opening the app (docs/IOS-PUSH.md "Message text and quick actions"). A fake shell stands in for the iPhone app; the relay
// fake checks the grant with the REAL protocol check (checkGrant / verifyOwnerFrame), so a wrong signature or key is refused.
import {
  checkGrant,
  createDeviceKey,
  GRANT_MAX_LIFETIME_MS,
  NativeGrant,
  NativeGrantRevoke,
  signOwnerFrame,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { SetupCard } from '../../src/features/home/SetupCard.tsx'
import { NativePushRow } from '../../src/features/pwa/NativePushRow.tsx'
import {
  disableNativePush,
  enableNativePush,
  refreshNativeOnOpen,
  refreshNativePush,
  resetNativePushForTests,
  setNativeText,
  useNativePush,
} from '../../src/features/pwa/nativePush.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'
import { createMemoryStorage as memoryStorage } from '../../src/lib/storage.ts'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
const TOKEN = 'ab'.repeat(32)
const ENC = 'B'.padEnd(87, 'e')
const ACT = 'B'.padEnd(87, 'a')
const DAY = 86_400_000

beforeEach(() => {
  resetNativePushForTests()
  useNativePush.setState({ view: { kind: 'checking' }, busy: false, note: null, rich: null, pendingRevoke: false })
})
afterEach(cleanup)

/** A shell that has the new calls. `log` records them in order, with the grant string it was handed. */
function shell(
  o: {
    grantCalls?: boolean
    storeFails?: boolean
    keysFail?: boolean
    permission?: string
    keysGate?: Promise<void>
  } = {},
) {
  const log: Array<{ call: string; grant?: string }> = []
  let permission = o.permission ?? 'prompt'
  const plugin: Record<string, unknown> = {
    getStatus: async () => ({ permission }),
    register: async () => {
      permission = 'granted'
      return { token: TOKEN, env: 'sandbox' }
    },
    unregister: async () => void log.push({ call: 'unregister' }),
    addListener: async () => ({ remove: () => {} }),
  }
  if (o.grantCalls !== false) {
    plugin.nativeKeys = async () => {
      log.push({ call: 'nativeKeys' })
      await o.keysGate
      if (o.keysFail) throw new Error('keychain')
      return { enc_pub: ENC, act_pub: ACT }
    }
    plugin.storeGrant = async (a: { grant: string }) => {
      log.push({ call: 'storeGrant', grant: a.grant })
      if (o.storeFails) throw new Error('invalid')
    }
    plugin.clearGrant = async () => void log.push({ call: 'clearGrant' })
  }
  const scope = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { TalosPush: plugin } },
  }
  return {
    scope,
    log,
    setPermission: (p: string) => {
      permission = p
    },
  }
}

/** The relay: token registration as before, and /api/push/grant checked with the protocol's own functions. */
function relay(
  devicePub: Parameters<typeof checkGrant>[1],
  o: { grantExpIn?: number; rejectGrant?: boolean; registered?: boolean; now: () => number },
) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let grant: { raw: string; exp: number } | null =
    o.grantExpIn !== undefined ? { raw: '{}', exp: o.now() + o.grantExpIn } : null
  let registered = o.registered ?? false
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    if (path === '/api/push/apns' && method === 'GET') return Response.json({ configured: true, registered })
    if (path === '/api/push/apns' && method === 'POST') {
      registered = body?.op === 'register'
      return new Response(null, { status: 204 })
    }
    if (path === '/api/push/grant' && method === 'GET')
      return Response.json(grant ? { registered: true, exp: new Date(grant.exp).toISOString() } : { registered: false })
    if (path === '/api/push/grant' && method === 'POST') {
      posts.push({ path, body: body ?? {} })
      if (o.rejectGrant) return Response.json({ error: 'bad_signature' }, { status: 401 })
      if (NativeGrantRevoke.safeParse(body).success) {
        if (!(await verifyOwnerFrame(body ?? {}, devicePub)))
          return Response.json({ error: 'bad_signature' }, { status: 401 })
        grant = null
        return new Response(null, { status: 204 })
      }
      const g = await checkGrant(body, devicePub, o.now())
      if (!g.ok) return Response.json({ error: g.reason }, { status: 400 })
      grant = { raw: JSON.stringify(body), exp: Date.parse(g.grant.exp) }
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  })
  return { http: createHttp(fn as unknown as typeof fetch), posts, grantHeld: () => grant, fn }
}

async function world(
  o: Parameters<typeof relay>[1] extends infer T ? Omit<Extract<T, object>, 'now'> : never = {},
  shellOpts = {},
) {
  const key = await createDeviceKey()
  const clock = { t: Date.parse('2026-11-01T18:00:00.000Z') }
  const now = () => clock.t
  const r = relay(key.publicJwk, { ...o, now })
  const s = shell(shellOpts)
  const client = {
    ...createFakeClient(),
    signOwnerFrame: (f: Record<string, unknown>) => signOwnerFrame({ ...f, device_id: key.deviceId }, key.privateKey),
  } as unknown as TalosClient
  const deps = { client, http: r.http, scope: s.scope, now: () => new Date(clock.t) }
  return { key, r, s, client, deps, clock }
}

describe('Turn on never makes a grant; "Show message text" does', () => {
  it('Turn on leaves every notification a fixed phrase: no keys asked for, no grant posted, text off', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    expect(useNativePush.getState().view.kind).toBe('on')
    expect(w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success)).toEqual([])
    expect(w.s.log.map((c) => c.call)).not.toContain('nativeKeys')
    expect(w.s.log.map((c) => c.call)).not.toContain('storeGrant')
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
    // and opening the app afterwards does not start text either
    await refreshNativeOnOpen(w.deps)
    expect(w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success)).toEqual([])
    expect(useNativePush.getState().rich).toBe(false)
  })

  it('the Home setup card Turn on is the fixed phrase too: it goes through the same path and makes no grant', async () => {
    const w = await world({}, { permission: 'prompt' })
    const g = globalThis as unknown as { Capacitor?: unknown }
    const before = g.Capacitor
    g.Capacitor = (w.s.scope as { Capacitor: unknown }).Capacitor
    vi.stubGlobal('fetch', w.r.fn)
    try {
      useNativePush.setState({ view: { kind: 'off' } })
      render(
        <ClientProvider client={w.client}>
          <SetupCard onSettings={() => {}} />
        </ClientProvider>,
      )
      await userEvent.setup().click(await screen.findByTestId('setup-enable'))
      await waitFor(() => expect(useNativePush.getState().view.kind).toBe('on'))
      expect(w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success)).toEqual([])
      expect(w.s.log.map((c) => c.call)).not.toContain('nativeKeys')
      expect(useNativePush.getState().rich).toBe(false)
      // the row the owner sees says the same: a fixed phrase, with the button to get text
      cleanup()
      render(
        <ClientProvider client={w.client}>
          <NativePushRow http={w.r.http} scope={w.s.scope} />
        </ClientProvider>,
      )
      expect((await screen.findByTestId('native-push-text')).textContent).toMatch(/fixed phrase/)
      expect(screen.getByRole('button', { name: 'Show message text' })).toBeTruthy()
    } finally {
      g.Capacitor = before
      vi.unstubAllGlobals()
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      )
    }
  })

  it('Turn off then Turn on starts from the fixed phrase again, even after text had been chosen', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    expect(w.r.grantHeld()).not.toBeNull()
    await disableNativePush(w.deps)
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
    await refreshNativeOnOpen(w.deps)
    expect(w.r.grantHeld()).toBeNull()
  })

  it('"Show message text" signs the two keys the shell made with the device key, the relay accepts it, and only then the shell keeps it', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    const grantPost = w.r.posts.find((p) => NativeGrant.safeParse(p.body).success)
    expect(grantPost).toBeTruthy()
    expect(grantPost?.body).toMatchObject({
      type: 'native.grant',
      enc_pub: ENC,
      act_pub: ACT,
      device_id: w.key.deviceId,
    })
    expect(grantPost?.body.scopes).toEqual(['reply', 'approve_low'])
    const life = Date.parse(String(grantPost?.body.exp)) - Date.parse(String(grantPost?.body.ts))
    expect(life).toBe(GRANT_MAX_LIFETIME_MS)
    // the shell holds the exact bytes the relay holds: the relay compares them byte for byte when a tap arrives
    const stored = w.s.log.find((c) => c.call === 'storeGrant')
    expect(stored?.grant).toBe(w.r.grantHeld()?.raw)
    expect(w.s.log.map((c) => c.call).indexOf('storeGrant')).toBeGreaterThan(
      w.s.log.map((c) => c.call).indexOf('nativeKeys'),
    )
    expect(useNativePush.getState().rich).toBe(true)
  })

  it('a relay that refuses the grant leaves the shell without one, and notifications still turn on', async () => {
    const w = await world({ rejectGrant: true })
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    expect(w.s.log.some((c) => c.call === 'storeGrant')).toBe(false)
    expect(useNativePush.getState().view.kind).toBe('on')
    expect(useNativePush.getState().rich).toBe(false)
  })

  it('a shell that cannot make keys, or cannot store the grant, does not break Turn on and does not claim text', async () => {
    for (const bad of [{ keysFail: true }, { storeFails: true }]) {
      resetNativePushForTests()
      const w = await world({}, bad)
      await enableNativePush(w.deps)
      await setNativeText(w.deps, true)
      expect(useNativePush.getState().view.kind).toBe('on')
      expect(useNativePush.getState().rich).toBe(false)
      // the relay accepted the grant before the phone refused to keep it: it is taken back, so the two sides agree
      expect(w.r.grantHeld(), JSON.stringify(bad)).toBeNull()
      expect(localStorage.getItem('talos.nativePush.text')).not.toBe('on')
    }
  })

  it('an older shell without the calls posts no grant and says nothing about text', async () => {
    const w = await world({}, { grantCalls: false })
    await enableNativePush(w.deps)
    expect(w.r.posts).toEqual([])
    expect(useNativePush.getState().view.kind).toBe('on')
    expect(useNativePush.getState().rich).toBeNull()
  })
})

describe('Turn off, sign out and the open-time renewal', () => {
  it('Turn off deletes the keys on the phone first, then revokes at the relay with a signed frame', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    w.s.log.length = 0
    await disableNativePush(w.deps)
    expect(w.s.log.map((c) => c.call)).toEqual(['clearGrant', 'unregister'])
    const revoke = w.r.posts.filter((p) => NativeGrantRevoke.safeParse(p.body).success).at(-1)
    expect(await verifyOwnerFrame(revoke?.body ?? {}, w.key.publicJwk)).toBe(true)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBeNull()
  })

  it('Turn off still turns off when the revoke cannot reach the relay (the phone already holds no keys)', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/push/grant') throw new TypeError('offline')
      return String(url) === '/api/push/apns' && (init?.method ?? 'GET') === 'GET'
        ? Response.json({ configured: true, registered: false })
        : new Response(null, { status: 204 })
    })
    w.s.log.length = 0
    await disableNativePush(w.deps)
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant')
    expect(useNativePush.getState().view.kind).toBe('off')
  })

  it('signing out clears the grant and the keys out of the iPhone Keychain', async () => {
    const w = await world()
    const calls: string[] = []
    const g = globalThis as unknown as { Capacitor?: unknown }
    const before = g.Capacitor
    g.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: { TalosPush: { clearGrant: async () => void calls.push('clearGrant') } },
    }
    try {
      await clearLocalData(memoryStorage())
      await waitFor(() => expect(calls).toEqual(['clearGrant']))
    } finally {
      g.Capacitor = before
    }
    void w
  })

  it('opening the app renews a grant with under 20 days left, leaves a healthy one alone, and makes one when none exists', async () => {
    for (const [expIn, renews] of [
      [25 * DAY, false],
      [5 * DAY, true],
      [undefined, true],
    ] as const) {
      resetNativePushForTests()
      const w = await world(expIn === undefined ? {} : { grantExpIn: expIn }, { permission: 'granted' })
      // the owner turned notifications on earlier, with message text
      localStorage.setItem('talos.nativePush.choice', 'on')
      localStorage.setItem('talos.nativePush.text', 'on')
      localStorage.setItem('talos.nativePush.grantStored', '1') // the phone holds the keys that go with the relay's grant
      await refreshNativeOnOpen(w.deps)
      const made = w.r.posts.some((p) => NativeGrant.safeParse(p.body).success)
      expect(made, `exp in ${expIn}`).toBe(renews)
    }
  })

  it('Turn off during a renewal wins: no grant comes back at the relay or in the Keychain, and the row is not rewritten', async () => {
    let open!: () => void
    const keysGate = new Promise<void>((r) => {
      open = r
    })
    const w = await world({}, { permission: 'granted', keysGate })
    localStorage.setItem('talos.nativePush.choice', 'on')
    localStorage.setItem('talos.nativePush.text', 'on')
    const renewing = refreshNativeOnOpen(w.deps)
    await waitFor(() => expect(w.s.log.some((c) => c.call === 'nativeKeys')).toBe(true))
    await disableNativePush(w.deps) // owner taps Turn off while the phone is still making keys
    w.s.log.length = 0
    open()
    await renewing
    expect(w.s.log.map((c) => c.call)).not.toContain('storeGrant')
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBeNull()
  })

  it('never makes a grant on open for a phone whose owner turned message text off, or never turned it on', async () => {
    for (const text of ['off', null] as const) {
      resetNativePushForTests()
      const w = await world({}, { permission: 'granted' })
      localStorage.setItem('talos.nativePush.choice', 'on')
      if (text) localStorage.setItem('talos.nativePush.text', text)
      await refreshNativeOnOpen(w.deps)
      expect(
        w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success),
        `text=${text}`,
      ).toEqual([])
      expect(
        w.s.log.map((c) => c.call),
        `text=${text}`,
      ).not.toContain('storeGrant')
    }
  })

  it('does not renew for an owner who turned notifications off', async () => {
    const w = await world({}, { permission: 'granted' })
    localStorage.setItem('talos.nativePush.choice', 'off')
    await refreshNativeOnOpen(w.deps)
    expect(w.r.posts).toEqual([])
  })
})

describe('what the Settings row says', () => {
  async function shown(rich: boolean) {
    const w = await world({ ...(rich ? { grantExpIn: 25 * DAY } : {}), registered: true }, { permission: 'granted' })
    if (rich) {
      // text is on only when the owner's choice, the phone's keys and the relay's grant all say so
      localStorage.setItem('talos.nativePush.text', 'on')
      localStorage.setItem('talos.nativePush.grantStored', '1')
    }
    useNativePush.setState({ view: { kind: 'on' }, rich: null })
    render(
      <ClientProvider client={w.client}>
        <NativePushRow http={w.r.http} scope={w.s.scope} />
      </ClientProvider>,
    )
    return w
  }
  it('says the words show on the phone, that Apple gets a fixed phrase, and that the server can still read them', async () => {
    await shown(true)
    const t = await screen.findByTestId('native-push-text')
    expect(t.textContent).toMatch(/Apple only gets a fixed phrase/)
    expect(t.textContent).toMatch(/server can still read them/)
  })
  it('without a grant it says plainly that notifications are a fixed phrase and how to get text', async () => {
    await shown(false)
    const t = await screen.findByTestId('native-push-text')
    expect(t.textContent).toMatch(/fixed phrase/)
    expect(t.textContent).toMatch(/Message text and the Reply and Approve buttons are off/)
  })
  it('the owner can switch message text off and on from Settings, and opening the app never flips it back', async () => {
    const w = await world({ registered: true }, { permission: 'granted' })
    localStorage.setItem('talos.nativePush.choice', 'on')
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull() // Turn on alone is the fixed phrase
    await setNativeText(w.deps, true)
    expect(w.r.grantHeld()).not.toBeNull()
    useNativePush.setState({ view: { kind: 'on' } })
    render(
      <ClientProvider client={w.client}>
        <NativePushRow http={w.r.http} scope={w.s.scope} />
      </ClientProvider>,
    )
    const user = userEvent.setup()
    w.s.log.length = 0
    await user.click(await screen.findByRole('button', { name: 'Use a fixed phrase only' }))
    await waitFor(() => expect(w.r.grantHeld()).toBeNull()) // revoked at the relay
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant') // and out of the Keychain
    expect(useNativePush.getState().rich).toBe(false)
    // the app is opened (even after the grant is long gone): no grant comes back
    const before = w.r.posts.length
    await refreshNativeOnOpen(w.deps)
    expect(w.r.posts.slice(before).some((p) => NativeGrant.safeParse(p.body).success)).toBe(false)
    expect(w.r.grantHeld()).toBeNull()
    // Turn off and on again: still a fixed phrase until he asks for text
    await disableNativePush(w.deps)
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    // and the same button brings text back, from a tap
    useNativePush.setState({ view: { kind: 'on' }, rich: false })
    await user.click(await screen.findByRole('button', { name: 'Show message text' }))
    await waitFor(() => expect(w.r.grantHeld()).not.toBeNull())
    expect(useNativePush.getState().rich).toBe(true)
  })

  it('reads the relay on every refresh, but says text is on only when the owner chose it AND the phone holds the keys', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'granted' })
    // relay holds a grant, nothing on the phone says the owner wanted it: the row must not claim text is on
    await refreshNativePush(w.deps)
    expect(useNativePush.getState().rich).toBe(false)
    expect(useNativePush.getState().pendingRevoke).toBe(true)
    // choice on but the Keychain is empty (idle expiry): still not on
    localStorage.setItem('talos.nativePush.text', 'on')
    await refreshNativePush(w.deps)
    expect(useNativePush.getState().rich).toBe(false)
    // all three agree
    localStorage.setItem('talos.nativePush.grantStored', '1')
    await refreshNativePush(w.deps)
    expect(useNativePush.getState().rich).toBe(true)
    expect(useNativePush.getState().pendingRevoke).toBe(false)
    // the relay forgot it: off again, whatever the phone remembers
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url) === '/api/push/grant'
        ? Response.json({ registered: false })
        : String(url) === '/api/push/apns' && (init?.method ?? 'GET') === 'GET'
          ? Response.json({ configured: true, registered: true })
          : new Response(null, { status: 204 }),
    )
    await refreshNativePush(w.deps)
    expect(useNativePush.getState().rich).toBe(false)
  })
})

const grantPosts = (w: { r: { posts: Array<{ body: Record<string, unknown> }> } }) =>
  w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success)

describe('message text never returns without a tap (review round 4, finding 1)', () => {
  it('iOS permission denied: text goes off for good, so re-allowing and tapping Turn on does not bring it back', async () => {
    const w = await world({}, { permission: 'granted' })
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    expect(w.r.grantHeld()).not.toBeNull()
    const before = grantPosts(w).length
    w.s.setPermission('denied') // the owner turned notifications off in iOS Settings
    await refreshNativeOnOpen(w.deps)
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
    expect(w.r.grantHeld()).toBeNull()
    w.s.setPermission('granted') // he re-allows, taps Turn on, and later opens the app again
    await enableNativePush(w.deps)
    await refreshNativeOnOpen(w.deps)
    await refreshNativeOnOpen(w.deps)
    expect(grantPosts(w).length).toBe(before)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
  })

  it('denied while the relay holds no token: the text choice still ends', async () => {
    const w = await world({ registered: false }, { permission: 'denied' })
    localStorage.setItem('talos.nativePush.text', 'on')
    await refreshNativeOnOpen(w.deps)
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
  })

  it('sign-out, then pairing the same phone again: no grant is made on open, and the relay copy is taken back', async () => {
    const w = await world({}, { permission: 'granted' })
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    expect(w.r.grantHeld()).not.toBeNull()
    const before = grantPosts(w).length
    await clearLocalData(memoryStorage()) // sign-out, or a revoke, or a 401
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
    expect(localStorage.getItem('talos.nativePush.grantStored')).toBeNull()
    // the same phone is paired again; the owner has to turn notifications on again or the old choice might still say 'on'
    localStorage.setItem('talos.nativePush.choice', 'on')
    await refreshNativeOnOpen(w.deps)
    await refreshNativeOnOpen(w.deps)
    expect(grantPosts(w).length).toBe(before)
    expect(w.r.grantHeld()).toBeNull() // the grant idle expiry left at the relay is revoked
    expect(useNativePush.getState().pendingRevoke).toBe(false)
  })

  it('Turn on after a leftover text=on does not let the next open make a grant', async () => {
    const w = await world({}, { permission: 'prompt' })
    localStorage.setItem('talos.nativePush.text', 'on')
    await enableNativePush(w.deps)
    await refreshNativeOnOpen(w.deps)
    expect(grantPosts(w)).toEqual([])
  })
})

describe('the row tells the truth about text (review round 4, finding 3)', () => {
  it('"Use a fixed phrase only" offline: the phone is cleared, the note says the server has not confirmed, and the next open retries until it lands', async () => {
    const w = await world({}, { permission: 'granted' })
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    const real = w.r.fn.getMockImplementation()
    let offline = true
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (offline && String(url) === '/api/push/grant' && init?.method === 'POST') throw new TypeError('offline')
      return real?.(url, init) as Promise<Response>
    })
    await setNativeText(w.deps, false)
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant')
    expect(w.r.grantHeld()).not.toBeNull() // still held by the server
    expect(useNativePush.getState().note).toMatch(/hasn't confirmed/)
    expect(useNativePush.getState().pendingRevoke).toBe(true)
    expect(useNativePush.getState().rich).toBe(false)
    // still offline at the next open: still pending, no grant comes back
    await refreshNativeOnOpen(w.deps)
    expect(w.r.grantHeld()).not.toBeNull()
    expect(useNativePush.getState().pendingRevoke).toBe(true)
    expect(grantPosts(w).length).toBe(1)
    // back online: the stored choice is sent again
    offline = false
    await refreshNativeOnOpen(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().pendingRevoke).toBe(false)
  })

  it('the row shows the pending line only while the server still holds a grant the owner turned off', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'granted' })
    localStorage.setItem('talos.nativePush.text', 'off')
    useNativePush.setState({ view: { kind: 'on' }, rich: null })
    render(
      <ClientProvider client={w.client}>
        <NativePushRow http={w.r.http} scope={w.s.scope} />
      </ClientProvider>,
    )
    expect((await screen.findByTestId('native-push-pending')).textContent).toMatch(/has not confirmed/)
    expect((await screen.findByTestId('native-push-text')).textContent).toMatch(/fixed phrase/)
  })

  it('idle expiry emptied the Keychain while the relay kept its grant (more than 20 days left): open renews it, because the owner had text on', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'granted' })
    localStorage.setItem('talos.nativePush.choice', 'on')
    localStorage.setItem('talos.nativePush.text', 'on') // chosen earlier, and not forgotten
    // no `grantStored`: the phone no longer holds the keys
    await refreshNativeOnOpen(w.deps)
    expect(grantPosts(w).length).toBe(1)
    expect(w.s.log.some((c) => c.call === 'storeGrant')).toBe(true)
    await refreshNativePush(w.deps)
    expect(useNativePush.getState().rich).toBe(true)
  })

  it('the phone refuses to keep a grant the relay accepted: the relay copy is revoked and the row says text is off', async () => {
    const w = await world({}, { permission: 'granted', storeFails: true })
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
    expect(useNativePush.getState().note).toMatch(/Couldn't turn on message text/)
  })
})

describe('what the Settings row says about thread names and older shells (review round 4, findings 6 and 12)', () => {
  it('the thread-names line says the setting also shapes the name inside the seal when text is on', async () => {
    const w = await world({ registered: true }, { permission: 'granted' })
    useNativePush.setState({ view: { kind: 'on' }, rich: null })
    render(
      <ClientProvider client={w.client}>
        <NativePushRow http={w.r.http} scope={w.s.scope} />
      </ClientProvider>,
    )
    const t = (await screen.findByTestId('native-push-names')).textContent ?? ''
    expect(t).toMatch(/changes browser notifications/)
    expect(t).not.toMatch(/only changes browser/)
    expect(t).toMatch(/name the thread as far as this setting allows/)
  })

  it('an older shell without the key calls is not offered a text choice it cannot make', async () => {
    const w = await world({ registered: false }, { permission: 'prompt', grantCalls: false })
    useNativePush.setState({ view: { kind: 'off' }, rich: null })
    render(
      <ClientProvider client={w.client}>
        <NativePushRow http={w.r.http} scope={w.s.scope} />
      </ClientProvider>,
    )
    const t = (await screen.findByTestId('native-push-text-intro')).textContent ?? ''
    expect(t).toMatch(/cannot show message text/)
    expect(t).not.toMatch(/you can choose/)
    expect(screen.queryByTestId('native-push-names')?.textContent ?? '').not.toMatch(/turn on message text/)
  })

  it('a current shell in the off state does promise the choice', async () => {
    const w = await world({ registered: false }, { permission: 'prompt' })
    useNativePush.setState({ view: { kind: 'off' }, rich: null })
    render(
      <ClientProvider client={w.client}>
        <NativePushRow http={w.r.http} scope={w.s.scope} />
      </ClientProvider>,
    )
    expect((await screen.findByTestId('native-push-text-intro')).textContent).toMatch(
      /you can choose to show message text/,
    )
  })
})

void userEvent

describe('text stays off after a block, a failed write and a sign-out race (review round 5)', () => {
  const live = (w: Awaited<ReturnType<typeof world>>) => {
    localStorage.setItem('talos.nativePush.choice', 'on')
    localStorage.setItem('talos.nativePush.text', 'on')
    localStorage.setItem('talos.nativePush.grantStored', '1')
    expect(w.r.grantHeld()).not.toBeNull()
  }

  it('blocked while the relay holds a grant but no token: the open takes the grant back, so re-allowing and Turn on do not restore text', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: false }, { permission: 'denied' })
    live(w)
    await refreshNativeOnOpen(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant')
    w.s.setPermission('granted')
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
  })

  it('Turn on itself revokes a grant that is still alive (relay and Keychain), even when nothing blocked it first', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'granted' })
    live(w)
    localStorage.setItem('talos.nativePush.choice', 'off')
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant')
    expect(localStorage.getItem('talos.nativePush.grantStored')).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
    expect(useNativePush.getState().pendingRevoke).toBe(false)
  })

  it('Turn on while the relay cannot be reached for the revoke: keys still go, and the row says the server has not confirmed', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'granted' })
    live(w)
    const real = w.r.fn.getMockImplementation()
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/push/grant' && init?.method === 'POST') throw new TypeError('offline')
      return real?.(url, init) as Promise<Response>
    })
    await enableNativePush(w.deps)
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant')
    expect(useNativePush.getState().rich).toBe(false)
    expect(useNativePush.getState().pendingRevoke).toBe(true)
  })

  it('the Settings row alone sees the block (no open, inside the throttle): text ends and the grant goes', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'granted' })
    live(w)
    w.s.setPermission('denied')
    await refreshNativePush(w.deps)
    expect(useNativePush.getState().view.kind).toBe('blocked')
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
    expect(w.r.grantHeld()).toBeNull()
    w.s.setPermission('granted')
    await enableNativePush(w.deps)
    await refreshNativeOnOpen(w.deps)
    expect(grantPosts(w).length).toBe(0)
    expect(useNativePush.getState().rich).toBe(false)
  })

  it('an offline open still reads the permission first: a block ends the text choice and clears the keys with no network at all', async () => {
    const w = await world({ grantExpIn: 25 * DAY, registered: true }, { permission: 'denied' })
    live(w)
    w.r.fn.mockImplementation(async () => {
      throw new TypeError('offline')
    })
    await refreshNativeOnOpen(w.deps)
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
    expect(localStorage.getItem('talos.nativePush.grantStored')).toBeNull()
    expect(w.s.log.map((c) => c.call)).toContain('clearGrant')
  })

  it('a failed write of "off" cannot leave "on" standing: the choice fails toward off', async () => {
    const w = await world({}, { permission: 'granted' })
    await enableNativePush(w.deps)
    await setNativeText(w.deps, true)
    expect(localStorage.getItem('talos.nativePush.text')).toBe('on')
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      await setNativeText(w.deps, false) // the write of off fails; storage still says on
      expect(localStorage.getItem('talos.nativePush.text')).toBe('on')
      const before = grantPosts(w).length
      await refreshNativeOnOpen(w.deps) // must not renew
      expect(grantPosts(w).length).toBe(before)
      expect(w.r.grantHeld()).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('sign-out landing during the grant POST: nothing is stored on the phone and the relay copy is taken back', async () => {
    const w = await world({}, { permission: 'granted' })
    await enableNativePush(w.deps)
    const real = w.r.fn.getMockImplementation()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (String(url) === '/api/push/grant' && init?.method === 'POST' && NativeGrant.safeParse(body).success) {
        const res = await real?.(url, init)
        await gate
        return res as Response
      }
      return real?.(url, init) as Promise<Response>
    })
    const pending = setNativeText(w.deps, true)
    await waitFor(() => expect(w.r.grantHeld()).not.toBeNull())
    await clearLocalData(memoryStorage()) // sign-out while the relay is answering
    release()
    await pending
    expect(w.s.log.map((c) => c.call)).not.toContain('storeGrant')
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off')
    expect(localStorage.getItem('talos.nativePush.grantStored')).toBeNull()
    expect(w.r.grantHeld()).toBeNull()
  })
})
