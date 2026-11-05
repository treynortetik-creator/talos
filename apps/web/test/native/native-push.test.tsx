// WP-I5 web: the iPhone shell's push plugin wrapper, the Settings row's states, signed registration, open-time refresh,
// notification taps. A fake window.Capacitor stands in for the shell; the relay is a fake fetch.
import { createDeviceKey, signOwnerFrame, verifyOwnerFrame } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativePushRow } from '../../src/features/pwa/NativePushRow.tsx'
import {
  disableNativePush,
  enableNativePush,
  refreshNativeOnOpen,
  refreshNativePush,
  resetNativePushForTests,
  useNativePush,
} from '../../src/features/pwa/nativePush.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'
import {
  NativePushError,
  nativePermission,
  nativePushAvailable,
  onNativePushAction,
  registerNative,
} from '../../src/lib/nativePush.ts'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
const TOKEN = 'ab'.repeat(32)

beforeEach(() => {
  resetNativePushForTests()
  useNativePush.setState({ view: { kind: 'checking' }, busy: false, note: null })
})
afterEach(cleanup)

type Calls = Array<{ method: string; args?: unknown }>
function shell(
  o: {
    permission?: string
    register?: (a: unknown) => Promise<unknown>
    noPlugin?: boolean
    android?: boolean
    extra?: Record<string, unknown>
  } = {},
) {
  const calls: Calls = []
  const listeners: Array<(e: unknown) => void> = []
  const removed: number[] = []
  let permission = o.permission ?? 'prompt'
  const plugin = {
    getStatus: async () => ({ permission }),
    register: async (a: unknown) => {
      calls.push({ method: 'register', args: a })
      const r = await (o.register ? o.register(a) : { token: TOKEN, env: 'sandbox' })
      permission = 'granted' // the owner tapped Allow
      return r
    },
    unregister: async () => void calls.push({ method: 'unregister' }),
    addListener: async (_e: string, cb: (e: unknown) => void) => {
      listeners.push(cb)
      return { remove: () => void removed.push(listeners.length) }
    },
    ...o.extra,
  }
  const scope = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => (o.android ? 'android' : 'ios'),
      Plugins: o.noPlugin ? {} : { TalosPush: plugin },
    },
  }
  return { scope, calls, listeners, removed }
}

type Req = { method: string; path: string; body?: Record<string, unknown> }
function relay(
  o: {
    configured?: boolean
    registered?: boolean
    status?: number
    post?: (b: Record<string, unknown>) => Response
    hang?: boolean
  } = {},
) {
  const reqs: Req[] = []
  let registered = o.registered ?? false
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    reqs.push({ method, path, ...(body ? { body } : {}) })
    if (path === '/api/push/apns' && method === 'GET') {
      if (o.hang) return new Promise<Response>(() => {})
      if (o.status) return Response.json({ error: 'x' }, { status: o.status })
      return Response.json({ configured: o.configured ?? true, registered })
    }
    if (path === '/api/push/apns' && method === 'POST') {
      if (o.post) return o.post(body ?? {})
      registered = body?.op === 'register'
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 204 })
  })
  return { fn, reqs, http: createHttp(fn as unknown as typeof fetch) }
}

function row(r: ReturnType<typeof relay>, scope: unknown, onTest?: () => Promise<boolean>) {
  render(
    <ClientProvider client={createFakeClient()}>
      <NativePushRow http={r.http} scope={scope} {...(onTest ? { onTest } : {})} />
    </ClientProvider>,
  )
}
const status = () => screen.findByTestId('native-push-status')

