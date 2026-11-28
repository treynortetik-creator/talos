// Settings > Session > Plugins: a line under each enabled plugin that can approve tool calls without asking the phone (a warning, nothing forced off), and
// the form that asks the bridge for ONE card to add a plugin, shown only when the relay lists plugin-add/1.
import type { SessionInventoryT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_WEB_WORDS as W } from '../../src/features/session/pluginWords.ts'
import { PluginsTab } from '../../src/features/session/SessionPanel.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

const inv = (plugins: SessionInventoryT['plugins']): SessionInventoryT =>
  ({
    commands: [],
    models: [],
    efforts: [],
    mcp_servers: [],
    plugins,
    at: '2026-11-26T15:00:00.000Z',
  }) as SessionInventoryT

function mount(inventory: SessionInventoryT | undefined, bridgeFeatures?: string[]) {
  const client = setup({})
  if (bridgeFeatures)
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, features: bridgeFeatures } as typeof s.presence }))
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>
          <PluginsTab inventory={inventory} />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}

describe('the plugin list', () => {
  it('a line under a plugin the bridge marked as able to approve tool calls, in the table’s words, and only under it; every plugin keeps its badge', () => {
    mount(
      inv([
        { name: 'hooky@m', enabled: true, approves_tool_calls: true },
        { name: 'quiet@m', enabled: true },
        { name: 'off@m', enabled: false },
      ]),
    )
    const lines = screen.getAllByTestId('plugin-approves')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.textContent).toBe('Can approve tool calls without asking your phone')
    expect(lines[0]?.textContent).toBe(W.approvesLine)
    expect(lines[0]?.closest('li')?.textContent).toContain('hooky@m')
    expect(screen.getAllByText('Enabled')).toHaveLength(2)
    expect(screen.getByText('Off')).toBeTruthy()
  })

  it('no plugins listed: the old words', () => {
    mount(undefined)
    expect(screen.getByText('No plugins listed.')).toBeTruthy()
  })
})

describe('the add form', () => {
  it('is not there when the BRIDGE does not list plugin-add/1', () => {
    mount(inv([]), ['schedules/1'])
    expect(screen.queryByTestId('add-plugin')).toBeNull()
  })

  it('names that are not plain are refused in words and nothing is sent', async () => {
    mount(inv([]))
    const [a, b] = screen.getAllByRole('textbox') as HTMLInputElement[]
    fireEvent.change(a as HTMLInputElement, { target: { value: 'a;rm -rf' } })
    fireEvent.change(b as HTMLInputElement, { target: { value: 'market' } })
    fireEvent.click(screen.getByTestId('add-plugin-button'))
    expect(screen.getByTestId('add-plugin-said').textContent).toBe(W.badName)
  })

  it('a signed request goes out with the names, and the bridge’s answer is shown under the form', async () => {
    const client = mount(inv([]))
    const sent: Array<Record<string, unknown>> = []
    const real = client.sendOwnerFrame?.bind(client)
    client.sendOwnerFrame = async (f: Record<string, unknown>) => {
      sent.push(f)
      return real?.(f as never)
    }
    const [a, b] = screen.getAllByRole('textbox') as HTMLInputElement[]
    fireEvent.change(a as HTMLInputElement, { target: { value: 'notes' } })
    fireEvent.change(b as HTMLInputElement, { target: { value: 'market' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-plugin-button'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('add-plugin-said').textContent).toContain('Asked the owner to add notes@market'),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'plugin.add.request', plugin: 'notes', marketplace: 'market' })
  })
})
