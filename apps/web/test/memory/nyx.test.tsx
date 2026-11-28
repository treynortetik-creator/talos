// The Nyx screen (/memory): the empty, connect and connected states, the https-only address check (no http, no javascript:, no
// spaces), the open-Nyx links, and the "Add Nyx to agents" list, which is a stub with every box off. Real components on the fake
// client, which refuses what the Mac refuses.
import type { AgentConfigT, ThreadT } from '@talos-app/protocol'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryScreen } from '../../src/features/memory/index.tsx'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const opened = vi.fn<(url: string) => boolean>()
beforeEach(() => {
  opened.mockReset()
  opened.mockReturnValue(true)
  setPlatform({ ...webPlatform, openExternal: opened })
})
afterEach(() => {
  cleanup()
  setPlatform(webPlatform)
})

const patches = (c: FakeClient) =>
  c.sent.filter((f) => f.type === 'config.patch') as unknown as Array<{ patch: Record<string, unknown> }>
const saved = (c: FakeClient) => (c.store.getState().config as AgentConfigT).memory?.nyx_url
const thread = (id: string, name: string, extra: Partial<ThreadT> = {}): ThreadT => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

/** A client that has already connected Nyx, as the Mac would sync it. */
function connected(url = 'https://nyx.example.com/'): FakeClient {
  const c = setup()
  c.store.setState((s) => (s.config ? { config: { ...s.config, memory: { nyx_url: url } } } : s))
  return c
}
const mount = (c: FakeClient) => renderWith(<MemoryScreen />, c, '/memory')

describe('empty state', () => {
  it('says what Nyx is for and asks for one address', () => {
    mount(setup())
    expect(screen.getByRole('heading', { level: 1, name: 'Nyx' })).toBeTruthy()
    expect(screen.getByText("Your team's memory lives in Nyx. Connect it here.")).toBeTruthy()
    expect(screen.getByLabelText('Nyx address')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.queryByText(/Connected to/)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Add Nyx to agents' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open Nyx' })).toBeNull()
  })

  it('has no address of its own: nothing is pre-filled', () => {
    mount(setup())
    expect((screen.getByLabelText('Nyx address') as HTMLInputElement).value).toBe('')
  })
})

