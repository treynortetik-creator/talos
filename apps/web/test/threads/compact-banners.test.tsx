// The thread's state banners take one compact line: the first notice's cause, its Retry or Health action, and a More button
// that opens every notice in full. Nothing a banner said or did is lost, only folded. Driven through the real Banners.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { statusOf } from '../health/status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubStatus(body: unknown | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      body === null ? new Response('nope', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 }),
    ),
  )
}

type State = Partial<ReturnType<ReturnType<typeof createFakeClient>['store']['getState']>>
function mount(state: State, meta = createMetaStore()) {
  const client = createFakeClient()
  client.store.setState(state as never)
  const reconnect = vi.spyOn(client, 'reconnect')
  render(
    <MemoryRouter>
      <MetaProvider store={meta}>
        <ClientProvider client={client}>
          <Banners />
        </ClientProvider>
      </MetaProvider>
    </MemoryRouter>,
  )
  return { client, reconnect }
}
const macDropped = (client = createFakeClient()) => ({
  connection: 'online' as const,
  presence: {
    ...client.store.getState().presence,
    bridge_online: false,
    last_seen: new Date(Date.now() - 30_000).toISOString(),
  },
})
const statuses = () => screen.queryAllByRole('status')
const CAUSE = /Your Mac is offline \(last seen/
const NEXT = /comes back on its own/
const PIN_CAUSE = 'Waiting for your Mac to confirm this device.'
const PIN_NEXT = /talos-app enroll/

describe('the compact banner line', () => {
  it('shows nothing when no banner has anything to say', async () => {
    stubStatus(null)
    const client = createFakeClient()
    const { container } = render(
      <MemoryRouter>
        <ClientProvider client={client}>
          <Banners />
        </ClientProvider>
      </MemoryRouter>,
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(statuses()).toHaveLength(0)
    expect(container.textContent).toBe('')
  })

  it('one notice: its cause on one truncated line, the next step folded behind More', () => {
    stubStatus(null)
    mount(macDropped())
    expect(statuses()).toHaveLength(1)
    const row = screen.getByTestId('mac-banner')
    expect(row.getAttribute('role')).toBe('status')
    expect(row.getAttribute('data-kind')).toBe('dropped')
    expect(within(row).getByText(CAUSE).className).toMatch(/\btruncate\b/)
    expect(screen.queryByText(NEXT)).toBeNull()
    const more = screen.getByRole('button', { name: 'More' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.getAttribute('aria-controls')).toBeTruthy()
    // no tall mascot in the line
    expect(row.querySelector('img,svg')?.getAttribute('width') ?? '18').toMatch(/^1[6-8]$/)
  })

  it('More opens the full text, Less folds it, focus stays on the toggle, and each test id is in the page once', async () => {
    stubStatus(null)
    mount(macDropped())
    const user = userEvent.setup()
    const more = screen.getByRole('button', { name: 'More' })
    await user.click(more)
    expect(screen.getByText(CAUSE)).toBeTruthy()
    expect(screen.getByText(NEXT)).toBeTruthy()
    expect(screen.getAllByTestId('mac-banner')).toHaveLength(1)
    expect(screen.getByTestId('mac-banner').getAttribute('data-kind')).toBe('dropped')
    const less = screen.getByRole('button', { name: 'Less' })
    expect(less.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(less.getAttribute('aria-controls') ?? '')?.textContent).toMatch(NEXT)
    expect(document.activeElement).toBe(less)
    await user.click(less)
    expect(screen.queryByText(NEXT)).toBeNull()
    expect(screen.getAllByTestId('mac-banner')).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }))
  })

  it('Enter and Space on the toggle open and close it', async () => {
    stubStatus(null)
    mount(macDropped())
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }))
    await user.keyboard('{Enter}')
    expect(screen.getByText(NEXT)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Less' }))
    await user.keyboard(' ')
    expect(screen.queryByText(NEXT)).toBeNull()
  })

  it('two notices: still one line, More (2), and both open in full with their own test ids', async () => {
    stubStatus(null)
    const c = createFakeClient()
    mount({ ...macDropped(c), deviceId: 'd_test', devicePinned: false })
    // device not confirmed comes first, the Mac second
    expect(statuses()).toHaveLength(1)
    expect(screen.getByText(PIN_CAUSE)).toBeTruthy()
    expect(screen.queryByText(CAUSE)).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More (2)' }))
    expect(screen.getByText(PIN_CAUSE)).toBeTruthy()
    expect(screen.getByText(PIN_NEXT)).toBeTruthy()
    expect(screen.getByText(CAUSE)).toBeTruthy()
    expect(screen.getByText(NEXT)).toBeTruthy()
    expect(screen.getAllByTestId('mac-banner')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Less' }))
    expect(screen.queryByText(CAUSE)).toBeNull()
    expect(screen.getByRole('button', { name: 'More (2)' })).toBeTruthy()
  })

  it('the offline notice keeps Retry on the line, one tap, and has nothing to fold', async () => {
    stubStatus(null)
    const { reconnect } = mount({ connection: 'offline' })
    expect(screen.getByText("You're offline. Messages will send when you're back.")).toBeTruthy()
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('relay unreachable: Retry now stays on the line, the countdown is behind More', async () => {
    stubStatus(null)
    const meta = createMetaStore()
    meta.setState({ retryAt: Date.now() + 9_000 })
    const { client, reconnect } = mount({ connection: 'unreachable' }, meta)
    expect(screen.getByText(/Can't reach your server/)).toBeTruthy()
    expect(screen.queryByText(/Retrying in/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(reconnect).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByText(/Retrying in \d+ s/)).toBeTruthy()
    expect(client).toBeTruthy()
  })

  it('the health notice keeps its Health link on the line, and the Mac notice steps aside for it', async () => {
    const long = new Date(Date.now() - 3600_000).toISOString()
    stubStatus(
      statusOf({
        at: new Date().toISOString(),
        mac_problems: ['bridge_offline'],
        bridge: { online: false, last_seen: long, down_since: long },
      }),
    )
    const c = createFakeClient()
    mount({
      connection: 'online',
      presence: { ...c.store.getState().presence, bridge_online: false, last_seen: long },
    })
    await waitFor(() => expect(screen.getByTestId('health-banner').getAttribute('data-kind')).toBe('bridge_offline'))
    expect(screen.getByRole('link', { name: 'Health' }).getAttribute('href')).toBe('/settings/health')
    expect(screen.queryByTestId('mac-banner')).toBeNull()
    expect(statuses()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getAllByTestId('health-banner')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Health' })).toBeTruthy()
  })
})
