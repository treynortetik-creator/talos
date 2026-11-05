import { AgentConfig, checkConfigPatch, verifyOwnerFrame } from '@talos-app/protocol'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentSettingsSection } from '../../src/features/agent-config/AgentSettingsSection.tsx'
import { resetAgentDraft } from '../../src/features/agent-config/draftStore.ts'
import {
  buildAgentPatch,
  draftFromConfig,
  newThread,
  slugThreadId,
  validateDraft,
} from '../../src/features/agent-config/patch.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

// The draft lives in a module store (D32), so each test starts from none.
beforeEach(() => resetAgentDraft())

const cfg = () => {
  const c = setup().store.getState().config
  if (!c) throw new Error('fake client has no config')
  return c
}

describe('buildAgentPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildAgentPatch(cfg(), draftFromConfig(cfg()))).toEqual({})
  })

  it('touches only the changed, allowlisted fields', () => {
    const c = cfg()
    const d = { ...draftFromConfig(c), agentName: 'Atlas', timezone: 'Europe/Paris' }
    const patch = buildAgentPatch(c, d)
    expect(patch).toEqual({ agent: { name: 'Atlas' }, timezone: 'Europe/Paris' })
    expect(checkConfigPatch(patch)).toEqual({ ok: true, touchesWorkEnabled: false })
  })

  it('never emits threads, quiet hours, voice-note replies or the work thread: they have their own homes', () => {
    const c = cfg()
    const d = draftFromConfig(c)
    expect(Object.keys(d).sort()).toEqual(['agentName', 'defaultThread', 'ownerName', 'timezone'])
    const patch = buildAgentPatch(c, { ...d, agentName: 'Atlas', ownerName: 'Zed', defaultThread: 'inbox' })
    expect(JSON.stringify(patch)).not.toMatch(/threads"|quiet_window|voice_notes|"work"|enabled|label|ask_note/)
  })

  it('validates names and timezone', () => {
    const d = draftFromConfig(cfg())
    expect(validateDraft({ ...d, agentName: '' }).agentName).toBeTruthy()
    expect(validateDraft({ ...d, agentName: 'x'.repeat(33) }).agentName).toBeTruthy()
    expect(validateDraft({ ...d, ownerName: ' ' }).ownerName).toBeTruthy()
    expect(validateDraft({ ...d, timezone: 'Mars/Olympus' }).timezone).toBeTruthy()
    expect(validateDraft(d)).toEqual({})
  })

  it('makes valid, unique thread ids from names', () => {
    const taken = new Set(['general', 'inbox', 'research'])
    expect(slugThreadId('Research', taken)).toBe('research_2')
    expect(slugThreadId('My Projects!', taken)).toBe('my_projects')
    expect(slugThreadId('2024 plans', taken)).toMatch(/^t_2024_plans$/)
    expect(slugThreadId('✨', taken)).toBe('thread')
    expect(slugThreadId('all', new Set(['x']))).toBe('all_2')
    expect(slugThreadId('Constructor', new Set())).toBe('constructor_thread')
    expect(slugThreadId('constructor', new Set(['constructor_thread']))).toBe('constructor_thread_2')
    expect(newThread('Constructor', [], '2026-10-28T00:00:00.000Z').id).toBe('constructor_thread')
    const t = newThread('Home Lab', [], '2026-10-28T00:00:00.000Z')
    expect(AgentConfig.shape.threads.element.safeParse(t).success).toBe(true)
  })
})

describe('AgentSettingsSection', () => {
  it('an edit produces a signed merge patch with the current base_rev', async () => {
    const client = setup()
    const rev = cfg().rev
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    const name = screen.getByLabelText('Agent name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Atlas')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(client.store.getState().config?.agent.name).toBe('Atlas'))
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.type).toBe('config.patch')
    expect(frame.base_rev).toBe(rev)
    expect(frame.patch).toEqual({ agent: { name: 'Atlas' } })
    expect(checkConfigPatch(frame.patch).ok).toBe(true)
    expect(await verifyOwnerFrame(frame, await client.publicJwk())).toBe(true)
    expect(await screen.findByText('Saved.')).toBeTruthy()
  })

  it('when the Mac answers config_conflict the edits are kept, not thrown away', async () => {
    const client = setup()
    client.failNextPatchWith('config_conflict')
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    const name = screen.getByLabelText('Agent name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Atlas')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed on another device/)
    expect((screen.getByLabelText('Agent name') as HTMLInputElement).value).toBe('Atlas')
    expect(screen.getByTestId('agent-unsaved')).toBeTruthy()
    expect(client.sent).toHaveLength(0)
  })

  it('a config that moved under an open draft is merged: Save sends only the edit, on the new rev', async () => {
    const client = setup()
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    const name = screen.getByLabelText('Agent name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Atlas')
    client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, rev: s.config.rev + 1 } } : s))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.patch).toEqual({ agent: { name: 'Atlas' } })
    expect(frame.base_rev).toBe(cfg().rev + 1)
  })

  it('is read-only with a banner when the Mac is offline', () => {
    renderWith(<AgentSettingsSection readOnly />, setup({ macOffline: true }))
    expect(screen.getByRole('status').textContent).toMatch(/Mac is offline/)
    for (const el of screen.getAllByRole('textbox')) expect((el as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has no thread list any more: a link to Manage threads instead, and none of the moved controls', () => {
    renderWith(<AgentSettingsSection readOnly={false} />, setup())
    expect(document.querySelector('[data-thread-row]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add thread' })).toBeNull()
    expect(screen.queryByLabelText('New thread name')).toBeNull()
    const link = screen.getByTestId('manage-threads-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/threads?manage=1')
    for (const gone of [/Quiet window/, /Voice-note replies/, /Live-call context/])
      expect(screen.queryByText(gone), String(gone)).toBeNull()
    expect(screen.queryByLabelText(/Work systems thread/)).toBeNull() // moved to Settings, Integrations
  })

  it('rejects a bad timezone before sending', async () => {
    const client = setup()
    renderWith(<AgentSettingsSection readOnly={false} />, client)
    const tz = screen.getByLabelText('Timezone')
    await userEvent.clear(tz)
    await userEvent.type(tz, 'Mars/Olympus')
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toMatch(/Pick a timezone/)
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Discard restores the saved values', async () => {
    renderWith(<AgentSettingsSection readOnly={false} />, setup())
    const name = screen.getByLabelText('Agent name') as HTMLInputElement
    await userEvent.type(name, 'zzz')
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(name.value).toBe(cfg().agent.name)
  })

  it('does not offer fields the app cannot change (chat id, work label)', () => {
    renderWith(<AgentSettingsSection readOnly={false} />, setup())
    expect(screen.queryByLabelText(/chat id/i)).toBeNull()
    expect(screen.queryByLabelText(/label/i)).toBeNull()
  })
})
