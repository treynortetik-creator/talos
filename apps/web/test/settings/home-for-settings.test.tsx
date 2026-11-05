// SETTINGS-MAP 3.1 / 3.2: every moved setting has one home, saves at once through a signed config.patch, is read-only with the
// Mac offline, and goes back to the saved value when the Mac refuses (audit U11). Real components, the fake client (which
// refuses what the Mac refuses: allowlist, schema, thread-session rules).
import {
  AgentConfig,
  type AgentConfigT,
  checkConfigPatch,
  type HealthStatusT,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentDraft } from '../../src/features/agent-config/draftStore.ts'
import { OfferedModels } from '../../src/features/session/OfferedModels.tsx'
import { SettingsScreen, WRITES_SYNCED_CONFIG } from '../../src/features/settings/SettingsScreen.tsx'
import { NotificationsSection } from '../../src/features/settings/sections.tsx'
import { ThreadSessionsSection } from '../../src/features/thread-sessions/ThreadSessionsSection.tsx'
import { ThreadEditor } from '../../src/features/threads/manage/ThreadEditor.tsx'
import { ThreadSettings } from '../../src/features/threads/ThreadSettings.tsx'
import { VoiceSettingsSection } from '../../src/features/voice/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'
import { statusOf } from '../health/status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  resetAgentDraft()
  localStorage.clear()
})

function WhereSearch() {
  return <span data-testid="where">{useLocation().search}</span>
}
function WherePath() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

const cfg = (c: FakeClient) => c.store.getState().config as AgentConfigT
const patches = (c: FakeClient) =>
  c.sent.filter((f) => f.type === 'config.patch') as unknown as Array<{ patch: Record<string, unknown> }>
const lastPatch = (c: FakeClient) => patches(c).at(-1)?.patch
const trip: ThreadT = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}
function withTrip(client: FakeClient, extra: Record<string, unknown> = {}) {
  const cur = cfg(client)
  const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, trip], ...extra })
  client.store.setState({ config: next, threads: next.threads })
}
function stubStatus(over: Partial<HealthStatusT> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...statusOf(), ...over }),
      text: async () => '',
    }),
  )
}

