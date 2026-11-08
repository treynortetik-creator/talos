// The Session panel's sections: Context (with Compact), Usage, Agents in groups, and a link to Settings where the commands,
// MCP servers and plugins live. The same panel inline in Settings keeps those lists.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionPanel } from '../../src/features/session/SessionPanel.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

function mount(inline = false, opts: Parameters<typeof setup>[0] = { agents: 'demo' }) {
  const client = setup(opts)
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>
          <SessionPanel threadId="general" {...(inline ? { inline: true } : {})} />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}

describe('the docked panel and sheet', () => {
  it('has Context, Usage and Agents in that order, and Compact lives in Context', async () => {
    mount()
    const panel = await screen.findByTestId('session-panel')
    const order = [
      ...panel.querySelectorAll(
        '[data-testid="session-context"],[data-testid="session-usage"],[data-testid="session-agents"]',
      ),
    ].map((e) => e.getAttribute('data-testid'))
    expect(order).toEqual(['session-context', 'session-usage', 'session-agents'])
    const context = screen.getByTestId('session-context')
    expect(within(context).getByTestId('meter-context')).toHaveProperty('textContent')
    expect(within(context).getByRole('button', { name: 'Compact' })).toBeTruthy()
    expect(within(screen.getByTestId('session-usage')).getByTestId('meter-week').textContent).toMatch(/60% used/)
    expect(screen.getByTestId('session-usage').textContent).not.toMatch(/5-hour/)
  })

  it('has no Commands, MCP or Plugins tabs, and links to Settings > Session instead', async () => {
    mount()
    await screen.findByTestId('session-panel')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Commands' })).toBeNull()
    const link = screen.getByRole('link', { name: /Settings.*Session/ })
    expect(link.getAttribute('href')).toBe('/settings/session')
  })

  it('groups the agents: this session first, then thread sessions with their state', async () => {
    const client = mount()
    await screen.findByTestId('session-agents')
    expect(within(screen.getByTestId('session-agents')).getByText('This session')).toBeTruthy()
    expect(screen.queryByTestId('session-thread-sessions')).toBeNull() // no workers status yet: no group, no claim
    await act(async () => {
      client.emit('workers.status', {
        status: {
          supported: true,
          supervisor_online: true,
          threads: [
            { thread_id: 'general', state: 'parked' },
            { thread_id: 'inbox', state: 'busy' },
          ],
          governor: { state: 'ok' },
          at: new Date().toISOString(),
        },
      })
    })
    const group = await screen.findByTestId('session-thread-sessions')
    expect(group.textContent).toMatch(/General/)
    expect(group.textContent).toMatch(/Parked/)
    expect(group.textContent).toMatch(/Working/)
    // there is no source for remote builders in the app: no group, nothing made up
    expect(screen.getByTestId('session-agents').textContent).not.toMatch(/builder/i)
  })
})

describe('Agents is always there', () => {
  it.each([
    ['no snapshot at all (old relay or bridge, a mod without agents)', {}],
    ['a mod that is not loaded', { mod: 'absent' as const }],
    ['an empty snapshot', { agents: 'empty' as const }],
  ])('%s: the section is shown and says "No agents running."', async (_name, opts) => {
    mount(false, opts)
    const section = await screen.findByTestId('session-agents')
    expect(within(section).getByText('No agents running.')).toBeTruthy()
  })

  it('"N active" is a polite live region, so a change in the count is announced with what it counts', async () => {
    mount()
    const count = await screen.findByTestId('agents-count')
    expect(count.getAttribute('aria-live')).toBe('polite')
    expect(count.textContent).toMatch(/3 active/)
  })
})

describe('inline in Settings', () => {
  it('keeps the Commands, MCP servers and Plugins tabs and has no link to itself', async () => {
    mount(true)
    await screen.findByTestId('session-panel')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Commands', 'MCP servers', 'Plugins'])
    expect(screen.queryByRole('link', { name: /Settings.*Session/ })).toBeNull()
  })
})
