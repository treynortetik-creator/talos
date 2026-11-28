// "Why was that push plain?", the web half: one short line under the iPhone notifications row that names the cause of the
// last plain push (or says the last one showed its text). The relay's answer comes with GET /api/push/apns; the phone may add
// its own reason through the TalosPush plugin, and a plugin without the call is simply not asked.
import { PLAIN_PUSH_REASONS } from '@talos-app/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativePushRow } from '../../src/features/pwa/NativePushRow.tsx'
import { resetNativePushForTests, useNativePush } from '../../src/features/pwa/nativePush.ts'
import { lastPushLine } from '../../src/features/pwa/plainPushWords.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createHttp } from '../../src/lib/http.ts'
import { parsePhonePlain } from '../../src/lib/nativePush.ts'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const AT = '2026-11-27T10:00:00.000Z'
const AT_MS = Date.parse(AT)

beforeEach(() => {
  resetNativePushForTests()
  useNativePush.setState({ view: { kind: 'checking' }, busy: false, note: null, rich: null, pendingRevoke: false })
})
afterEach(cleanup)

describe('the words', () => {
  it('a rich push says it showed its text', () => {
    expect(lastPushLine({ rich: true, at: AT }, null)).toBe('Last push showed its text.')
  })

  it('no push yet says nothing', () => {
    expect(lastPushLine(null, null)).toBeNull()
    expect(lastPushLine(undefined, null)).toBeNull()
  })

  it('every reason has its own short plain sentence that starts the same way', () => {
    const seen = new Set<string>()
    for (const reason of PLAIN_PUSH_REASONS) {
      const line = lastPushLine({ rich: false, reason, at: AT }, null)
      expect(line, reason).toMatch(/^Last push was plain: .+\.$/)
      expect(line?.length ?? 0, reason).toBeLessThan(110)
      seen.add(line ?? '')
    }
    expect(seen.size).toBe(PLAIN_PUSH_REASONS.length)
  })

  it('the relay and text-setting lines read as the owner asked', () => {
    expect(lastPushLine({ rich: false, reason: 'seal_failed', at: AT }, null)).toBe(
      'Last push was plain: your relay could not prepare the message text.',
    )
    expect(lastPushLine({ rich: false, reason: 'grant_bad', at: AT }, null)).toBe(
      "Last push was plain: your relay's key for this phone is not usable. Turn text off and on again.",
    )
    expect(lastPushLine({ rich: false, reason: 'grant_changed', at: AT }, null)).toBe(
      'Last push was plain: the text setting changed while it was sending.',
    )
  })

  it('too long reads as the brief says', () => {
    expect(lastPushLine({ rich: false, reason: 'too_big', at: AT }, null)).toBe(
      'Last push was plain: the message was too long to send with its text.',
    )
  })

  it('a plain push with an unknown reason still says plain, without guessing a cause', () => {
    expect(lastPushLine({ rich: false, reason: 'from_the_future', at: AT } as never, null)).toBe('Last push was plain.')
    expect(lastPushLine({ rich: false, at: AT }, null)).toBe('Last push was plain.')
  })

  const ID = 'a'.repeat(22)
  const OTHER = 'b'.repeat(22)

  it('the phone reason replaces "showed its text" only for the seal it names', () => {
    const rich = { rich: true, id: ID, at: AT }
    expect(lastPushLine(rich, { reason: 'phone_open_failed', id: ID, at: AT_MS + 5 })).toBe(
      "Last push was plain: this phone couldn't open the message.",
    )
    // another push's seal, even a later one: not this push
    expect(lastPushLine(rich, { reason: 'phone_open_failed', id: OTHER, at: AT_MS + 60_000 })).toBe(
      'Last push showed its text.',
    )
  })

  it('a push the relay sent plain keeps the relay reason, whatever the phone says', () => {
    expect(
      lastPushLine({ rich: false, reason: 'no_grant', at: AT }, { reason: 'phone_no_key', id: ID, at: AT_MS + 5 }),
    ).toMatch(/text is off/i)
  })

  it('with no relay row at all, a phone reason still gets its line', () => {
    expect(lastPushLine(null, { reason: 'phone_timed_out', id: ID, at: AT_MS })).toBe(
      'Last push was plain: this phone took too long to open the message.',
    )
    expect(lastPushLine(undefined, { reason: 'phone_no_key', id: ID, at: AT_MS })).toMatch(/no key/)
  })

  it('a phone reason that is not one of the three is ignored', () => {
    expect(lastPushLine({ rich: true, id: ID, at: AT }, { reason: 'banana' as never, id: ID, at: AT_MS })).toBe(
      'Last push showed its text.',
    )
  })

  it('what the plugin hands back is checked: a known reason, a seal id, and a time in ms (seconds are converted)', () => {
    const ok = { reason: 'phone_open_failed', id: ID, at: AT_MS }
    expect(parsePhonePlain(ok)).toEqual(ok)
    expect(parsePhonePlain({ ...ok, at: AT_MS / 1000 })).toEqual({ ...ok, at: Math.floor(AT_MS / 1000) * 1000 })
    expect(parsePhonePlain({ ...ok, at: new Date(AT_MS).toISOString() })).toEqual(ok)
    expect(parsePhonePlain({ ...ok, id: 'short' })).toBeNull()
    expect(parsePhonePlain({ reason: 'phone_open_failed', at: AT_MS })).toBeNull()
    expect(parsePhonePlain({ ...ok, reason: 'no_grant' })).toBeNull()
    expect(parsePhonePlain({ ...ok, at: 'soon' })).toBeNull()
    expect(parsePhonePlain('junk')).toBeNull()
  })
})