describe('plugin wrapper', () => {
  it('is only available inside the iPhone shell with the plugin; an older shell or a browser says no', () => {
    expect(nativePushAvailable(shell().scope)).toBe(true)
    expect(nativePushAvailable(shell({ noPlugin: true }).scope)).toBe(false)
    expect(nativePushAvailable(shell({ android: true }).scope)).toBe(false)
    expect(nativePushAvailable({})).toBe(false)
    expect(nativePushAvailable(null)).toBe(false)
  })

  it('a token the page cannot trust is refused: junk, uppercase, too short, wrong type, unknown env', async () => {
    const bad = [
      { token: 'zz'.repeat(32), env: 'sandbox' },
      { token: 'AB'.repeat(32), env: 'sandbox' },
      { token: 'ab', env: 'sandbox' },
      { token: 42, env: 'sandbox' },
      { token: TOKEN, env: 'staging' },
      { token: TOKEN },
      null,
      'ok',
    ]
    for (const r of bad) {
      const s = shell({ register: async () => r })
      await expect(registerNative({ prompt: true }, s.scope)).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  it('maps the plugin failures it knows and calls anything else invalid', async () => {
    for (const code of ['denied', 'unavailable', 'prompt', 'timeout'] as const) {
      const s = shell({ register: async () => Promise.reject({ code }) })
      await expect(registerNative({ prompt: false }, s.scope)).rejects.toMatchObject({ code })
    }
    for (const e of [{ code: 'weird' }, new Error('boom'), 'str', undefined]) {
      const s = shell({ register: () => Promise.reject(e) })
      await expect(registerNative({ prompt: true }, s.scope)).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(registerNative({ prompt: true }, {})).rejects.toBeInstanceOf(NativePushError)
  })

  it('permission: anything but granted/denied reads as prompt, never as granted', async () => {
    expect(await nativePermission(shell({ permission: 'granted' }).scope)).toBe('granted')
    expect(await nativePermission(shell({ permission: 'denied' }).scope)).toBe('denied')
    expect(await nativePermission(shell({ permission: 'provisional' }).scope)).toBe('prompt')
    expect(
      await nativePermission(shell({ extra: { getStatus: async () => Promise.reject(new Error('x')) } }).scope),
    ).toBe('prompt')
  })

  it('a tap navigates to the in-app path; anything else a page could be handed is dropped', async () => {
    const s = shell()
    const nav = vi.fn()
    const off = onNativePushAction(nav, s.scope)
    await Promise.resolve()
    const fire = s.listeners[0]
    expect(fire).toBeDefined()
    for (const navigate of ['/card/c_01JBF3V7Q8K2M4N6P8R0S2T4V6', '/t/general', '/settings/health'])
      fire?.({ action: 'open', navigate })
    expect(nav.mock.calls.map((c) => c[0])).toEqual([
      '/card/c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      '/t/general',
      '/settings/health',
    ])
    nav.mockClear()
    for (const navigate of [
      '//evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/api/devices',
      '/media/x',
      '/%6dedia/x',
      '\\x',
      42,
      undefined,
      null,
    ])
      fire?.({ action: 'approve', navigate })
    fire?.(null)
    fire?.('/t/general')
    expect(nav).not.toHaveBeenCalled()
    off()
    await Promise.resolve()
    expect(s.removed).toHaveLength(1)
  })

  it('no plugin, no listener; removing before the listener is attached still removes it', async () => {
    expect(onNativePushAction(vi.fn(), shell({ noPlugin: true }).scope)).toBeTypeOf('function')
    let resolve: (h: { remove: () => void }) => void = () => {}
    const removed = vi.fn()
    const s = shell({ extra: { addListener: () => new Promise((r) => (resolve = r)) } })
    const off = onNativePushAction(vi.fn(), s.scope)
    off()
    resolve({ remove: removed })
    await waitFor(() => expect(removed).toHaveBeenCalled())
  })
})

describe('the Settings row tells the truth', () => {
  it('renders nothing outside the iPhone shell', async () => {
    const r = relay()
    row(r, {})
    await waitFor(() => expect(useNativePush.getState().view.kind).toBe('hidden'))
    expect(screen.queryByTestId('native-push')).toBeNull()
    expect(r.reqs).toHaveLength(0)
  })

  it('loading: says Checking... while the server has not answered, and offers nothing to tap', async () => {
    row(relay({ hang: true }), shell().scope)
    expect((await status()).textContent).toContain('Checking...')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('an app build without the plugin: Needs setup (build), no server call, no buttons but Check again', async () => {
    const r = relay()
    row(r, shell({ noPlugin: true }).scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Needs setup'))
    expect(screen.getByTestId('native-push-detail').textContent).toMatch(/built without push/)
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull()
    expect(r.reqs).toHaveLength(0)
  })

  it('Off and On both say a Home Screen app with notifications on gives two (audit D51)', async () => {
    row(relay({ configured: true }), shell().scope)
    expect((await screen.findByTestId('native-push-double')).textContent).toMatch(/Home Screen app.*you get two/)
  })

  it('a row that is Needs setup does not say it', async () => {
    row(relay({ configured: false }), shell().scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Needs setup'))
    expect(screen.queryByTestId('native-push-double')).toBeNull()
  })

  it('a server with no Apple key: Needs setup (server), no Turn on button', async () => {
    row(relay({ configured: false }), shell().scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Needs setup'))
    expect(screen.getByTestId('native-push-detail').textContent).toMatch(/Apple push key/)
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull()
  })

  it('an older relay that has never heard of the route (404): also Needs setup (server)', async () => {
    row(relay({ status: 404 }), shell().scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Needs setup'))
    expect(screen.getByTestId('native-push-detail').textContent).toMatch(/Apple push key/)
  })

  it('failed: the server is down. Says so, offers Check again, and recovers', async () => {
    let down = true
    const base = relay()
    const fn = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) =>
      down ? Promise.reject(new TypeError('offline')) : base.fn(u, i),
    )
    render(
      <ClientProvider client={createFakeClient()}>
        <NativePushRow http={createHttp(fn as unknown as typeof fetch)} scope={shell().scope} />
      </ClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain("Couldn't check"))
    expect(screen.getByRole('alert').textContent).toMatch(/Try again/)
    down = false
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Off'))
  })

  it('off: shows Turn on notifications; nothing was asked of iOS just by looking', async () => {
    const s = shell()
    row(relay(), s.scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Off'))
    expect(s.calls).toEqual([])
  })

  it('blocked: iOS says denied. Tells the owner where to fix it; no Turn on button', async () => {
    row(relay(), shell({ permission: 'denied' }).scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Blocked'))
    expect(screen.getByText(/iPhone Settings app/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull()
  })

  it('on: granted and the relay knows this phone; test and Turn off are there', async () => {
    const test = vi.fn(async () => true)
    row(relay({ registered: true }), shell({ permission: 'granted' }).scope, test)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('On'))
    await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }))
    expect(test).toHaveBeenCalledOnce()
    expect(await screen.findByText('Test sent.')).toBeTruthy()
  })

  it('granted by iOS but unknown to the relay (reinstalled server) reads Off, not On', async () => {
    row(relay({ registered: false }), shell({ permission: 'granted' }).scope)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Off'))
  })
})

describe('turning it on', () => {
  it('a tap asks iOS (with the prompt), signs the token with the device key and posts exactly the signed frame', async () => {
    const s = shell()
    const r = relay()
    const key = await createDeviceKey()
    const client = {
      ...createFakeClient(),
      signOwnerFrame: (f: Record<string, unknown>) => signOwnerFrame({ ...f, device_id: key.deviceId }, key.privateKey),
    } as unknown as TalosClient
    render(
      <ClientProvider client={client}>
        <NativePushRow http={r.http} scope={s.scope} />
      </ClientProvider>,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('On'))
    expect(s.calls).toEqual([{ method: 'register', args: { prompt: true } }])
    const post = r.reqs.find((q) => q.method === 'POST')
    expect(post?.path).toBe('/api/push/apns')
    expect(Object.keys(post?.body ?? {}).sort()).toEqual([
      'device_id',
      'env',
      'nonce',
      'op',
      'osig',
      'token',
      'ts',
      'type',
      'v',
    ])
    expect(post?.body).toMatchObject({ v: 1, type: 'push.apns', op: 'register', token: TOKEN, env: 'sandbox' })
    // the signature is the device's, over the raw body (a real verification, not a shape check)
    expect(await verifyOwnerFrame(post?.body ?? {}, key.publicJwk)).toBe(true)
    expect(post?.body).not.toHaveProperty('relay')
    expect(await screen.findByText('Notifications are on.')).toBeTruthy()
  })

  it('a double tap registers once', async () => {
    const s = shell()
    const r = relay()
    row(r, s.scope)
    const b = await screen.findByRole('button', { name: 'Turn on notifications' })
    await userEvent.dblClick(b)
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('On'))
    expect(s.calls.filter((c) => c.method === 'register')).toHaveLength(1)
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(1)
  })

  it('keyboard: Tab to the button and Enter turns it on', async () => {
    const s = shell()
    row(relay(), s.scope)
    await screen.findByRole('button', { name: 'Turn on notifications' })
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Turn on notifications' }))
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('On'))
  })

  it('the owner says No to the iOS dialog: Blocked, nothing sent to the server', async () => {
    const s = shell({ register: () => Promise.reject({ code: 'denied' }) })
    const r = relay()
    row(r, s.scope)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Blocked'))
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(0)
  })

  it('a build without the push capability (free Apple account): Needs setup, not a vague error', async () => {
    const s = shell({ register: () => Promise.reject({ code: 'unavailable' }) })
    row(relay(), s.scope)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Needs setup'))
    expect(screen.getByTestId('native-push-detail').textContent).toMatch(/push capability/)
  })

  it.each([
    [409, { error: 'not_configured' }, 'Needs setup', /Apple push key/],
    [400, { error: 'stale' }, "Couldn't check", /clock is off/],
    [403, { error: 'wrong_device' }, "Couldn't check", /Mac has not confirmed/],
    [429, undefined, "Couldn't check", /Too many tries/],
    [500, undefined, "Couldn't check", /Try again/],
  ])('the server says %i: the row says why', async (code, body, statusText, detail) => {
    row(relay({ post: () => Response.json(body ?? {}, { status: code }) }), shell().scope)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain(statusText))
    expect(screen.getByTestId('native-push-detail').textContent).toMatch(detail)
  })

  it('a wedged server leaves the button usable afterwards (busy clears)', async () => {
    row(relay({ post: () => new Response('nope', { status: 502 }) }), shell().scope)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }))
    await waitFor(() => expect(useNativePush.getState().busy).toBe(false))
  })
})

describe('Approve and Open taps', () => {
  const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'
  it('Approve arms only a bare /card/<id> path; Open and every other path never do', async () => {
    const s = shell()
    const nav = vi.fn()
    onNativePushAction(nav, s.scope)
    await Promise.resolve()
    const fire = s.listeners[0]
    fire?.({ action: 'approve', navigate: `/card/${CARD}` })
    fire?.({ action: 'open', navigate: `/card/${CARD}` })
    fire?.({ action: 'approve', navigate: '/t/general' })
    fire?.({ action: 'approve', navigate: `/card/${CARD}?x=1` })
    fire?.({ action: 'approve', navigate: '/card/not-an-id' })
    fire?.({ action: 'ARM', navigate: `/card/${CARD}` })
    expect(nav.mock.calls.map((c) => c[0])).toEqual([
      `/card/${CARD}`,
      `/card/${CARD}`,
      '/t/general',
      `/card/${CARD}?x=1`,
      '/card/not-an-id',
      `/card/${CARD}`,
    ])
    // The arm travels as a second argument, in memory, and only for Approve on a bare card path.
    expect(nav.mock.calls.map((c) => c[1]?.arm)).toEqual([CARD, undefined, undefined, undefined, undefined, undefined])
  })
})

describe('Turn off during an in-flight refresh', () => {
  it('the refresh that was already waiting on iOS does not put the token back', async () => {
    let release: (v: unknown) => void = () => {}
    let first = true
    const s = shell({
      permission: 'granted',
      register: (a) => {
        const isFirst = first
        first = false
        return isFirst
          ? Promise.resolve({ token: TOKEN, env: 'sandbox' })
          : new Promise((res) => {
              release = res
              void a
            })
      },
    })
    const r = relay({ registered: false })
    const d = { client: createFakeClient(), http: r.http, scope: s.scope }
    await enableNativePush(d)
    r.reqs.length = 0
    const open = refreshNativeOnOpen(d)
    await new Promise((res) => setTimeout(res, 20))
    await disableNativePush(d)
    release({ token: TOKEN, env: 'sandbox' })
    await open
    expect(r.reqs.filter((q) => q.method === 'POST').map((q) => q.body?.op)).toEqual(['unregister'])
  })
})

describe('two runs at once', () => {
  it('enableNativePush called twice together asks iOS and the server once', async () => {
    const s = shell()
    const r = relay()
    const d = { client: createFakeClient(), http: r.http, scope: s.scope }
    await Promise.all([enableNativePush(d), enableNativePush(d)])
    expect(s.calls.filter((c) => c.method === 'register')).toHaveLength(1)
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(1)
  })
})

describe('turning it off', () => {
  it('signs an unregister, tells iOS, and reads Off', async () => {
    const s = shell({ permission: 'granted' })
    const r = relay({ registered: true })
    row(r, s.scope)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain('Off'))
    const post = r.reqs.find((q) => q.method === 'POST')
    expect(post?.body).toMatchObject({ op: 'unregister', type: 'push.apns' })
    expect(post?.body).not.toHaveProperty('token')
    expect(s.calls.map((c) => c.method)).toEqual(['unregister'])
  })

  it('off while the server is unreachable: stays On and says so (no false Off)', async () => {
    row(
      relay({ registered: true, post: () => new Response('x', { status: 503 }) }),
      shell({ permission: 'granted' }).scope,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toContain("Couldn't check"))
  })
})

describe('on every open', () => {
  const deps = (r: ReturnType<typeof relay>, scope: unknown) => ({ client: createFakeClient(), http: r.http, scope })

  it('never prompts: it refreshes the token only for a phone the owner turned on, with iOS granted', async () => {
    const s = shell({ permission: 'granted' })
    const r = relay({ registered: true })
    await enableNativePush(deps(r, s.scope))
    s.calls.length = 0
    r.reqs.length = 0
    await refreshNativeOnOpen(deps(r, s.scope))
    expect(s.calls).toEqual([{ method: 'register', args: { prompt: false } }])
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(1)
  })

  it('registers again when the relay lost the token but the owner never turned it off', async () => {
    const s = shell({ permission: 'granted' })
    const r = relay({ registered: false })
    await enableNativePush(deps(r, s.scope))
    r.reqs.length = 0
    await refreshNativeOnOpen(deps(r, s.scope))
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(1)
  })

  it('stays quiet for a phone the owner turned off, and for one he never turned on', async () => {
    const s = shell({ permission: 'granted' })
    const r = relay({ registered: true })
    await refreshNativeOnOpen(deps(r, s.scope)) // never turned on
    await enableNativePush(deps(r, s.scope))
    await disableNativePush(deps(r, s.scope))
    s.calls.length = 0
    r.reqs.length = 0
    await refreshNativeOnOpen(deps(r, s.scope))
    expect(s.calls).toEqual([])
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(0)
  })

  it('iOS says denied while the relay holds a token: one signed unregister, nothing else', async () => {
    const s = shell({ permission: 'denied' })
    const r = relay({ registered: true })
    await refreshNativeOnOpen(deps(r, s.scope))
    expect(r.reqs.filter((q) => q.method === 'POST').map((q) => q.body?.op)).toEqual(['unregister'])
    expect(s.calls).toEqual([])
  })

  it.each([
    ['permission not granted', { permission: 'prompt' }, { registered: true }],
    ['permission denied and the relay has no token', { permission: 'denied' }, { registered: false }],
    ['the owner never turned it on and the relay has no token', { permission: 'granted' }, { registered: false }],
    ['the server has no key', { permission: 'granted' }, { configured: false, registered: true }],
  ])('does nothing when %s', async (_n, so, ro) => {
    const s = shell(so)
    const r = relay(ro)
    await refreshNativeOnOpen(deps(r, s.scope))
    expect(s.calls).toEqual([])
    expect(r.reqs.filter((q) => q.method === 'POST')).toHaveLength(0)
  })

  it('swallows a server error and an old shell (no plugin) without throwing', async () => {
    await expect(
      refreshNativeOnOpen(deps(relay({ status: 500 }), shell({ permission: 'granted' }).scope)),
    ).resolves.toBeUndefined()
    await expect(refreshNativeOnOpen(deps(relay(), shell({ noPlugin: true }).scope))).resolves.toBeUndefined()
    await expect(refreshNativeOnOpen(deps(relay(), {}))).resolves.toBeUndefined()
  })

  it('refreshNativePush two at once settles on one answer', async () => {
    const s = shell({ permission: 'granted' })
    const r = relay({ registered: true })
    const d = deps(r, s.scope)
    const views = await Promise.all([refreshNativePush(d), refreshNativePush(d)])
    expect(views.map((v) => v.kind)).toEqual(['on', 'on'])
  })
})
