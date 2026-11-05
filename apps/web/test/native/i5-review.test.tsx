// Push regression tests, web side. Each test pins a bug that was found and fixed. Same fake shell and fake relay shape as native-push.test.tsx.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disableNativePush,
  enableNativePush,
  refreshNativeOnOpen,
  refreshNativePush,
  useNativePush,
} from '../../src/features/pwa/nativePush.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'
import { onNativePushAction } from '../../src/lib/nativePush.ts'

const TOKEN = 'ab'.repeat(32)
const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'

beforeEach(() => {
  useNativePush.setState({ view: { kind: 'checking' }, busy: false, note: null })
  try {
    localStorage.clear()
  } catch {
    /* no storage in this environment */
  }
})

function shell(o: { permission?: string; register?: (a: unknown) => Promise<unknown> } = {}) {
  const listeners: Array<(e: unknown) => void> = []
  const plugin = {
    getStatus: async () => ({ permission: o.permission ?? 'granted' }),
    register: async (a: unknown) => (o.register ? o.register(a) : { token: TOKEN, env: 'sandbox' }),
    unregister: async () => {},
    addListener: async (_e: string, cb: (e: unknown) => void) => {
      listeners.push(cb)
      return { remove: () => {} }
    },
  }
  return {
    listeners,
    scope: {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { TalosPush: plugin } },
    },
  }
}

function relay(state: { configured?: boolean; registered: boolean }) {
  const posts: Array<Record<string, unknown>> = []
  const fn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET')
      return Response.json({ configured: state.configured ?? true, registered: state.registered })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    posts.push(body)
    state.registered = body.op === 'register'
    return new Response(null, { status: 204 })
  })
  return { posts, http: createHttp(fn as unknown as typeof fetch), state }
}

describe('I5-M1 a token the relay dropped comes back', () => {
  it('M1 Apple 410 on a rotated token: the next open re-registers, the owner never turned it off', async () => {
    const s = shell()
    const r = relay({ registered: false })
    const d = { client: createFakeClient(), http: r.http, scope: s.scope }
    await enableNativePush(d) // the owner tapped Turn on
    expect(r.state.registered).toBe(true)
    r.state.registered = false // the relay deleted the row on 410 (core/push.ts, `res.gone`); iOS has a new token
    r.posts.length = 0
    await refreshNativeOnOpen(d)
    expect(r.posts.map((p) => p.op)).toEqual(['register'])
  })
})

describe('I5-M4 iOS notifications turned off for the app', () => {
  it('M4 on open the relay is told, so APNs 200s stop hiding the Home Screen web push', async () => {
    const s = shell({ permission: 'denied' })
    const r = relay({ registered: true })
    await refreshNativeOnOpen({ client: createFakeClient(), http: r.http, scope: s.scope })
    expect(r.posts.map((p) => p.op)).toEqual(['unregister'])
  })
})

describe('I5-M6 the Approve button (IOS-SPEC 6.4)', () => {
  it('M6 an Approve tap opens the card armed; an Open tap does not', async () => {
    const s = shell()
    const nav = vi.fn()
    onNativePushAction(nav, s.scope)
    await vi.waitFor(() => expect(s.listeners).toHaveLength(1))
    s.listeners[0]?.({ action: 'open', navigate: `/card/${CARD}` })
    s.listeners[0]?.({ action: 'approve', navigate: `/card/${CARD}` })
    expect(nav.mock.calls.map((c) => c[0])).toEqual([`/card/${CARD}`, `/card/${CARD}`])
    expect(nav.mock.calls.map((c) => c[1]?.arm)).toEqual([undefined, CARD])
  })
})

describe('I5-L3 the row and a build that cannot get a token', () => {
  it('L3 "Check again" after a capability failure stays Needs setup instead of flipping back to Off', async () => {
    const s = shell({
      permission: 'prompt',
      register: async () => {
        throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      },
    })
    const r = relay({ registered: false })
    const d = { client: createFakeClient(), http: r.http, scope: s.scope }
    await enableNativePush(d)
    expect(useNativePush.getState().view).toEqual({ kind: 'needs_setup', why: 'capability' })
    await refreshNativePush(d) // the row's own "Check again" button
    expect(useNativePush.getState().view.kind).toBe('needs_setup')
  })
})

describe('I5-L4 turning off during the open refresh', () => {
  it('L4 Turn off wins over a token refresh that was already in flight', async () => {
    let release: (v: unknown) => void = () => {}
    const s = shell({ register: () => new Promise((res) => (release = res)) })
    const r = relay({ registered: true })
    const d = { client: createFakeClient(), http: r.http, scope: s.scope }
    const open = refreshNativeOnOpen(d)
    await new Promise((res) => setTimeout(res, 20))
    await disableNativePush(d)
    release({ token: TOKEN, env: 'sandbox' })
    await open
    expect(r.state.registered).toBe(false)
  })
})
