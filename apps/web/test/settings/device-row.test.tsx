// Settings, Account, Devices: which row is this session's device, and how "last used" reads. Real components and the real
// /api/devices parser path; only the network is stubbed.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../src/features/auth/session.ts'
import { DeviceRow, lastUsedText } from '../../src/features/settings/DeviceRow.tsx'
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
  it('a missing time reads as unknown, never as "never used"', () => {
    expect(lastUsedText(null, now)).toBe('last used unknown')
    expect(lastUsedText(undefined, now)).toBe('last used unknown')
    expect(lastUsedText('', now)).toBe('last used unknown')
  })
  it('a time we cannot read degrades to unknown instead of printing NaN', () => {
    expect(lastUsedText('not a date', now)).toBe('last used unknown')
  })
  it('a real time reads as a time, and "now" reads naturally', () => {
    expect(lastUsedText('2026-11-02T11:57:00.000Z', now)).toBe('used 3 min ago')
    expect(lastUsedText('2026-11-02T12:00:00.000Z', now)).toBe('used just now')
    // a stamp slightly in the future (clock drift) is not shown as a negative age
    expect(lastUsedText('2026-11-02T12:00:30.000Z', now)).toBe('used just now')
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

describe("Account: Revoke on this browser's own row", () => {
  // The relay names no device (an older relay, or a cached `me` from before it did). The browser still knows its own key.
  const own = async (rowName: string) => {
    const rows = await screen.findAllByTestId('device-row')
    const row = rows.find((r) => within(r).queryByText(rowName)) as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: /Revoke/ }))
  }
  const revokeCalls = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('/revoke'))

  it('with me.device_id missing it still asks first, and nothing is revoked before the answer', async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    await own('Phone')
    expect(await screen.findByText('Revoke this device?')).toBeTruthy()
    expect(screen.getByText(/You are on this device right now/)).toBeTruthy()
    expect(revokeCalls().length).toBe(0)
    // and the marker is still the relay's alone: it names nothing
    expect(screen.queryByText('This device')).toBeNull()
  })

  it('confirming signs this browser out here: the revoke is sent, the client stops and the session is cleared', async () => {
    const client = mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    const close = vi.spyOn(client, 'close')
    await own('Phone')
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke this device' }))
    await waitFor(() => expect(useSession.getState().status).not.toBe('authed'))
    expect(revokeCalls().length).toBe(1)
    expect(String(revokeCalls()[0]?.[0])).toContain(A)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("another device's row is revoked straight away, with no sign-out", async () => {
    mount([dev(A, 'Phone'), dev(B, 'Laptop')], me(undefined), A)
    await own('Laptop')
    await waitFor(() => expect(revokeCalls().length).toBe(1))
    expect(screen.queryByText('Revoke this device?')).toBeNull()
    expect(useSession.getState().status).toBe('authed')
  })
})

describe('DeviceRow', () => {
  const row = (d: ReturnType<typeof dev>, isThisDevice = false) =>
    render(<DeviceRow device={d as never} isThisDevice={isThisDevice} onRevoke={() => {}} />)

  it('one unreadable id degrades that row only: the name and the rest still render', () => {
    row(dev('not-an-id', 'Odd phone'))
    expect(screen.getByText('Odd phone')).toBeTruthy()
    expect(screen.getByText(/last used unknown/)).toBeTruthy()
  })

  it('the name is never truncated by class: it wraps', () => {
    row(dev(A, 'A very long name '.repeat(6)), true)
    const name = screen.getByText(/A very long name/)
    expect(name.className).toMatch(/break-words/)
    expect(name.className).not.toMatch(/truncate/)
    expect(screen.getByText('This device').className).toMatch(/whitespace-nowrap/)
  })

  it('a revoked device offers no Revoke and says Revoked', () => {
    row(dev(A, 'Gone', { revoked: true }))
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
    expect(screen.getByText('Revoked')).toBeTruthy()
  })
})
