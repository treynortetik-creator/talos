// WP-I5 re-review: R6 (the phone's own test), R8 (cleared storage), R9 (no capability), R10 (resume), R12 (Blocked), R3/R4
// (the iPhone row says what Apple can read), and the /open/<ref> route a named thread's notification lands on.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativePushRow } from '../../src/features/pwa/NativePushRow.tsx'
import {
  refreshNativeOnOpen,
  refreshNativePush,
  resetNativePushForTests,
  startNativeResume,
  useNativePush,
} from '../../src/features/pwa/nativePush.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'

const TOKEN = 'ab'.repeat(32)
beforeEach(() => {
  resetNativePushForTests()
  useNativePush.setState({ view: { kind: 'checking' }, busy: false, note: null })
})
afterEach(cleanup)

function shell(o: { permission?: () => string; capable?: boolean } = {}) {
  const calls: string[] = []
  const scope = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        TalosPush: {
          getStatus: async () => ({
            permission: o.permission?.() ?? 'prompt',
            ...(o.capable === undefined ? {} : { capable: o.capable }),
          }),
          register: async (a: { prompt: boolean }) => {
            calls.push(`register:${a.prompt}`)
            return { token: TOKEN, env: 'sandbox' }
          },
          unregister: async () => {},
          addListener: async () => ({ remove() {} }),
        },
      },
    },
  }
  return { scope, calls }
}

function relay(o: { registered?: boolean; testStatus?: number } = {}) {
  const reqs: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    reqs.push({ method, path, ...(body ? { body } : {}) })
    if (path === '/api/push/apns' && method === 'GET')
      return Response.json({ configured: true, registered: o.registered ?? false })
    if (path.startsWith('/api/push/test')) return new Response(null, { status: o.testStatus ?? 204 })
    return new Response(null, { status: 204 })
  })
  return { reqs, http: createHttp(fn as unknown as typeof fetch) }
}
const deps = (r: ReturnType<typeof relay>, scope: unknown) => ({ client: createFakeClient(), http: r.http, scope })
const posts = (r: ReturnType<typeof relay>) =>
  r.reqs.filter((q) => q.method === 'POST' && q.path === '/api/push/apns').map((q) => q.body?.op)

describe('R8 cleared page storage', () => {
  it('a phone the relay still holds is refreshed even with no recorded choice', async () => {
    const s = shell({ permission: () => 'granted' })
    const r = relay({ registered: true })
    await refreshNativeOnOpen(deps(r, s.scope))
    expect(s.calls).toEqual(['register:false'])
    expect(posts(r)).toEqual(['register'])
  })
})

describe('R9 a build without the push capability', () => {
  it('is Needs setup (capability) straight away: no Turn on button, nothing asked of iOS', async () => {
    const s = shell({ capable: false })
    const r = relay()
    render(
      <ClientProvider client={createFakeClient()}>
        <NativePushRow http={r.http} scope={s.scope} />
      </ClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toBe('Needs setup'))
    expect(screen.getByTestId('native-push-detail').textContent).toMatch(/push capability/)
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull()
    expect(s.calls).toEqual([])
  })
  it('an older shell that does not say is treated as capable', async () => {
    const s = shell()
    expect((await refreshNativePush(deps(relay(), s.scope))).kind).toBe('off')
  })
})

describe('R10 coming back to the front', () => {
  it('re-checks on resume, at most once per interval', async () => {
    const s = shell({ permission: () => 'granted' })
    const r = relay({ registered: true })
    let t = 1_000_000
    const off = startNativeResume(deps(r, s.scope), { now: () => t, every: 300_000 })
    const show = () => document.dispatchEvent(new Event('visibilitychange'))
    show()
    await Promise.resolve()
    expect(r.reqs).toHaveLength(0) // too soon after start
    t += 301_000
    show()
    await waitFor(() => expect(posts(r)).toEqual(['register']))
    show()
    t += 10_000
    show()
    await new Promise((res) => setTimeout(res, 30))
    expect(posts(r)).toEqual(['register']) // throttled
    off()
    t += 400_000
    show()
    await new Promise((res) => setTimeout(res, 30))
    expect(posts(r)).toEqual(['register']) // stopped
  })
})

describe('R12 Blocked clears when iOS is allowed again', () => {
  it('re-reads on resume and offers Check again while Blocked', async () => {
    let perm = 'denied'
    const s = shell({ permission: () => perm })
    const r = relay()
    render(
      <ClientProvider client={createFakeClient()}>
        <NativePushRow http={r.http} scope={s.scope} />
      </ClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toBe('Blocked'))
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
    perm = 'prompt'
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(screen.getByTestId('native-push-status').textContent).toBe('Off'))
  })
})

describe('R3/R4 the row says what Apple can read', () => {
  it('tells the truth about thread names on iPhone, and the browser setting', async () => {
    render(
      <ClientProvider client={createFakeClient()}>
        <NativePushRow http={relay().http} scope={shell().scope} />
      </ClientProvider>,
    )
    const note = await screen.findByTestId('native-push-names')
    expect(note.textContent).toMatch(/changes browser notifications/)
    expect(note.textContent).toMatch(/General and Inbox/)
    expect(note.textContent).toMatch(/a thread/)
  })
})

describe('R6 the test button asks about the phone', () => {
  it('sends ?via=apns and reads a 502 as not sent', async () => {
    const r = relay({ registered: true, testStatus: 502 })
    render(
      <ClientProvider client={createFakeClient()}>
        <NativePushRow http={r.http} scope={shell({ permission: () => 'granted' }).scope} />
      </ClientProvider>,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Send a test notification' }))
    expect(await screen.findByText("Couldn't send the test.")).toBeTruthy()
    expect(r.reqs.some((q) => q.method === 'POST' && q.path === '/api/push/test?via=apns')).toBe(true)
  })
})