describe('connecting', () => {
  it('saves the address as memory.nyx_url, opens Nyx sign-in once, and shows the connected state', async () => {
    const c = setup()
    mount(c)
    await userEvent.type(screen.getByLabelText('Nyx address'), '  https://nyx.example.com  ')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Connected to nyx.example.com')).toBeTruthy()
    expect(patches(c).at(-1)?.patch).toEqual({ memory: { nyx_url: 'https://nyx.example.com/' } })
    expect(saved(c)).toBe('https://nyx.example.com/')
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith('https://nyx.example.com/sign-in')
    const note = screen.getByTestId('nyx-after')
    expect(note.textContent).toContain('Saved.')
    expect(note.textContent).not.toMatch(/opened/)
    expect(within(note).getByRole('link', { name: 'Sign in to Nyx' }).getAttribute('href')).toBe(
      'https://nyx.example.com/sign-in',
    )
  })

  it('keeps a path on the address: sign-in goes after it', async () => {
    const c = setup()
    mount(c)
    await userEvent.type(screen.getByLabelText('Nyx address'), 'https://example.com/nyx/')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByText('Connected to example.com')
    expect(opened).toHaveBeenCalledWith('https://example.com/nyx/sign-in')
  })

  it('Enter in the field connects too', async () => {
    const c = setup()
    mount(c)
    await userEvent.type(screen.getByLabelText('Nyx address'), 'https://nyx.example.com{Enter}')
    await screen.findByText('Connected to nyx.example.com')
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('a blocked new tab still leaves the sign-in link, and never claims it opened (the real web openExternal)', async () => {
    setPlatform(webPlatform)
    const blocked = vi.spyOn(window, 'open').mockReturnValue(null)
    mount(setup())
    await userEvent.type(screen.getByLabelText('Nyx address'), 'https://nyx.example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const note = await screen.findByTestId('nyx-after')
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(note.textContent).not.toMatch(/opened/)
    expect(within(note).getByRole('link', { name: 'Sign in to Nyx' }).getAttribute('href')).toBe(
      'https://nyx.example.com/sign-in',
    )
    blocked.mockRestore()
  })

  it('when the Mac refuses, the owner is told, nothing opens, and it is still the empty state', async () => {
    const c = setup()
    c.failNextPatchWith('config_conflict')
    mount(c)
    await userEvent.type(screen.getByLabelText('Nyx address'), 'https://nyx.example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed these settings at the same time/)
    expect(opened).not.toHaveBeenCalled()
    expect(saved(c)).toBeUndefined()
    expect(screen.queryByText(/Connected to/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('with the Mac offline, says so, the button is off, and nothing is saved or opened', async () => {
    const c = setup({ macOffline: true })
    mount(c)
    await userEvent.type(screen.getByLabelText('Nyx address'), 'https://nyx.example.com')
    expect(screen.getByTestId('nyx-blocked').textContent).toBe("Your Mac is offline, so Nyx can't be connected now.")
    const button = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('Nyx address'), '{Enter}')
    expect(patches(c)).toHaveLength(0)
    expect(opened).not.toHaveBeenCalled()
    expect(saved(c)).toBeUndefined()
  })
})

describe('the address check (https only, in the web)', () => {
  it.each([
    ['http', 'http://nyx.example.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hi'],
    ['a space inside', 'https://nyx.example.com/a b'],
    ['no scheme', 'nyx.example.com'],
    ['sign-in details', `https://user:pw${'@'}nyx.example.com`],
    ['empty', ''],
    ['only spaces', '   '],
  ])('refuses %s: a message, no save, no new tab', async (_why, value) => {
    const c = setup()
    mount(c)
    const field = screen.getByLabelText('Nyx address')
    if (value) await userEvent.type(field, value)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Use a full https address, like https://nyx.example.com')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(patches(c)).toHaveLength(0)
    expect(opened).not.toHaveBeenCalled()
  })

  it('a good address clears the message', async () => {
    mount(setup())
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('alert')
    await userEvent.type(screen.getByLabelText('Nyx address'), 'https://nyx.example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByText('Connected to nyx.example.com')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('connected state', () => {
  it('shows the host, an Open Nyx link to the saved address, and Change address', () => {
    mount(connected())
    expect(screen.getByText('Connected to nyx.example.com')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open Nyx' })
    expect(link.getAttribute('href')).toBe('https://nyx.example.com/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('button', { name: 'Change address' })).toBeTruthy()
    expect(screen.queryByLabelText('Nyx address')).toBeNull()
    expect(screen.queryByText("Your team's memory lives in Nyx. Connect it here.")).toBeNull()
  })

  it('Open Nyx goes out through the platform, and still works as a plain link when that is refused', async () => {
    mount(connected())
    await userEvent.click(screen.getByRole('link', { name: 'Open Nyx' }))
    expect(opened).toHaveBeenCalledWith('https://nyx.example.com/')
  })

  it('shows the port in the host', () => {
    mount(connected('https://nyx.example.com:8443/'))
    expect(screen.getByText('Connected to nyx.example.com:8443')).toBeTruthy()
  })

  it('a stored address that is not https reads as not connected (no link is ever made from it)', () => {
    mount(connected('http://nyx.example.com'))
    expect(screen.queryByText(/Connected to/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open Nyx' })).toBeNull()
    expect(screen.getByLabelText('Nyx address')).toBeTruthy()
  })

  it('Change address opens the form with the saved address; Cancel leaves it as it was', async () => {
    const c = connected()
    mount(c)
    await userEvent.click(screen.getByRole('button', { name: 'Change address' }))
    expect((screen.getByLabelText('Nyx address') as HTMLInputElement).value).toBe('https://nyx.example.com/')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Connected to nyx.example.com')).toBeTruthy()
    expect(patches(c)).toHaveLength(0)
  })

  it('a new address replaces the old one and opens its sign-in', async () => {
    const c = connected()
    mount(c)
    await userEvent.click(screen.getByRole('button', { name: 'Change address' }))
    const field = screen.getByLabelText('Nyx address')
    await userEvent.clear(field)
    await userEvent.type(field, 'https://memory.example.org')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByText('Connected to memory.example.org')
    expect(saved(c)).toBe('https://memory.example.org/')
    expect(opened).toHaveBeenCalledWith('https://memory.example.org/sign-in')
  })

  it('a refused change keeps the old address', async () => {
    const c = connected()
    mount(c)
    await userEvent.click(screen.getByRole('button', { name: 'Change address' }))
    const field = screen.getByLabelText('Nyx address')
    await userEvent.clear(field)
    await userEvent.type(field, 'http://memory.example.org')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('alert')
    expect(saved(c)).toBe('https://nyx.example.com/')
    expect(patches(c)).toHaveLength(0)
  })
})

describe('Add Nyx to agents (a stub)', () => {
  it('has a row for Main and for each live thread agent, and none for archived or the inbox', () => {
    const c = connected()
    c.store.setState((s) => ({
      threads: [
        ...s.threads,
        thread('trip', 'Trip'),
        thread('old', 'Old one', { archived: true }),
        thread('inbox2', 'Mail', { kind: 'system' }),
      ],
    }))
    mount(c)
    const list = screen.getByTestId('nyx-agents')
    expect(within(list).getByRole('heading', { name: 'Add Nyx to agents' })).toBeTruthy()
    const names = within(list)
      .getAllByRole('checkbox')
      .map((b) => b.closest('label')?.textContent)
    expect(names).toContain('Main agent')
    expect(names).toContain('Trip')
    expect(names).not.toContain('Old one')
    expect(names).not.toContain('Mail')
    const def = c.store.getState().config?.default_thread
    expect(names).not.toContain(c.store.getState().threads.find((t) => t.id === def)?.name)
  })

  it('every box is off and disabled, a click changes nothing, and the line says it is coming', async () => {
    const c = connected()
    c.store.setState((s) => ({ threads: [...s.threads, thread('trip', 'Trip')] }))
    mount(c)
    const boxes = within(screen.getByTestId('nyx-agents')).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    for (const b of boxes) {
      expect(b.disabled).toBe(true)
      expect(b.checked).toBe(false)
      expect(b.getAttribute('aria-describedby')).toBe(screen.getByTestId('nyx-agents-soon').id)
      await userEvent.click(b)
      expect(b.checked).toBe(false)
    }
    expect(screen.getByText("Coming soon: this adds Nyx to each agent's own Claude setup.")).toBeTruthy()
    expect(patches(c)).toHaveLength(0)
    await waitFor(() => expect(opened).not.toHaveBeenCalled())
  })

  it('is not shown before Nyx is connected', () => {
    mount(setup())
    expect(screen.queryByTestId('nyx-agents')).toBeNull()
  })
})
