// Audit D32: Settings > Agent used to keep its draft in component state, so leaving the screen (another section, the
// phone's back button, the edge swipe) dropped the edits silently. The draft now lives in draftStore.ts.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSettingsSection } from '../../src/features/agent-config/AgentSettingsSection.tsx'
import { getAgentDraftState, resetAgentDraft } from '../../src/features/agent-config/draftStore.ts'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { SettingsScreen } from '../../src/features/settings/SettingsScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => resetAgentDraft())
afterEach(cleanup)

const nameBox = () => screen.getByLabelText('Agent name') as HTMLInputElement

function renderSettings(client: ReturnType<typeof setup>, route = '/settings') {
  return render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/settings/:section" element={<SettingsScreen />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  )
}

describe('Settings > Agent keeps unsaved edits (D32)', () => {
  it('an edit survives the section being closed and opened again, and says so', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(screen.queryByTestId('agent-unsaved')).toBeNull()
    await userEvent.clear(nameBox())
    await userEvent.type(nameBox(), 'Atlas')
    expect(screen.getByTestId('agent-unsaved').textContent).toMatch(/Unsaved changes/)
    first.unmount() // every way out of the screen unmounts it
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(nameBox().value).toBe('Atlas')
    expect(screen.getByTestId('agent-unsaved')).toBeTruthy()
    expect(client.sent).toHaveLength(0) // nothing was saved on the way out
  })

  it('the phone back button leaves the edit in place and marks the Agent row', async () => {
    const client = setup()
    renderSettings(client, '/settings/agent')
    await userEvent.clear(await screen.findByLabelText('Agent name'))
    await userEvent.type(nameBox(), 'Atlas')
    await userEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
    const row = await screen.findByRole('link', { name: /Agent/ })
    expect(row.textContent).toMatch(/Unsaved changes/)
    await userEvent.click(row)
    expect(((await screen.findByLabelText('Agent name')) as HTMLInputElement).value).toBe('Atlas')
  })

  it('no marker when nothing was changed, or after Discard or Save', async () => {
    const client = setup()
    renderSettings(client)
    expect((await screen.findByRole('link', { name: /Agent/ })).textContent).not.toMatch(/Unsaved/)
    await userEvent.click(screen.getByRole('link', { name: /Agent/ }))
    await userEvent.type(await screen.findByLabelText('Agent name'), 'zzz')
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByTestId('agent-unsaved')).toBeNull()
    await userEvent.type(nameBox(), 'q')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByTestId('agent-unsaved')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
    expect((await screen.findByRole('link', { name: /Agent/ })).textContent).not.toMatch(/Unsaved/)
  })

  it('an edit that is changed back is not unsaved', async () => {
    renderWith(<AgentSettingsSection readOnly={false} />, setup())
    const original = nameBox().value
    await userEvent.type(nameBox(), 'x')
    expect(screen.getByTestId('agent-unsaved')).toBeTruthy()
    await userEvent.type(nameBox(), '{Backspace}')
    expect(nameBox().value).toBe(original)
    expect(screen.queryByTestId('agent-unsaved')).toBeNull()
  })

  it('a config change made elsewhere while he is away does not cost him the edit (audit finding, D32)', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    await userEvent.type(nameBox(), 'X')
    first.unmount()
    // What the Notifications switch, a thread edit or the agent creating a thread does: another field, rev + 1.
    client.store.setState((s) =>
      s.config
        ? {
            ...s,
            config: { ...s.config, rev: s.config.rev + 1, owner: { ...s.config.owner, display_name: 'Elsewhere' } },
          }
        : s,
    )
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(nameBox().value.endsWith('X')).toBe(true) // still his edit
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Elsewhere') // untouched field follows
    expect(screen.getByTestId('agent-unsaved').textContent).not.toMatch(/another device/)
    expect(screen.queryByTestId('agent-conflicts')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    const frame = client.sent.at(-1) as { patch: { agent: { name: string } } }
    expect(Object.keys(frame.patch)).toEqual(['agent']) // only what he changed
    expect(frame.patch.agent.name.endsWith('X')).toBe(true)
    expect(client.store.getState().config?.owner.display_name).toBe('Elsewhere') // and nothing else was overwritten
  })

  it('every remaining field survives leaving: names, default thread and timezone', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    await userEvent.type(nameBox(), 'Z')
    await userEvent.type(screen.getByLabelText('Your name'), 'Q')
    await userEvent.selectOptions(screen.getByLabelText('Default thread'), 'inbox')
    const tz = screen.getByLabelText('Timezone')
    await userEvent.clear(tz)
    await userEvent.type(tz, 'Europe/Paris')
    first.unmount()
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(nameBox().value.endsWith('Z')).toBe(true)
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value.endsWith('Q')).toBe(true)
    expect((screen.getByLabelText('Default thread') as HTMLSelectElement).value).toBe('inbox')
    expect((screen.getByLabelText('Timezone') as HTMLInputElement).value).toBe('Europe/Paris')
    expect(Object.keys(getAgentDraftState().draft ?? {}).sort()).toEqual([
      'agentName',
      'defaultThread',
      'ownerName',
      'timezone',
    ])
    expect(client.sent).toHaveLength(0)
  })

  it('a thread added elsewhere while the draft is open does not touch the draft', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    await userEvent.type(nameBox(), 'Z')
    first.unmount()
    client.store.setState((s) => {
      const c = s.config
      if (!c) return s
      const t = { ...c.threads[0], id: 'made_by_agent', name: 'Agent made', order: c.threads.length }
      return { ...s, config: { ...c, rev: c.rev + 1, threads: [...c.threads, t as (typeof c.threads)[number]] } }
    })
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(nameBox().value.endsWith('Z')).toBe(true)
    expect(screen.queryByTestId('agent-conflicts')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(Object.keys((client.sent.at(-1) as { patch: object }).patch)).toEqual(['agent']) // never a threads array
  })

  it('a field changed on both sides keeps his value and says so', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    await userEvent.clear(nameBox())
    await userEvent.type(nameBox(), 'Mine')
    first.unmount()
    client.store.setState((s) =>
      s.config
        ? { ...s, config: { ...s.config, rev: s.config.rev + 1, agent: { ...s.config.agent, name: 'Theirs' } } }
        : s,
    )
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(nameBox().value).toBe('Mine')
    expect(screen.getByTestId('agent-conflicts').textContent).toMatch(/Agent name/)
  })

  it('an edit typed back to the original does not keep the draft pinned: it follows the config again', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    await userEvent.type(nameBox(), 'x')
    await userEvent.type(nameBox(), '{Backspace}')
    first.unmount()
    client.store.setState((s) =>
      s.config
        ? { ...s, config: { ...s.config, rev: s.config.rev + 1, agent: { ...s.config.agent, name: 'Newer' } } }
        : s,
    )
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    await waitFor(() => expect(nameBox().value).toBe('Newer'))
    expect(screen.queryByTestId('agent-conflicts')).toBeNull()
  })

  it('an untouched draft follows the config when it moved while the screen was closed', async () => {
    const client = setup()
    const first = renderWith(<AgentSettingsSection readOnly={false} />, client)
    first.unmount()
    client.store.setState((s) =>
      s.config
        ? { ...s, config: { ...s.config, rev: s.config.rev + 1, agent: { ...s.config.agent, name: 'Newer' } } }
        : s,
    )
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    await waitFor(() => expect(nameBox().value).toBe('Newer'))
    expect(screen.queryByTestId('agent-unsaved')).toBeNull()
  })

  it('is memory only: signing out empties it, and nothing was ever written to the browser or the stores', async () => {
    const client = setup()
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    await userEvent.type(nameBox(), 'SECRET-EDIT')
    expect(getAgentDraftState().draft?.agentName).toMatch(/SECRET-EDIT/)
    const ls = JSON.stringify({ ...localStorage })
    const ss = JSON.stringify({ ...sessionStorage })
    expect(ls + ss).not.toMatch(/SECRET-EDIT/)
    cleanup() // sign-out leaves the Settings screen
    const storage = createMemoryStorage()
    await clearLocalData(storage) // the one function sign-out, revoke and a 401 all run
    expect(getAgentDraftState().draft).toBeNull()
    expect(getAgentDraftState().baseRev).toBeNull()
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    expect(nameBox().value).not.toMatch(/SECRET-EDIT/)
    expect(screen.queryByTestId('agent-unsaved')).toBeNull()
  })
})
