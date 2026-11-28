// 0.11: message text is on by default for the iPhone app. A new phone gets words and Reply from the one Turn on tap; an older
// phone's stored "off" stays off (and is offered words once); a failure turning words on never reads as "on". The fake shell
// and relay are the ones rich-grant.test.tsx uses (the relay checks the grant with the REAL protocol functions).
import {
  checkGrant,
  createDeviceKey,
  GRANT_SCOPES,
  NativeGrant,
  NativeGrantRevoke,
  PUSH_TEXT_DEFAULT,
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
  localStorage.clear()
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
    storeGate?: Promise<void>
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
      await o.storeGate
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

/** The Home card reads the shell from the page globals, as in the app: install the fake shell and relay there. */
async function withHomeGlobals(w: Awaited<ReturnType<typeof world>>, body: () => Promise<void>) {
  const g = globalThis as unknown as { Capacitor?: unknown }
  const before = g.Capacitor
  g.Capacitor = (w.s.scope as { Capacitor: unknown }).Capacitor
  vi.stubGlobal('fetch', w.r.fn)
  try {
    await body()
  } finally {
    cleanup()
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
}
const homeCard = (w: Awaited<ReturnType<typeof world>>) =>
  render(
    <ClientProvider client={w.client}>
      <SetupCard onSettings={() => {}} />
    </ClientProvider>,
  )

const grantPosts = (w: Awaited<ReturnType<typeof world>>) =>
  w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success)
const row = (w: Awaited<ReturnType<typeof world>>) =>
  render(
    <ClientProvider client={w.client}>
      <NativePushRow http={w.r.http} scope={w.s.scope} />
    </ClientProvider>,
  )
/** A page that ran an earlier build: it has recorded keys, so 0.11 must treat its text choice as made. */
const legacy = (text: 'on' | 'off' | null, choice: 'on' | 'off' = 'on') => {
  localStorage.setItem('talos.nativePush.choice', choice)
  if (text) localStorage.setItem('talos.nativePush.text', text)
}

describe('the one default', () => {
  it('is the shared constant, on', () => {
    expect(PUSH_TEXT_DEFAULT).toBe(true)
  })
})

describe('a new phone: one tap turns on notifications with words and Reply', () => {
  it('Turn on registers the token, makes the grant with the full scopes and stores it, in that order, from the one tap', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    const posted = w.r.fn.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0])}`)
    expect(posted.indexOf('POST /api/push/apns')).toBeGreaterThan(-1)
    expect(posted.lastIndexOf('POST /api/push/grant')).toBeGreaterThan(posted.indexOf('POST /api/push/apns'))
    const g = grantPosts(w)
    expect(g.length).toBe(1)
    expect(g[0]?.body.scopes).toEqual([...GRANT_SCOPES])
    expect(w.s.log.find((c) => c.call === 'storeGrant')?.grant).toBe(w.r.grantHeld()?.raw)
    expect(useNativePush.getState().view.kind).toBe('on')
    expect(useNativePush.getState().rich).toBe(true)
    expect(useNativePush.getState().note).toMatch(/with message words/)
    expect(localStorage.getItem('talos.nativePush.text')).toBe('on')
  })

  it('the row says words are on and says what Apple and the server see', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    row(w)
    const t = (await screen.findByTestId('native-push-text')).textContent ?? ''
    expect(t).toMatch(/show their words/)
    expect(t).toMatch(/Apple only gets a fixed phrase/)
    expect(t).toMatch(/Your Talos server can still read them/)
  })

  it('the off state promises words with Turn on, and names the shared-phone Show Previews step', async () => {
    const w = await world({}, { permission: 'prompt' })
    row(w)
    const intro = (await screen.findByTestId('native-push-text-intro')).textContent ?? ''
    expect(intro).toBe(
      'Turn on notifications to see message words, with Reply and Approve for simple ones. Apple never sees the words. You can switch them off any time.',
    )
    const shared = (await screen.findByTestId('native-push-shared')).textContent ?? ''
    expect(shared).toBe(
      'On a shared phone, set Show Previews to Never for Talos: iPhone Settings, Notifications, Talos, Show Previews.',
    )
  })

  it('opening the app does not make a grant for a phone that is off (the default applies at the Turn on tap only)', async () => {
    const w = await world({ registered: false }, { permission: 'granted' })
    await refreshNativeOnOpen(w.deps)
    await refreshNativePush(w.deps)
    expect(grantPosts(w)).toEqual([])
  })

  it('Turn off then Turn on brings words back for a phone that never chose', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await disableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).not.toBeNull()
    expect(useNativePush.getState().rich).toBe(true)
  })

  it('an older shell without the key calls: notifications on, fixed phrase, no error, no grant call', async () => {
    const w = await world({}, { grantCalls: false })
    await enableNativePush(w.deps)
    expect(w.r.posts).toEqual([])
    expect(useNativePush.getState().view.kind).toBe('on')
    expect(useNativePush.getState().rich).toBeNull()
  })
})

describe('an explicit OFF is kept', () => {
  it('an older page with text off: Turn off then Turn on makes no grant', async () => {
    legacy('off')
    const w = await world({}, { permission: 'granted' })
    await disableNativePush(w.deps)
    await enableNativePush(w.deps)
    expect(grantPosts(w)).toEqual([])
    expect(useNativePush.getState().rich).toBe(false)
  })

  it('an older page that never recorded text (notifications on before the feature) stays fixed too', async () => {
    legacy(null)
    const w = await world({ registered: true }, { permission: 'granted' })
    await disableNativePush(w.deps)
    await enableNativePush(w.deps)
    expect(grantPosts(w)).toEqual([])
  })

  it('a person who taps "Use a fixed phrase only" on a new page keeps it across Turn off and Turn on', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, false)
    await disableNativePush(w.deps)
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).toBe(false)
  })

  it('an older page with text on keeps words across Turn off and Turn on', async () => {
    legacy('on')
    localStorage.setItem('talos.nativePush.grantStored', '1')
    const w = await world({}, { permission: 'granted' })
    await disableNativePush(w.deps)
    await enableNativePush(w.deps)
    expect(w.r.grantHeld()).not.toBeNull()
    expect(useNativePush.getState().rich).toBe(true)
  })

  it('page storage that cannot be read gives the default at the tap and never throws', async () => {
    const w = await world()
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      await enableNativePush(w.deps)
      expect(useNativePush.getState().view.kind).toBe('on')
    } finally {
      spy.mockRestore()
      set.mockRestore()
    }
  })
})

describe('the one-time offer to a phone whose old "off" was kept', () => {
  it('shows the short question once, Turn on makes the grant, and the offer is gone', async () => {
    legacy('off')
    const w = await world({ registered: true }, { permission: 'granted' })
    row(w)
    expect(await screen.findByText('Show message words in notifications?')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(useNativePush.getState().rich).toBe(true))
    expect(grantPosts(w).length).toBe(1)
    expect(screen.queryByText('Show message words in notifications?')).toBeNull()
  })

  it('Not now hides it for good, makes no grant, and it stays hidden after a reload of the page state', async () => {
    legacy('off')
    const w = await world({ registered: true }, { permission: 'granted' })
    row(w)
    await screen.findByText('Show message words in notifications?')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Show message words in notifications?')).toBeNull()
    expect(grantPosts(w)).toEqual([])
    cleanup()
    resetNativePushForTests({ keepStorage: true })
    useNativePush.setState({ view: { kind: 'checking' }, busy: false, note: null, rich: null, pendingRevoke: false })
    row(w)
    await screen.findByTestId('native-push-text')
    expect(screen.queryByText('Show message words in notifications?')).toBeNull()
  })

  it('is not shown to a new phone, to one that chose a fixed phrase, or while words are on', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, false)
    row(w)
    await screen.findByTestId('native-push-text')
    expect(screen.queryByText('Show message words in notifications?')).toBeNull()
  })
})

describe('a failure turning words on shows as a failure, never as on', () => {
  const failures: Array<[string, Parameters<typeof world>[0], Parameters<typeof world>[1]]> = [
    ['the relay refuses the grant', { rejectGrant: true }, {}],
    ['the phone cannot make keys', {}, { keysFail: true }],
    ['the phone cannot keep the grant', {}, { storeFails: true }],
  ]
  for (const [name, relayOpts, shellOpts] of failures) {
    it(`${name}: notifications stay on, the row says words did not turn on and offers Try again`, async () => {
      const w = await world(relayOpts, shellOpts)
      await enableNativePush(w.deps)
      const s = useNativePush.getState()
      expect(s.view.kind).toBe('on')
      expect(s.rich).toBe(false)
      expect(s.note).toBe("Notifications are on, but message words didn't turn on.")
      expect(w.r.grantHeld()).toBeNull()
      expect(localStorage.getItem('talos.nativePush.text')).not.toBe('on')
      row(w)
      expect((await screen.findByTestId('native-push-text')).textContent).toMatch(/fixed phrase/)
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    })
  }

  it('Try again makes the grant once the cause is gone, and the failure line goes away', async () => {
    const w = await world({ rejectGrant: true })
    await enableNativePush(w.deps)
    row(w)
    await screen.findByRole('button', { name: 'Try again' })
    const rejectingFetch = w.r.fn.getMockImplementation()
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/push/grant' && init?.method === 'POST') {
        const key = w.key
        const body = JSON.parse(String(init.body))
        const g = await checkGrant(body, key.publicJwk, w.clock.t)
        if (!g.ok) return Response.json({ error: g.reason }, { status: 400 })
        return new Response(null, { status: 204 })
      }
      return (rejectingFetch as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>)(url, init)
    })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(useNativePush.getState().rich).toBe(true))
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('a token failure shows blocked, and no grant is attempted', async () => {
    const w = await world({}, { permission: 'denied' })
    w.s.scope.Capacitor.Plugins.TalosPush.register = async () => {
      throw Object.assign(new Error('denied'), { code: 'denied' })
    }
    await enableNativePush(w.deps)
    expect(useNativePush.getState().view.kind).toBe('blocked')
    expect(grantPosts(w)).toEqual([])
    expect(w.s.log.map((c) => c.call)).not.toContain('nativeKeys')
  })
})

describe('races and sign-out', () => {
  it('two Turn on taps at once make one grant', async () => {
    const w = await world()
    await Promise.all([enableNativePush(w.deps), enableNativePush(w.deps)])
    expect(grantPosts(w).length).toBe(1)
  })

  it('signing out while the grant is being made leaves no grant and no stored keys', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const w = await world({}, { keysGate: gate })
    const turning = enableNativePush(w.deps)
    await waitFor(() => expect(w.s.log.map((c) => c.call)).toContain('nativeKeys'))
    await clearLocalData(memoryStorage())
    release()
    await turning
    expect(w.r.grantHeld()).toBeNull()
    expect(useNativePush.getState().rich).not.toBe(true)
  })

  it('after sign-out the next person starts from the default: words on at their Turn on tap', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, false) // the earlier owner chose a fixed phrase
    await clearLocalData(memoryStorage())
    expect(localStorage.getItem('talos.nativePush.textPref')).toBeNull()
    resetNativePushForTests({ keepStorage: true })
    const w2 = await world()
    await enableNativePush(w2.deps)
    expect(w2.r.grantHeld()).not.toBeNull()
    expect(useNativePush.getState().rich).toBe(true)
  })
})

describe('the Home card (review fix 1 and 2)', () => {
  it('a words grant that fails on the card Turn on keeps the card, says so, and Try again makes the grant', async () => {
    const w = await world({ rejectGrant: true }, { permission: 'prompt' })
    await withHomeGlobals(w, async () => {
      useNativePush.setState({ view: { kind: 'off' } })
      homeCard(w)
      await userEvent.setup().click(await screen.findByTestId('setup-enable'))
      await waitFor(() => expect(useNativePush.getState().textFailed).toBe(true))
      expect(useNativePush.getState().view.kind).toBe('on')
      expect(await screen.findByText("Notifications are on, but message words didn't turn on.")).toBeTruthy()
      expect(screen.queryByTestId('setup-enable')).toBeNull()
      // the cause goes away: Try again from the card makes the grant and the card ends
      const real = w.r.fn.getMockImplementation()
      w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === '/api/push/grant' && init?.method === 'POST') {
          const g = await checkGrant(JSON.parse(String(init.body)), w.key.publicJwk, w.clock.t)
          return g.ok ? new Response(null, { status: 204 }) : Response.json({ error: g.reason }, { status: 400 })
        }
        return (real as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>)(url, init)
      })
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(useNativePush.getState().rich).toBe(true))
      await waitFor(() => expect(screen.queryByTestId('setup-card')).toBeNull())
    })
  })

  it('a shell without the key calls is not promised words or a shared-phone step on the card', async () => {
    const w = await world({}, { permission: 'prompt', grantCalls: false })
    await withHomeGlobals(w, async () => {
      useNativePush.setState({ view: { kind: 'off' } })
      homeCard(w)
      await screen.findByTestId('setup-enable')
      expect(screen.queryByTestId('setup-shared')).toBeNull()
      expect(screen.queryByText(/message words/)).toBeNull()
    })
  })

  it('a current shell is told words come with Turn on and the shared-phone step', async () => {
    const w = await world({}, { permission: 'prompt' })
    await withHomeGlobals(w, async () => {
      useNativePush.setState({ view: { kind: 'off' } })
      homeCard(w)
      const t = (await screen.findByTestId('setup-shared')).textContent ?? ''
      expect(t).toMatch(/^Turn on shows message words with Reply\. On a shared phone, set Show Previews to Never/)
    })
  })
})

describe('sign-out and session expiry (review fixes 4 and 5)', () => {
  it('signing out during the register POST leaves no grant, no recorded choice and no words', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const w = await world()
    const real = w.r.fn.getMockImplementation() as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>
    w.r.fn.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/push/apns' && init?.method === 'POST') {
        const res = await real(url, init)
        await gate
        return res
      }
      return real(url, init)
    })
    const turning = enableNativePush(w.deps)
    await waitFor(() => expect(w.r.fn.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(true))
    await clearLocalData(memoryStorage())
    release()
    await turning
    expect(grantPosts(w)).toEqual([])
    expect(w.s.log.map((c) => c.call)).not.toContain('nativeKeys')
    expect(localStorage.getItem('talos.nativePush.choice')).not.toBe('on')
    expect(useNativePush.getState().rich).not.toBe(true)
  })

  it('an expired session keeps the "fixed phrase" decision; a real sign-out clears it', async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, false)
    expect(localStorage.getItem('talos.nativePush.textPref')).toBe('off')
    await clearLocalData(memoryStorage(), { keepUnsent: true }) // the session expired
    expect(localStorage.getItem('talos.nativePush.textPref')).toBe('off')
    expect(localStorage.getItem('talos.nativePush.text')).toBe('off') // applied text still ends
    await clearLocalData(memoryStorage()) // sign-out
    expect(localStorage.getItem('talos.nativePush.textPref')).toBeNull()
  })

  it("after an expiry the same owner's Turn on tap still honours the fixed phrase", async () => {
    const w = await world()
    await enableNativePush(w.deps)
    await setNativeText(w.deps, false)
    await clearLocalData(memoryStorage(), { keepUnsent: true })
    resetNativePushForTests({ keepStorage: true })
    const w2 = await world()
    await enableNativePush(w2.deps)
    expect(w2.r.grantHeld()).toBeNull()
  })
})

describe('Try again that fails again, and a sign-out during the Keychain write (fix check round)', () => {
  it('Try again from the Home card that fails again keeps the card, the line and Try again; the Settings row offers it too', async () => {
    const w = await world({ rejectGrant: true }, { permission: 'prompt' })
    await withHomeGlobals(w, async () => {
      useNativePush.setState({ view: { kind: 'off' } })
      homeCard(w)
      await userEvent.setup().click(await screen.findByTestId('setup-enable'))
      await screen.findByRole('button', { name: 'Try again' })
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' })) // fails again: the relay still refuses
      await waitFor(() => expect(w.r.posts.filter((p) => NativeGrant.safeParse(p.body).success).length).toBe(2))
      await waitFor(() => expect(useNativePush.getState().busy).toBe(false))
      expect(useNativePush.getState().textFailed).toBe(true)
      expect(useNativePush.getState().rich).toBe(false)
      expect(screen.getByText("Notifications are on, but message words didn't turn on.")).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
      // the Settings row, in the same state, offers Try again too
      cleanup()
      row(w)
      expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
      expect((await screen.findByTestId('native-push-text')).textContent).toMatch(/fixed phrase/)
    })
  })

  for (const [name, start] of [
    ['Turn on', (w: Awaited<ReturnType<typeof world>>) => enableNativePush(w.deps)],
    ['Show message text', (w: Awaited<ReturnType<typeof world>>) => setNativeText(w.deps, true)],
  ] as const) {
    it(`${name}: a sign-out while the phone is storing the grant leaves no words on and no keys behind`, async () => {
      let release = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      if (name === 'Show message text') localStorage.setItem('talos.nativePush.text', 'off') // kept off: Turn on makes no grant itself
      if (name === 'Show message text') localStorage.setItem('talos.nativePush.choice', 'on')
      const w = await world({}, { storeGate: gate, permission: 'granted' })
      const turning = start(w)
      await waitFor(() => expect(w.s.log.map((c) => c.call)).toContain('storeGrant'))
      await clearLocalData(memoryStorage()) // sign-out, with the Keychain write still open
      release()
      await turning
      expect(localStorage.getItem('talos.nativePush.text')).not.toBe('on')
      expect(localStorage.getItem('talos.nativePush.grantStored')).toBeNull()
      expect(useNativePush.getState().rich).not.toBe(true)
      expect(w.r.grantHeld()).toBeNull()
      const calls = w.s.log.map((c) => c.call)
      expect(calls.lastIndexOf('clearGrant')).toBeGreaterThan(calls.lastIndexOf('storeGrant'))
    })
  }
})

describe('a leftover value is not the default (review fix 6)', () => {
  it('text=on left over makes a grant, text=off left over does not, and a page with nothing recorded does (the default)', async () => {
    const results: Record<string, number> = {}
    for (const [name, stored] of [
      ['on', 'on'],
      ['off', 'off'],
      ['none', null],
    ] as const) {
      localStorage.clear()
      resetNativePushForTests()
      if (stored) localStorage.setItem('talos.nativePush.text', stored)
      const w = await world({}, { permission: 'prompt' })
      await enableNativePush(w.deps)
      results[name] = grantPosts(w).length
    }
    expect(results).toEqual({ on: 1, off: 0, none: 1 })
  })
})

void NativeGrantRevoke
void verifyOwnerFrame