// ---- Quiet window -> Settings -> Notifications ------------------------------------------------------------------------
describe('Quiet hours live in Notifications', () => {
  it('saves at once with a signed patch that touches only quiet_window', async () => {
    const client = setup()
    renderWith(<NotificationsSection readOnly={false} />, client)
    await userEvent.click(screen.getByRole('switch', { name: 'Quiet hours' }))
    await waitFor(() => expect(cfg(client).quiet_window).toEqual({ start: '22:00', end: '07:00' }))
    expect(lastPatch(client)).toEqual({ quiet_window: { start: '22:00', end: '07:00' } })
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:00' } })
    fireEvent.blur(screen.getByLabelText('Quiet hours start'))
    await waitFor(() => expect(cfg(client).quiet_window?.start).toBe('21:00'))
    expect(lastPatch(client)).toEqual({ quiet_window: { start: '21:00', end: '07:00' } })
    await userEvent.click(screen.getByRole('switch', { name: 'Quiet hours' }))
    await waitFor(() => expect(cfg(client).quiet_window).toBeNull())
    expect(lastPatch(client)).toEqual({ quiet_window: null })
    expect(checkConfigPatch(lastPatch(client) ?? {}).ok).toBe(true)
  })

  it('start equal to end sends nothing and says why; a refusal puts the times back', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, quiet_window: { start: '22:00', end: '07:00' } } } : s,
    )
    renderWith(<NotificationsSection readOnly={false} />, client)
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '22:00' } })
    fireEvent.blur(screen.getByLabelText('Quiet hours end'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/must differ/)
    expect(client.sent).toHaveLength(0)
    client.failNextPatchWith('config_conflict')
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '06:00' } })
    fireEvent.blur(screen.getByLabelText('Quiet hours end'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Not saved/))
    expect((screen.getByLabelText('Quiet hours end') as HTMLInputElement).value).toBe('07:00')
    expect(cfg(client).quiet_window).toEqual({ start: '22:00', end: '07:00' })
  })

  it('typing a time sends nothing until the box is left, then one patch with the final value (not 01:00, 10:00, 10:03)', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, quiet_window: { start: '22:00', end: '07:00' } } } : s,
    )
    renderWith(<NotificationsSection readOnly={false} />, client)
    const end = screen.getByLabelText('Quiet hours end')
    for (const v of ['01:00', '10:00', '10:03', '10:30']) fireEvent.change(end, { target: { value: v } })
    expect(client.sent.filter((f) => f.type === 'config.patch')).toHaveLength(0)
    expect((end as HTMLInputElement).value).toBe('10:30')
    fireEvent.blur(end)
    await waitFor(() => expect(cfg(client).quiet_window).toEqual({ start: '22:00', end: '10:30' }))
    expect(patches(client)).toHaveLength(1)
    expect(lastPatch(client)).toEqual({ quiet_window: { start: '22:00', end: '10:30' } })
  })

  it('Enter saves, and the blur that follows it does not send a second patch', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, quiet_window: { start: '22:00', end: '07:00' } } } : s,
    )
    renderWith(<NotificationsSection readOnly={false} />, client)
    const end = screen.getByLabelText('Quiet hours end')
    fireEvent.change(end, { target: { value: '08:15' } })
    fireEvent.keyDown(end, { key: 'Enter' })
    fireEvent.blur(end)
    await waitFor(() => expect(cfg(client).quiet_window?.end).toBe('08:15'))
    expect(patches(client)).toHaveLength(1)
  })

  it('two boxes left in a row save one after the other against a slow Mac, and the last one wins', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, quiet_window: { start: '22:00', end: '07:00' } } } : s,
    )
    // a Mac that takes 80 ms and refuses a patch signed against an old revision, like config_conflict
    const real = client.patchConfig.bind(client)
    let running = 0
    let overlap = 0
    client.patchConfig = async (patch, o) => {
      running++
      overlap = Math.max(overlap, running)
      try {
        await new Promise((r) => setTimeout(r, 80))
        return await real(patch, o)
      } finally {
        running--
      }
    }
    renderWith(<NotificationsSection readOnly={false} />, client)
    const start = screen.getByLabelText('Quiet hours start')
    const end = screen.getByLabelText('Quiet hours end')
    fireEvent.change(start, { target: { value: '21:00' } })
    fireEvent.blur(start)
    fireEvent.change(end, { target: { value: '06:30' } })
    fireEvent.blur(end)
    await waitFor(() => expect(cfg(client).quiet_window).toEqual({ start: '21:00', end: '06:30' }), { timeout: 3000 })
    expect(overlap).toBe(1)
    expect(patches(client)).toHaveLength(2)
  })

  it('a time typed into the other box while a save runs is kept, and is what gets saved next', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, quiet_window: { start: '22:00', end: '07:00' } } } : s,
    )
    const real = client.patchConfig.bind(client)
    client.patchConfig = async (patch, o) => {
      await new Promise((r) => setTimeout(r, 80))
      return await real(patch, o)
    }
    renderWith(<NotificationsSection readOnly={false} />, client)
    const start = screen.getByLabelText('Quiet hours start') as HTMLInputElement
    const end = screen.getByLabelText('Quiet hours end') as HTMLInputElement
    fireEvent.change(start, { target: { value: '21:00' } })
    fireEvent.blur(start)
    // the first save is still running: the owner moves to End and types
    fireEvent.change(end, { target: { value: '06:30' } })
    await waitFor(() => expect(cfg(client).quiet_window?.start).toBe('21:00'), { timeout: 3000 })
    expect(end.value).toBe('06:30')
    fireEvent.blur(end)
    await waitFor(() => expect(cfg(client).quiet_window).toEqual({ start: '21:00', end: '06:30' }), { timeout: 3000 })
  })

  it('is read-only with the Mac offline', () => {
    renderWith(<NotificationsSection readOnly />, setup({ macOffline: true }))
    expect(screen.getByRole('switch', { name: 'Quiet hours' }).hasAttribute('disabled')).toBe(true)
  })
})