function shell(plugin: Record<string, unknown> = {}) {
  return {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        TalosPush: {
          getStatus: async () => ({ permission: 'granted' }),
          addListener: async () => ({ remove: () => {} }),
          ...plugin,
        },
      },
    },
  }
}

function relay(last: unknown) {
  return createHttp((async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/push/apns')
      return Response.json({ configured: true, registered: true, ...(last ? { last } : {}) })
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch)
}

async function row(http: ReturnType<typeof relay>, scope: unknown) {
  const client = createFakeClient() as unknown as TalosClient
  render(
    <ClientProvider client={client}>
      <NativePushRow http={http} scope={scope} />
    </ClientProvider>,
  )
  await screen.findByText('On')
}

describe('the line under the iPhone notifications row', () => {
  it('names the cause of the last plain push', async () => {
    await row(relay({ rich: false, reason: 'too_big', at: AT }), shell())
    expect((await screen.findByTestId('native-push-last')).textContent).toBe(
      'Last push was plain: the message was too long to send with its text.',
    )
  })

  it('says the last push showed its text', async () => {
    await row(relay({ rich: true, at: AT }), shell())
    expect((await screen.findByTestId('native-push-last')).textContent).toBe('Last push showed its text.')
  })

  it('shows no line before the first push', async () => {
    await row(relay(null), shell())
    expect(screen.queryByTestId('native-push-last')).toBeNull()
  })

  it('reads the phone-reported reason through the plugin when the relay sent it with text', async () => {
    const lastPlainReason = vi.fn(async () => ({ reason: 'phone_timed_out', id: 'a'.repeat(22), at: AT_MS + 1000 }))
    await row(relay({ rich: true, id: 'a'.repeat(22), at: AT }), shell({ lastPlainReason }))
    expect((await screen.findByTestId('native-push-last')).textContent).toBe(
      'Last push was plain: this phone took too long to open the message.',
    )
    expect(lastPlainReason).toHaveBeenCalled()
  })

  it('a plugin without the call, or one that throws or answers nonsense, changes nothing', async () => {
    await row(relay({ rich: true, at: AT }), shell({ lastPlainReason: async () => Promise.reject(new Error('x')) }))
    expect((await screen.findByTestId('native-push-last')).textContent).toBe('Last push showed its text.')
    cleanup()
    await row(relay({ rich: true, at: AT }), shell({ lastPlainReason: async () => 'junk' }))
    expect((await screen.findByTestId('native-push-last')).textContent).toBe('Last push showed its text.')
  })
})
