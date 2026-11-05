// WP-I3b web: Settings -> "Use the iPhone share sheet" inside the Capacitor shell. A fake window.Capacitor stands in for
// the shell; the relay is a fake fetch that remembers tokens.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareTokensPanel } from '../../src/features/share/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'
import { clearShareToken, setShareToken, shareSheetAvailable } from '../../src/lib/nativeShare.ts'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
beforeEach(() => localStorage.clear())
afterEach(cleanup)

const DEVICE = 'd_abcdefghijklmnopqrst'
const SECRET = (n: number) => `talos_share_${String(n).repeat(43)}`

function relay() {
  type Tok = Record<string, unknown>
  const list: Tok[] = []
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  let n = 0
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, path, body })
    if (method === 'GET') return Response.json(list)
    if (method === 'POST') {
      n += 1
      const t = {
        id: `sh_01JBF3V7Q8K2M4N6P8R0S2T4${n}A`,
        label: body?.label,
        device_id: DEVICE,
        scopes: body?.scopes,
        created_at: '2026-10-30T15:00:00.000Z',
        last_used_at: null,
        last_used_net: null,
        revoked_at: null,
      }
      list.push(t)
      return Response.json({ token: t, secret: SECRET(n) })
    }
    const id = path.split('/').pop()
    const i = list.findIndex((t) => t.id === id)
    if (i >= 0) list.splice(i, 1)
    return new Response(null, { status: 204 })
  })
  return { fn, calls, list }
}

function shell(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown }> = []
  const plugin = {
    setToken: async (a: unknown) => void calls.push({ method: 'setToken', args: a }),
    clearToken: async (a: unknown) => void calls.push({ method: 'clearToken', args: a }),
    ...overrides,
  }
  const scope = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { TalosShare: plugin } },
  }
  return { scope, calls }
}

function panel(r: ReturnType<typeof relay>, scope: unknown) {
  render(
    <ClientProvider client={createFakeClient()}>
      <ShareTokensPanel
        http={createHttp(r.fn as unknown as typeof fetch)}
        currentDeviceId={DEVICE}
        nativeScope={scope}
      />
    </ClientProvider>,
  )
}

const sheetSwitch = () => screen.findByRole('switch', { name: /iPhone share sheet/i })

describe('iPhone share sheet switch', () => {
  it('is absent in a browser and in a shell build without the plugin', async () => {
    panel(relay(), {})
    await screen.findByText(/No share links yet/)
    expect(screen.queryByRole('switch', { name: /iPhone share sheet/i })).toBeNull()
    cleanup()
    panel(relay(), { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} } })
    await screen.findByText(/No share links yet/)
    expect(screen.queryByRole('switch', { name: /iPhone share sheet/i })).toBeNull()
  })

  it('on (photos and files default to on, audit D50): one token on the relay, one setToken({token, scopes}) and no relay field', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(r.calls.find((c) => c.method === 'POST')?.body).toEqual({
      label: 'iPhone share sheet',
      scopes: ['text', 'files'],
    })
    expect(s.calls[0]).toEqual({ method: 'setToken', args: { token: SECRET(1), scopes: ['text', 'files'] } })
    expect(Object.keys(s.calls[0]?.args as object).sort()).toEqual(['scopes', 'token'])
    await waitFor(async () => expect((await sheetSwitch()).getAttribute('aria-checked')).toBe('true'))
    // The secret is not shown on the page (the shell holds it).
    expect(document.body.textContent).not.toContain(SECRET(1))
  })

  it('off: revokes on the relay and clears the Keychain', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    await waitFor(async () => expect((await sheetSwitch()).getAttribute('aria-checked')).toBe('true'))
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls.map((c) => c.method)).toEqual(['setToken', 'clearToken']))
    expect(r.list).toHaveLength(0)
    await waitFor(async () => expect((await sheetSwitch()).getAttribute('aria-checked')).toBe('false'))
  })

  it('reads on from the relay after the page forgot everything, and off/on leaves exactly one live token', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    cleanup()
    localStorage.clear() // the page forgot; the relay still has the first token
    panel(r, s.scope)
    await waitFor(async () => expect((await sheetSwitch()).getAttribute('aria-checked')).toBe('true'))
    await userEvent.click(await sheetSwitch()) // off
    await waitFor(() => expect(r.list).toHaveLength(0))
    await userEvent.click(await sheetSwitch()) // on again
    await waitFor(() => expect(s.calls.map((c) => c.method)).toEqual(['setToken', 'clearToken', 'setToken']))
    expect(r.list).toHaveLength(1)
  })

  it('files switch turned off: the token is text only', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await screen.findByRole('switch', { name: /photos and files/i }))
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    expect(s.calls[0]?.args).toEqual({ token: SECRET(1), scopes: ['text'] })
  })

  it('an older text-only sheet link says so and one tap swaps it for a photos-and-files link (audit D50)', async () => {
    const r = relay()
    const s = shell()
    // The link the phone already holds was made while photos defaulted to off.
    r.list.push({
      id: 'sh_01JBF3V7Q8K2M4N6P8R0S2T4OLD',
      label: 'iPhone share sheet',
      device_id: DEVICE,
      scopes: ['text'],
      created_at: '2026-10-29T15:00:00.000Z',
      last_used_at: null,
      last_used_net: null,
      revoked_at: null,
    })
    panel(r, s.scope)
    await waitFor(async () => expect((await sheetSwitch()).getAttribute('aria-checked')).toBe('true'))
    const row = await screen.findByTestId('sheet-files-off')
    await userEvent.click(within(row).getByRole('button', { name: 'Allow photos and files' }))
    await waitFor(() => expect(s.calls).toHaveLength(1))
    expect(s.calls[0]).toEqual({ method: 'setToken', args: { token: SECRET(1), scopes: ['text', 'files'] } })
    expect(r.list).toHaveLength(1) // the old link is revoked, never two live ones
    expect(r.list[0]?.scopes).toEqual(['text', 'files'])
    await waitFor(() => expect(screen.queryByTestId('sheet-files-off')).toBeNull())
  })

  it('a sheet link that already allows files shows no warning', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    expect(screen.queryByTestId('sheet-files-off')).toBeNull()
  })

  it('the shell refusing the token revokes it again and says so', async () => {
    const r = relay()
    const s = shell({
      setToken: async () => {
        throw new Error('nope')
      },
    })
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(r.list).toHaveLength(0)
  })
})

describe('nativeShare helpers', () => {
  it('answer false and call nothing outside the shell', async () => {
    const s = shell()
    expect(shareSheetAvailable({})).toBe(false)
    expect(await setShareToken(SECRET(1), ['text'], {})).toBe(false)
    expect(await clearShareToken({})).toBe(false)
    expect(shareSheetAvailable(s.scope)).toBe(true)
    expect(s.calls).toEqual([])
  })
})