// ---- Per-thread notifications: summary in Notifications, home in Thread settings ----------------------------------
describe('Per-thread notifications', () => {
  it('Notifications lists each thread with the same words as Thread settings and links to that thread', () => {
    const client = setup()
    withTrip(client, { threads: [...cfg(client).threads, { ...trip, notify: 'needs_you' }] })
    renderWith(<NotificationsSection readOnly={false} />, client)
    const list = screen.getByTestId('notify-summary')
    expect(within(list).queryByRole('combobox')).toBeNull()
    const row = within(list).getByRole('link', { name: /Trip/ })
    expect(row.textContent).toMatch(/Needs you only/)
    expect(row.getAttribute('href')).toBe('/t/trip?settings=1')
    expect(
      within(list)
        .getAllByRole('link')
        .find((a) => /General/.test(a.textContent ?? ''))?.textContent,
    ).toMatch(/All activity/)
  })

  it('following the link opens that thread’s settings once', async () => {
    const client = setup()
    withTrip(client)
    const t = cfg(client).threads.find((x) => x.id === 'trip') as ThreadT
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/t/trip?settings=1']}>
          <Routes>
            <Route
              path="/t/:id"
              element={
                <>
                  <ThreadSettings thread={t} />
                  <WhereSearch />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(await screen.findByTestId('thread-settings')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('')) // the flag is dropped: Back or refresh won't reopen it
  })

  it('U11: a notification change the Mac refuses does not leave the pill on the new value', async () => {
    const client = setup()
    withTrip(client)
    const t = cfg(client).threads.find((x) => x.id === 'trip') as ThreadT
    renderWith(<ThreadEditor open onOpenChange={() => {}} thread={t} />, client)
    const pill = (name: string) => screen.getByRole('button', { name })
    expect(pill('All activity').getAttribute('aria-pressed')).toBe('true')
    client.failNextPatchWith('config_conflict')
    await userEvent.click(pill('Off'))
    await waitFor(() => expect(screen.getByTestId('notify-error')).toBeTruthy())
    expect(pill('Off').getAttribute('aria-pressed')).toBe('false')
    expect(pill('All activity').getAttribute('aria-pressed')).toBe('true')
    expect(cfg(client).threads.find((x) => x.id === 'trip')?.notify).toBe('all')
    await userEvent.click(pill('Needs you only')) // and a good one still goes through
    await waitFor(() => expect(cfg(client).threads.find((x) => x.id === 'trip')?.notify).toBe('needs_you'))
  })
})

// ---- Thread settings: Live-call context, no default checkbox, archive-only, session options ------------
describe('Thread settings', () => {
  const open = (client: FakeClient, id: string) =>
    renderWith(
      <ThreadEditor open onOpenChange={() => {}} thread={cfg(client).threads.find((x) => x.id === id) as ThreadT} />,
      client,
    )

  it('Live-call context saves at once from the LATEST list, never a stale copy', async () => {
    const client = setup()
    withTrip(client)
    open(client, 'trip')
    // a second caller (the agent, another device) renames a thread after the sheet opened
    client.store.setState((s) => {
      const c = s.config as AgentConfigT
      const threads = c.threads.map((x) => (x.id === 'general' ? { ...x, name: 'Renamed elsewhere' } : x))
      return { ...s, config: { ...c, rev: c.rev + 1, threads }, threads }
    })
    await userEvent.click(screen.getByRole('switch', { name: /Live-call context/ }))
    await waitFor(() => expect(cfg(client).threads.find((x) => x.id === 'trip')?.voice_context).toBe('none'))
    const sent = lastPatch(client)?.threads as ThreadT[]
    expect(sent.find((x) => x.id === 'general')?.name).toBe('Renamed elsewhere') // the other edit is not overwritten
  })

  it('a refusal leaves the switch on the saved value', async () => {
    const client = setup()
    withTrip(client)
    open(client, 'trip')
    client.failNextPatchWith('config_conflict')
    await userEvent.click(screen.getByRole('switch', { name: /Live-call context/ }))
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toMatch(/changed the threads at the same time/)
    expect(screen.getByRole('switch', { name: /Live-call context/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('Live-call context is hidden on the Inbox (M20)', () => {
    const client = setup()
    open(client, 'inbox')
    expect(screen.queryByRole('switch', { name: /Live-call context/ })).toBeNull()
    expect(screen.queryByTestId('thread-switches')).toBeNull() // and no empty container left behind (R1-10)
  })

  it('has no Default thread checkbox, and says archive is the only way to remove a thread (O8)', () => {
    const client = setup()
    withTrip(client)
    open(client, 'trip')
    expect(screen.queryByText('Default thread')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByTestId('archive-only-note').textContent).toMatch(/Archive only/)
  })

  it('nothing in the sheet can change the default thread any more', async () => {
    const client = setup()
    withTrip(client)
    open(client, 'trip')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patches(client).length).toBe(1))
    expect(Object.keys(lastPatch(client) ?? {})).toEqual(['threads'])
  })
})

describe('Own session: model, effort, folder and idle time', () => {
  function dedicated(client: FakeClient) {
    withTrip(client, {
      dedicated: { enabled: true },
      threads: [...cfg(client).threads, { ...trip, session: 'dedicated' }],
    })
    client.store.setState((s) => ({
      ...s,
      presence: { ...s.presence, features: [...(s.presence.features ?? []), THREAD_SESSIONS_FEATURE] },
    }))
  }
  const status = (): WorkersStatusT => ({
    supported: true,
    supervisor_online: true,
    threads: [{ thread_id: 'trip', state: 'live' }],
    governor: { state: 'ok' },
    at: '2026-10-30T00:00:00.000Z',
  })
  async function mount(client: FakeClient) {
    renderWith(
      <ThreadEditor
        open
        onOpenChange={() => {}}
        thread={cfg(client).threads.find((x) => x.id === 'trip') as ThreadT}
      />,
      client,
    )
    await act(async () => client.emit('workers.status', { status: status() }))
    return screen.findByTestId('own-session-options')
  }
  const opts = (c: FakeClient) => c.store.getState().threads.find((x) => x.id === 'trip')?.session_opts

  it('replaces the old line that pointed at controls which did not exist (M15)', async () => {
    const client = setup()
    dedicated(client)
    const box = await mount(client)
    expect(screen.queryByText(/Model and effort changes apply when this thread's session restarts/)).toBeNull()
    expect(box.textContent).toMatch(/next time this thread's session starts/)
  })

  it('model and effort save at once', async () => {
    const client = setup()
    dedicated(client)
    const box = await mount(client)
    await userEvent.selectOptions(within(box).getByLabelText('Model'), 'sonnet')
    await waitFor(() => expect(opts(client)?.model).toBe('sonnet'))
    await userEvent.selectOptions(within(box).getByLabelText('Effort'), 'high')
    await waitFor(() => expect(opts(client)?.effort).toBe('high'))
    await userEvent.selectOptions(within(box).getByLabelText('Effort'), '')
    await waitFor(() => expect(opts(client)?.effort).toBeUndefined())
  })

  it('folder: a relative path is refused here; a folder the Mac refuses is shown in the Mac’s words and put back', async () => {
    const client = setup()
    dedicated(client)
    const box = await mount(client)
    const folder = within(box).getByLabelText('Folder')
    await userEvent.type(folder, 'projects/x{Enter}')
    expect((await within(box).findByRole('alert')).textContent).toMatch(/starts with \//)
    expect(patches(client)).toHaveLength(0)
    await userEvent.clear(folder)
    client.failNextPatchWith('thread_session_refused', 'thread "trip": that folder does not exist on your Mac')
    await userEvent.type(folder, '/Users/example/gone{Enter}')
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(
      /Your Mac said no: thread "trip": that folder does not exist on your Mac/,
    )
    expect(opts(client)?.cwd).toBeUndefined()
    // the box is back on the saved value (the agent folder, empty), not the refused path; and leaving it sends nothing more
    expect((folder as HTMLInputElement).value).toBe('')
    const sentSoFar = patches(client).length
    await userEvent.tab()
    expect(patches(client)).toHaveLength(sentSoFar)
    await userEvent.clear(folder)
    await userEvent.type(folder, '/Users/example/proj{Enter}')
    await waitFor(() => expect(opts(client)?.cwd).toBe('/Users/example/proj'))
    await userEvent.clear(folder)
    await userEvent.tab()
    await waitFor(() => expect(opts(client)?.cwd).toBeUndefined()) // empty = the agent folder
  })

  it('idle time must be 5 to 720 whole minutes', async () => {
    const client = setup()
    dedicated(client)
    const box = await mount(client)
    const idle = within(box).getByLabelText(/Park after idle/)
    await userEvent.clear(idle)
    await userEvent.type(idle, '3{Enter}')
    expect((await within(box).findByRole('alert')).textContent).toMatch(/5 to 720/)
    expect(patches(client)).toHaveLength(0)
    await userEvent.clear(idle)
    await userEvent.type(idle, '45{Enter}')
    await waitFor(() => expect(opts(client)?.idle_park_min).toBe(45))
  })

  it('idle time the Mac refuses goes back to the saved value too', async () => {
    const client = setup()
    dedicated(client)
    const box = await mount(client)
    const idle = within(box).getByLabelText(/Park after idle/) as HTMLInputElement
    const saved = idle.value
    client.failNextPatchWith('thread_session_refused', 'thread "trip": idle time is out of range')
    await userEvent.clear(idle)
    await userEvent.type(idle, '45{Enter}')
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/Your Mac said no/)
    expect(idle.value).toBe(saved)
    expect(opts(client)?.idle_park_min).not.toBe(45)
  })

  it('the controls are disabled with the Mac offline', async () => {
    const client = setup()
    dedicated(client)
    const box = await mount(client)
    act(() => client.store.setState((s) => ({ ...s, presence: { ...s.presence, bridge_online: false } })))
    expect((within(box).getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true)
    expect((within(box).getByLabelText('Folder') as HTMLInputElement).disabled).toBe(true)
  })
})

// ---- Voice -------------------------------------------------------------------------------------------------------------
describe('Voice section', () => {
  it('Voice-note replies moved here: saves at once, M7 words, reverts on refusal', async () => {
    const client = setup()
    renderWith(<VoiceSettingsSection readOnly={false} />, client)
    const sel = screen.getByLabelText('Voice-note replies') as HTMLSelectElement
    const box = screen.getByTestId('spoken-replies')
    expect(box.textContent).toMatch(/Always still sends text if your Mac has no speech command/)
    expect(box.textContent).toMatch(/Never is overridden by Driving mode/)
    await userEvent.selectOptions(sel, 'never')
    await waitFor(() => expect(cfg(client).voice_notes.reply_with_voice).toBe('never'))
    expect(lastPatch(client)).toEqual({ voice_notes: { reply_with_voice: 'never' } })
    client.failNextPatchWith('config_conflict')
    await userEvent.selectOptions(sel, 'always')
    expect((await within(box).findByRole('alert')).textContent).toBeTruthy()
    expect(sel.value).toBe('never')
  })

  it('names the live-call voice as such, and edits the live-call personality with its own Save', async () => {
    const client = setup()
    renderWith(<VoiceSettingsSection readOnly={false} />, client)
    expect(screen.getByLabelText('Live-call voice')).toBeTruthy()
    const box = screen.getByLabelText('Live-call personality') as HTMLTextAreaElement
    const save = screen.getByRole('button', { name: 'Save personality' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(box, 'Calm and brief.')
    await userEvent.click(save)
    await waitFor(() => expect(cfg(client).agent.voice_persona).toBe('Calm and brief.'))
    expect(lastPatch(client)).toEqual({ agent: { voice_persona: 'Calm and brief.' } })
    // too long never reaches the wire (the box stops at 4000)
    expect(box.maxLength).toBe(4000)
  })

  it('a refused personality keeps the words in the box and says so', async () => {
    const client = setup()
    renderWith(<VoiceSettingsSection readOnly={false} />, client)
    await userEvent.type(screen.getByLabelText('Live-call personality'), 'Keep me')
    client.failNextPatchWith('config_conflict')
    await userEvent.click(screen.getByRole('button', { name: 'Save personality' }))
    expect((await screen.findByText(/Not saved/)).textContent).toBeTruthy()
    expect((screen.getByLabelText('Live-call personality') as HTMLTextAreaElement).value).toBe('Keep me')
  })

  it('is read-only with the Mac offline', () => {
    renderWith(<VoiceSettingsSection readOnly />, setup({ macOffline: true }))
    expect((screen.getByLabelText('Voice-note replies') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Live-call personality') as HTMLTextAreaElement).disabled).toBe(true)
  })
})

// ---- Thread sessions: worker cap and usage limits ----------------------------------------------------------------
describe('Thread sessions limits', () => {
  async function mount(client: FakeClient, readOnly = false) {
    client.store.setState((s) => ({
      ...s,
      presence: { ...s.presence, features: [...(s.presence.features ?? []), THREAD_SESSIONS_FEATURE] },
    }))
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter>
            <ThreadSessionsSection readOnly={readOnly} />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>,
    )
    await act(async () =>
      client.emit('workers.status', {
        status: {
          supported: true,
          supervisor_online: true,
          threads: [],
          governor: { state: 'ok' },
          at: '2026-10-30T00:00:00.000Z',
        },
      }),
    )
    return screen.findByTestId('session-limits')
  }

  it('saves the cap and each limit at once, only the touched key', async () => {
    const client = setup()
    const box = await mount(client)
    const cap = within(box).getByLabelText('Sessions running at once')
    await userEvent.clear(cap)
    await userEvent.type(cap, '2{Enter}')
    await waitFor(() => expect(cfg(client).dedicated?.max_live).toBe(2))
    expect(lastPatch(client)).toEqual({ dedicated: { max_live: 2 } })
    const wk = within(box).getByLabelText(/weekly usage/)
    await userEvent.clear(wk)
    await userEvent.type(wk, '70{Enter}')
    await waitFor(() => expect(cfg(client).dedicated?.governor?.weekly).toBe(70))
    expect(lastPatch(client)).toEqual({ dedicated: { governor: { weekly: 70 } } })
    await userEvent.click(within(box).getByRole('switch', { name: /Ignore my usage limits/ }))
    await waitFor(() => expect(cfg(client).dedicated?.governor?.off).toBe(true))
  })

  it('out-of-range values never reach the wire and say what is allowed', async () => {
    const client = setup()
    const box = await mount(client)
    const cap = within(box).getByLabelText('Sessions running at once')
    for (const bad of ['0', '7', '2.5', '-1']) {
      await userEvent.clear(cap)
      await userEvent.type(cap, `${bad}{Enter}`)
      expect((await within(box).findByTestId('limits-error')).textContent).toMatch(/from 1 to 6/)
    }
    expect(patches(client)).toHaveLength(0)
    const pa = within(box).getByLabelText(/Park every session/)
    await userEvent.clear(pa)
    await userEvent.type(pa, '101{Enter}')
    expect((await within(box).findByTestId('limits-error')).textContent).toMatch(/from 1 to 100/)
    expect(patches(client)).toHaveLength(0)
  })

  it('a refusal from the Mac shows in its words, and the box is back on the saved number', async () => {
    const client = setup()
    const box = await mount(client)
    const cap = within(box).getByLabelText('Sessions running at once') as HTMLInputElement
    client.failNextPatchWith('thread_session_refused', 'those thread session settings are not valid')
    await userEvent.clear(cap)
    await userEvent.type(cap, '4{Enter}')
    expect((await within(box).findByTestId('limits-error')).textContent).toMatch(
      /Your Mac said no: those thread session settings/,
    )
    await waitFor(() => expect(cap.value).toBe('3'))
  })

  it('the inputs are disabled with the Mac offline', async () => {
    const client = setup({ macOffline: true })
    const box = await mount(client, true)
    expect((within(box).getByLabelText('Sessions running at once') as HTMLInputElement).disabled).toBe(true)
  })
})

// ---- Offered models -----------------------------------------------------------------------------------------------------
describe('Models offered', () => {
  it('adds and removes at once, from the latest list; refuses junk, duplicates, an empty list and a 13th', async () => {
    const client = setup()
    renderWith(<OfferedModels readOnly={false} />, client)
    const add = screen.getByLabelText('Add a model')
    await userEvent.type(add, 'opus[[1m]{Enter}')
    await waitFor(() => expect(cfg(client).session_models).toContain('opus[1m]'))
    expect(lastPatch(client)).toEqual({ session_models: ['default', 'opus', 'sonnet', 'haiku', 'opus[1m]'] })
    await userEvent.type(add, 'rm -rf{Enter}')
    expect((await screen.findByRole('alert')).textContent).toMatch(/letters, numbers/)
    await userEvent.clear(add)
    await userEvent.type(add, 'opus{Enter}')
    expect((await screen.findByRole('alert')).textContent).toMatch(/already offered/)
    // a second caller changed the list meanwhile: the removal is built from that, not from the render
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, rev: s.config.rev + 1, session_models: ['opus', 'haiku', 'x1'] } } : s,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Remove haiku' }))
    await waitFor(() => expect(cfg(client).session_models).toEqual(['opus', 'x1']))
  })

  it('keeps at least one, and at most 12', async () => {
    const client = setup()
    client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, session_models: ['opus'] } } : s))
    renderWith(<OfferedModels readOnly={false} />, client)
    expect((screen.getByRole('button', { name: 'Remove opus' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, session_models: Array.from({ length: 12 }, (_, i) => `m${i}`) } } : s,
    )
    renderWith(<OfferedModels readOnly={false} />, client)
    await userEvent.type(screen.getByLabelText('Add a model'), 'm99{Enter}')
    expect((await screen.findByRole('alert')).textContent).toMatch(/at most 12/)
    expect(patches(client)).toHaveLength(0)
  })

  it('a refusal shows in words; the Mac offline disables it', async () => {
    const client = setup()
    renderWith(<OfferedModels readOnly={false} />, client)
    client.failNextPatchWith('config_conflict')
    await userEvent.type(screen.getByLabelText('Add a model'), 'sonnet-next{Enter}')
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed these settings at the same time/)
    expect(cfg(client).session_models).not.toContain('sonnet-next')
    cleanup()
    renderWith(<OfferedModels readOnly />, setup({ macOffline: true }))
    expect((screen.getByLabelText('Add a model') as HTMLInputElement).disabled).toBe(true)
  })
})

// ---- The settings page itself ---------------------------------------------------------------------------------------------
describe('SettingsScreen', () => {
  const at = (client: FakeClient, route: string) => {
    return render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter initialEntries={[route]}>
            <WherePath />
            <Routes>
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/settings/:section" element={<SettingsScreen />} />
              <Route path="/settings/health" element={<span data-testid="health-route" />} />
              <Route path="/settings/integrations" element={<span data-testid="integrations-route" />} />
            </Routes>
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>,
    )
  }

  it('lists the renamed and merged sections: Integrations, Health; no Connection, no Webhooks', async () => {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as never
    at(setup(), '/settings')
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' })
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent?.trim())
    expect(names).toContain('Integrations')
    expect(names).not.toContain('Telegram')
    expect(names).toContain('Health')
    expect(names).not.toContain('Connection')
    expect(names).not.toContain('Webhooks')
  })

  it('/settings/connection redirects to Health; Integrations and Health open their own routes', async () => {
    const a = at(setup(), '/settings/connection')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/settings/health'))
    a.unmount()
    at(setup(), '/settings/integrations')
    await waitFor(() => expect(screen.getByTestId('integrations-route')).toBeTruthy())
  })

  it('every section that writes synced config is read-only, and says so, with the Mac offline (U11)', async () => {
    expect(WRITES_SYNCED_CONFIG.sort()).toEqual(
      ['agent', 'notifications', 'session', 'thread-sessions', 'voice'].sort(),
    )
    for (const id of ['voice', 'notifications', 'agent']) {
      const client = setup({ macOffline: true })
      stubStatus()
      const view = at(client, `/settings/${id}`)
      await waitFor(() => expect(document.querySelector('section')).toBeTruthy())
      // the driving rows and microphone choice are per-device preferences, not synced config: they stay usable
      const sw = [...view.container.querySelectorAll('[role="switch"], select, textarea')].filter(
        (el) => !el.closest('[data-testid="driving-row"]'),
      )
      expect(sw.length, id).toBeGreaterThan(0)
      for (const el of sw)
        expect(
          (el as HTMLInputElement).disabled || el.hasAttribute('disabled'),
          `${id} ${el.outerHTML.slice(0, 60)}`,
        ).toBe(true)
      view.unmount()
    }
  })
})
