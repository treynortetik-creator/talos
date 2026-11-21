// Settings, Account, Devices: which row is this session's device, and how "last used" reads. Real components and the real
// /api/devices parser path; only the network is stubbed.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../src/features/auth/session.ts'
import { addedText, DeviceRow, lastUsedText } from '../../src/features/settings/DeviceRow.tsx'
import { AccountSection } from '../../src/features/settings/sections.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useSession.setState({ status: 'authed', me: null, offline: false })
})

const A = 'd_aaaaaaaaaaaaaaaaaaaa'
const B = 'd_bbbbbbbbbbbbbbbbbbbb'
const dev = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  pubkey_jwk: {},
  pinned: true,
  revoked: false,
  created_at: '2026-10-01T00:00:00.000Z',
  last_used_at: null,
  ...extra,
})
const me = (device_id?: string) => ({
  ...(device_id ? { device_id } : {}),
  device_pinned: true,
  has_passkey: true,
  rp_id: 'relay.example.com',
  version: 'test',
  bridge_online: true,
})

function mount(list: unknown[], session: ReturnType<typeof me>, localKeyId: string | null = null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  )
  useSession.setState({ status: 'authed', me: session, offline: false })
  const client = createFakeClient()
  client.store.setState((s) => ({ ...s, deviceId: localKeyId }))
  render(
    <ClientProvider client={client}>
      <StorageProvider storage={createMemoryStorage()}>
        <MemoryRouter>
          <AccountSection readOnly={false} />
        </MemoryRouter>
      </StorageProvider>
    </ClientProvider>,
  )
  return client
}

describe('lastUsedText', () => {
  const now = Date.parse('2026-11-02T12:00:00.000Z')
  it('a missing time reads as not known, never as "never"', () => {
    expect(lastUsedText(null, now)).toBe('Last seen: not known')
    expect(lastUsedText(undefined, now)).toBe('Last seen: not known')
    expect(lastUsedText('', now)).toBe('Last seen: not known')
  })
  it('a time we cannot read degrades to not known instead of printing NaN', () => {
    expect(lastUsedText('not a date', now)).toBe('Last seen: not known')
  })
  it('a real time reads as a time, and "now" reads naturally', () => {
    expect(lastUsedText('2026-11-02T11:57:00.000Z', now)).toBe('Last seen 3 min ago')
    expect(lastUsedText('2026-11-02T12:00:00.000Z', now)).toBe('Last seen just now')
    // a stamp slightly in the future (clock drift) is not shown as a negative age
    expect(lastUsedText('2026-11-02T12:00:30.000Z', now)).toBe('Last seen just now')
  })
})

describe('addedText', () => {
  it('a known created_at reads as a short local date', () => {
    expect(addedText('2026-10-15T12:00:00.000Z')).toBe('Added Oct 15, 2026')
  })
  it('an unreadable or missing created_at shows nothing', () => {
    expect(addedText('garbage')).toBe('')
    expect(addedText(null)).toBe('')
    expect(addedText(undefined)).toBe('')
  })
})

describe('Account: which row is this device', () => {
  it('marks the device the relay attached to this session, by id', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(B))
    const rows = await screen.findAllByTestId('device-row')
    expect(within(rows[0] as HTMLElement).queryByText('This device')).toBeNull()
    expect(within(rows[1] as HTMLElement).getByText('This device')).toBeTruthy()
  })

  it('two devices with the same name: only the session device carries the marker', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Phone')], me(A))
    const rows = await screen.findAllByTestId('device-row')
    expect(within(rows[0] as HTMLElement).getByText('This device')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByText('This device')).toBeNull()
  })

  it('a different key left in this browser does not decide it: the relay session does', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(A), B)
    const rows = await screen.findAllByTestId('device-row')
    expect(within(rows[0] as HTMLElement).getByText('This device')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByText('This device')).toBeNull()
  })

  it('an older relay that names no device marks nothing, and the list still shows', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    expect((await screen.findAllByTestId('device-row')).length).toBe(2)
    expect(screen.queryByText('This device')).toBeNull()
  })
})

