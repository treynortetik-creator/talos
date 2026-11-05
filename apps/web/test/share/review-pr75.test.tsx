// Independent review of #75 (WP-I3b web side). Same seams as iphone-sheet.test.tsx: the real ShareTokensPanel, the real
// createHttp over a fake relay fetch, and a fake window.Capacitor standing in for the shell.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildConfig } from '../../../mobile/capacitor.config'
import { ShareTokensPanel } from '../../src/features/share/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'

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

function relay(opts: { failDelete?: boolean } = {}) {
  type Tok = Record<string, unknown>
  const list: Tok[] = []
  let n = 0
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
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
    if (opts.failDelete) return Response.json({ error: 'unavailable' }, { status: 503 })
    const id = path.split('/').pop()
    const i = list.findIndex((t) => t.id === id)
    if (i >= 0) list.splice(i, 1)
    return new Response(null, { status: 204 })
  })
  return { fn, list, opts }
}

function shell() {
  const calls: string[] = []
  const plugin = {
    setToken: async () => void calls.push('setToken'),
    clearToken: async () => void calls.push('clearToken'),
  }
  return {
    scope: { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { TalosShare: plugin } } },
    calls,
  }
}

function panel(r: ReturnType<typeof relay>, scope: unknown, deviceId: string | null = DEVICE) {
  render(
    <ClientProvider client={createFakeClient()}>
      <ShareTokensPanel
        http={createHttp(r.fn as unknown as typeof fetch)}
        currentDeviceId={deviceId}
        nativeScope={scope}
      />
    </ClientProvider>,
  )
}

const sheetSwitch = () => screen.findByRole('switch', { name: /iPhone share sheet/i })
const checked = async () => (await sheetSwitch()).getAttribute('aria-checked')

describe('review #75: iPhone share sheet switch', () => {
  it('REVIEW-FAIL: turning it off clears the Keychain even when the relay revoke fails (the phone fails closed)', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    await waitFor(async () => expect(await checked()).toBe('true'))
    r.opts.failDelete = true
    await userEvent.click(await sheetSwitch())
    expect(await screen.findByRole('alert')).toBeTruthy()
    // The relay still has the token, so the extension can still send with it unless the Keychain copy is gone.
    expect(s.calls).toEqual(['setToken', 'clearToken'])
  })

  it('REVIEW-FAIL: a live sheet token for this device reads as on after the page forgot its local id', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope)
    await userEvent.click(await sheetSwitch())
    await waitFor(async () => expect(await checked()).toBe('true'))
    cleanup()
    localStorage.clear() // WebKit storage cleared / evicted; the Keychain and the relay still hold the token
    panel(r, s.scope)
    await screen.findByText(/This device/)
    expect(r.list).toHaveLength(1)
    // The extension still works, so the switch must not tell the owner it is off.
    expect(await checked()).toBe('true')
  })

  it('REVIEW-FAIL: before the device id is known, two taps never leave two live sheet tokens', async () => {
    const r = relay()
    const s = shell()
    panel(r, s.scope, null) // useTalos().deviceId is null until the socket has the device key
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls).toEqual(['setToken']))
    await waitFor(async () => expect((await sheetSwitch()).hasAttribute('disabled')).toBe(false))
    await userEvent.click(await sheetSwitch())
    await waitFor(() => expect(s.calls.length).toBeGreaterThanOrEqual(2))
    expect(r.list.filter((t) => t.label === 'iPhone share sheet')).toHaveLength(1)
  })
})

describe('review #75: the share secret and the Capacitor debug log', () => {
  // The exact Capacitor iOS the shell pins (CapApp-SPM exact: "8.5.3").
  const BRIDGE = join(
    process.cwd(),
    'node_modules/.pnpm/@capacitor+ios@8.5.3_@capacitor+core@8.5.3/node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js',
  )

  it('(holds as a fact) with Capacitor logging on, the bridge console.dir()s setToken options, secret included', () => {
    const dumped: unknown[] = []
    const win: Record<string, unknown> = {
      Capacitor: { DEBUG: true, isLoggingEnabled: true, Plugins: {} },
      webkit: { messageHandlers: { bridge: { postMessage: () => {} } } },
      console: {
        log() {},
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
        groupCollapsed() {},
        groupEnd() {},
        dir: (o: unknown) => dumped.push(o),
      },
      location: { protocol: 'https:', host: 'relay.example.com', origin: 'https://relay.example.com' },
      navigator: { userAgent: 'iPhone' },
      document: { addEventListener() {}, readyState: 'complete' },
      addEventListener() {},
    }
    class FakeDocument {
      get cookie() {
        return ''
      }
      set cookie(_v: string) {}
    }
    class FakeXhr {}
    Object.assign(win, {
      Document: FakeDocument,
      HTMLDocument: FakeDocument,
      XMLHttpRequest: FakeXhr,
      fetch: async () => new Response(null),
      prompt: () => null,
    })
    win.window = win
    runInNewContext(readFileSync(BRIDGE, 'utf8'), win)
    const cap = win.Capacitor as { toNative: (p: string, m: string, o: unknown, cb: unknown) => void }
    cap.toNative('TalosShare', 'setToken', { token: SECRET(7), scopes: ['text'] }, { resolve() {}, reject() {} })
    expect(JSON.stringify(dumped)).toContain(SECRET(7))
  })

  it('REVIEW-FAIL: the shell config turns Capacitor logging off, so setToken never prints the secret', () => {
    const cfg = buildConfig({ TALOS_RELAY_URL: 'https://relay.example.com' }) as {
      loggingBehavior?: string
      ios?: { loggingBehavior?: string }
    }
    expect(cfg.ios?.loggingBehavior ?? cfg.loggingBehavior).toBe('none')
  })
})