describe("Account: Remove on this browser's own row", () => {
  // The relay names no device (an older relay, or a cached `me` from before it did). The browser still knows its own key.
  const own = async (rowName: string) => {
    const rows = await screen.findAllByTestId('device-row')
    const row = rows.find((r) => within(r).queryByText(rowName)) as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: /Remove/ }))
  }
  const revokeCalls = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('/revoke'))

  it('with me.device_id missing it still asks first, and nothing is revoked before the answer', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    await own('Phone')
    expect(await screen.findByText('Remove this device?')).toBeTruthy()
    expect(screen.getByText(/You are on this device right now/)).toBeTruthy()
    expect(revokeCalls().length).toBe(0)
    // and the marker is still the relay's alone: it names nothing
    expect(screen.queryByText('This device')).toBeNull()
  })

  it('confirming signs this browser out here: the revoke is sent, the client stops and the session is cleared', async () => {
    const client = mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    const close = vi.spyOn(client, 'close')
    await own('Phone')
    await userEvent.click(await screen.findByRole('button', { name: 'Remove this device' }))
    await waitFor(() => expect(useSession.getState().status).not.toBe('authed'))
    expect(revokeCalls().length).toBe(1)
    expect(String(revokeCalls()[0]?.[0])).toContain(A)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("another device's row asks first (a revoke can't be undone), then revokes it with no sign-out here", async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    await own('Laptop')
    expect(await screen.findByText('Remove Laptop?')).toBeTruthy()
    expect(revokeCalls().length).toBe(0)
    // the sheet's button names the device it revokes, never "this device"
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove Laptop' }))
    await waitFor(() => expect(revokeCalls().length).toBe(1))
    expect(String(revokeCalls()[0]?.[0])).toContain(B)
    expect(useSession.getState().status).toBe('authed')
  })
})

describe('DeviceRow', () => {
  const row = (d: ReturnType<typeof dev>, isThisDevice = false) =>
    render(<DeviceRow device={d as never} isThisDevice={isThisDevice} onRevoke={() => {}} />)

  it('one unreadable id degrades that row only: the name and the rest still render', () => {
    row(dev('not-an-id', 'Odd phone'))
    expect(screen.getByText('Odd phone')).toBeTruthy()
    expect(screen.getByText(/Last seen: not known/)).toBeTruthy()
  })

  it('a plain line under the name says when it was added and when it was last seen, apart from the four words', () => {
    const now = Date.now()
    row(
      dev(A, 'Alex Example\u2019s iPhone', {
        created_at: '2026-10-15T12:00:00.000Z',
        last_used_at: new Date(now - 3 * 60_000).toISOString(),
      }),
    )
    expect(screen.getByTestId('device-when').textContent).toBe('Added Oct 15, 2026 \u00b7 Last seen 3 min ago')
  })

  it('a null last_used_at says "Last seen: not known"', () => {
    row(dev(A, 'Pixel 8', { created_at: '2026-10-01T12:00:00.000Z' }))
    expect(screen.getByText(/Added Oct 1, 2026 \u00b7 Last seen: not known/)).toBeTruthy()
  })

  it('an unreadable created_at shows no date and never "Invalid"', () => {
    row(dev(A, 'Work Mac', { created_at: 'not a date' }))
    expect(document.body.textContent).not.toMatch(/Invalid|NaN/)
    expect(screen.queryByText(/Added/)).toBeNull()
    expect(screen.getByText(/Last seen: not known/)).toBeTruthy()
  })

  it('the name is never truncated by class: it wraps', () => {
    row(dev(A, 'A very long name '.repeat(6)), true)
    const name = screen.getByText(/A very long name/)
    expect(name.className).toMatch(/break-words/)
    expect(name.className).not.toMatch(/truncate/)
    expect(screen.getByText('This device').className).toMatch(/whitespace-nowrap/)
  })

  it('a removed device offers no Remove and says Removed', () => {
    row(dev(A, 'Gone', { revoked: true }))
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(screen.getByText('Removed')).toBeTruthy()
  })
})

describe('Account: the Your devices block', () => {
  it('is headed "Your devices", has id="devices", and the row button says Remove', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(A))
    expect(screen.getByRole('heading', { name: 'Your devices' })).toBeTruthy()
    await screen.findAllByTestId('device-row')
    expect(document.getElementById('devices')?.contains(screen.getByRole('heading', { name: 'Your devices' }))).toBe(
      true,
    )
    expect(screen.getByRole('button', { name: 'Remove Laptop' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
  })

  describe('#devices', () => {
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    beforeEach(() => {
      scroll.mockReset()
      Element.prototype.scrollIntoView = scroll
    })
    afterEach(() => {
      Element.prototype.scrollIntoView = original
    })
    const open = (hash: string) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify([dev(A, 'Phone')]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      )
      useSession.setState({ status: 'authed', me: me(A), offline: false })
      render(
        <ClientProvider client={createFakeClient()}>
          <StorageProvider storage={createMemoryStorage()}>
            <MemoryRouter initialEntries={[`/settings/account${hash}`]}>
              <AccountSection readOnly={false} />
            </MemoryRouter>
          </StorageProvider>
        </ClientProvider>,
      )
    }
    it('scrolls the block into view once, after the list has loaded', async () => {
      open('#devices')
      await screen.findAllByTestId('device-row')
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
      expect(scroll.mock.contexts[0]).toBe(document.getElementById('devices'))
      expect(scroll.mock.calls[0]?.[0]).toMatchObject({ block: 'start' })
    })
    it('does not scroll without the hash', async () => {
      open('')
      await screen.findAllByTestId('device-row')
      expect(scroll).not.toHaveBeenCalled()
    })
  })
})
