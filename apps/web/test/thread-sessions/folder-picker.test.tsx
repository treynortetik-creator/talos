// The Folder field of a thread's own session (docs/OPTION-C.md 9.2): it shows the real folder, "Choose…" opens a folder
// browser that asks the Mac for NAMES of folders, a pick goes through the same owner-signed thread patch as typing, and the last
// five folders come back as chips. In the Mac app, "Choose…" asks the Mac's own open panel instead. Only the Mac is faked.
import {
  AgentConfig,
  type AgentConfigT,
  FOLDERS_FEATURE,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OwnSession } from '../../src/features/thread-sessions/OwnSession.tsx'
import { ClientProvider, useTalos } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const HOME = '/Users/alex'
const AGENT = '/Users/alex/agents/main'
const TREE: Record<string, string[]> = {
  [HOME]: ['Documents', 'Projects', 'agents', '.cache'],
  [`${HOME}/Projects`]: ['alpha', 'beta', '.git'],
  [`${HOME}/Projects/alpha`]: ['src', 'docs'],
  [`${HOME}/Documents`]: [],
  [`${HOME}/agents`]: ['main'],
  [`${HOME}/weird`]: ['ev‮il'],
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})
beforeEach(() => localStorage.clear())

const trip: ThreadT = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
}
const status: WorkersStatusT = {
  supported: true,
  supervisor_online: true,
  threads: [{ thread_id: 'trip', state: 'live' }],
  governor: { state: 'ok' },
  at: '2026-10-30T00:00:00.000Z',
}

function Live() {
  const thread = useTalos((s) => s.threads.find((t) => t.id === 'trip')) as ThreadT
  return <OwnSession thread={thread} />
}

async function mount(opts: { cwd?: string; folders?: boolean; agentDir?: string | null } = {}) {
  const client: FakeClient = setup({
    folders: { home: HOME, ...(opts.agentDir === null ? {} : { agentDir: opts.agentDir ?? AGENT }), tree: TREE },
  })
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({
    ...cur,
    dedicated: { enabled: true },
    threads: [...cur.threads, opts.cwd ? { ...trip, session_opts: { cwd: opts.cwd } } : trip],
  })
  const features = (client.store.getState().presence.features ?? []).filter((f) => f !== FOLDERS_FEATURE)
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: {
      ...client.store.getState().presence,
      features: [...features, THREAD_SESSIONS_FEATURE, ...(opts.folders === false ? [] : [FOLDERS_FEATURE])],
    },
  })
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>
          <Live />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  await act(async () => client.emit('workers.status', { status }))
  return client
}
const field = () => screen.getByTestId('folder-field')
const browser = () => screen.getByTestId('folder-browser')
const savedCwd = (c: FakeClient) =>
  (c.store.getState().threads.find((t) => t.id === 'trip') as ThreadT).session_opts?.cwd
const patches = (c: FakeClient) => c.sent.filter((f) => f.type === 'config.patch')

describe('the field shows the real folder', () => {
  it('unset: names the agent folder by its real path, with ~ for home, and not the old placeholder', async () => {
    await mount()
    await waitFor(() => expect(screen.getByTestId('folder-current').textContent).toContain('~/agents/main'))
    expect(screen.getByTestId('folder-current').textContent).toMatch(/agent folder/i)
    expect(document.body.textContent).not.toContain('The agent folder')
    expect(screen.queryByPlaceholderText('The agent folder')).toBeNull()
  })

  it('set: shows the chosen folder, ~ for home, and keeps the full path out of sight but in the saved value', async () => {
    const c = await mount({ cwd: `${HOME}/Projects/alpha` })
    await waitFor(() => expect(screen.getByTestId('folder-current').textContent).toContain('~/Projects/alpha'))
    expect(screen.getByLabelText('Folder')).toHaveProperty('value', '~/Projects/alpha')
    expect(savedCwd(c)).toBe(`${HOME}/Projects/alpha`)
  })

  it('a folder outside home is shown whole', async () => {
    await mount({ cwd: '/Volumes/Work/alpha' })
    await waitFor(() => expect(screen.getByTestId('folder-current').textContent).toContain('/Volumes/Work/alpha'))
  })

  it('the Mac does not say where the agent folder is: the line says it is the agent folder, with no made-up path', async () => {
    await mount({ agentDir: null })
    await waitFor(() => expect(screen.getByTestId('folder-current').textContent).toMatch(/agent folder/i))
    expect(screen.getByTestId('folder-current').textContent).not.toContain('/Users')
  })

  it('typing ~/… works and is saved as the full path', async () => {
    const c = await mount()
    await waitFor(() => expect(screen.getByTestId('folder-current').textContent).toContain('~/agents/main'))
    const input = screen.getByLabelText('Folder')
    await userEvent.type(input, '~/Documents{Enter}')
    await waitFor(() => expect(savedCwd(c)).toBe(`${HOME}/Documents`))
  })
})

describe('Choose… opens the browser', () => {
  it('starts at home, lists folder names only, hides dot-folders, and shows breadcrumbs', async () => {
    await mount()
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(within(browser()).getByRole('button', { name: 'Projects' })).toBeTruthy())
    const names = within(browser())
      .getAllByTestId('folder-entry')
      .map((e) => e.textContent)
    expect(names).toEqual(['agents', 'Documents', 'Projects'])
    expect(within(browser()).queryByText('.cache')).toBeNull()
    const crumbs = within(browser()).getByRole('navigation', { name: 'Folder path' })
    expect(crumbs.textContent).toContain('~')
  })

  it('Show hidden lists the dot-folders too', async () => {
    await mount()
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await waitFor(() => within(browser()).getByRole('button', { name: 'Projects' }))
    await userEvent.click(within(browser()).getByLabelText('Show hidden'))
    await waitFor(() => expect(within(browser()).getByText('.cache')).toBeTruthy())
  })

  it('opening a folder goes in, the breadcrumbs follow, and a crumb goes back up', async () => {
    await mount()
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await userEvent.click(await within(browser()).findByRole('button', { name: 'Projects' }))
    await userEvent.click(await within(browser()).findByRole('button', { name: 'alpha' }))
    await waitFor(() => within(browser()).getByRole('button', { name: 'src' }))
    const crumbs = within(browser()).getByRole('navigation', { name: 'Folder path' })
    expect(
      within(crumbs)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['~', 'Projects', 'alpha'])
    await userEvent.click(within(crumbs).getByRole('button', { name: 'Projects' }))
    await waitFor(() => within(browser()).getByRole('button', { name: 'beta' }))
  })

  it('"Use this folder" saves the folder being looked at through the thread patch, closes the browser, and updates the field', async () => {
    const c = await mount()
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await userEvent.click(await within(browser()).findByRole('button', { name: 'Projects' }))
    await userEvent.click(await within(browser()).findByRole('button', { name: 'alpha' }))
    await waitFor(() => within(browser()).getByRole('button', { name: 'src' }))
    await userEvent.click(within(browser()).getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(patches(c)).toHaveLength(1))
    const p = patches(c)[0] as { patch: { threads: Array<{ id: string; session_opts?: { cwd?: string } }> } }
    expect(p.patch.threads.find((t) => t.id === 'trip')?.session_opts?.cwd).toBe(`${HOME}/Projects/alpha`)
    await waitFor(() => expect(savedCwd(c)).toBe(`${HOME}/Projects/alpha`))
    await waitFor(() => expect(screen.queryByTestId('folder-browser')).toBeNull())
    expect(screen.getByTestId('folder-current').textContent).toContain('~/Projects/alpha')
  })

  it('Cancel closes it and saves nothing', async () => {
    const c = await mount()
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await within(browser()).findByRole('button', { name: 'Projects' })
    await userEvent.click(within(browser()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('folder-browser')).toBeNull()
    expect(patches(c)).toHaveLength(0)
  })

  it('the Mac says no: the browser says so in the Mac’s words and nothing is saved', async () => {
    const c = await mount()
    c.fakeFolders.failNextWith("That folder can't be opened.")
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await waitFor(() =>
      expect(within(browser()).getByRole('alert').textContent).toContain("That folder can't be opened."),
    )
    expect(patches(c)).toHaveLength(0)
  })

  it('an older Mac (no folder listing) gets no Choose… button, only the typed field', async () => {
    await mount({ folders: false })
    expect(within(field()).queryByRole('button', { name: 'Choose…' })).toBeNull()
    expect(screen.getByLabelText('Folder')).toBeTruthy()
  })

  it('with the Mac away the browser cannot be opened', async () => {
    const c = await mount()
    act(() => c.setMacOnline(false))
    expect(within(field()).getByRole('button', { name: 'Choose…' })).toHaveProperty('disabled', true)
  })

  it('a long list says how many more there are, in words', async () => {
    const c = await mount()
    c.fakeFolders.setMore(`${HOME}`, 37)
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(browser().textContent).toContain('37 more not shown'))
  })
})

describe('hidden characters in names', () => {
  it('a name with a direction override is shown with the mark spelled out', async () => {
    const c = await mount()
    c.fakeFolders.setTree(HOME, ['ev‮il'])
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(within(browser()).getAllByTestId('folder-entry')).toHaveLength(1))
    expect(within(browser()).getByTestId('folder-entry').textContent).toBe('ev⟦U+202E⟧il')
  })
})

describe('recent folders', () => {
  it('a folder chosen is remembered on this device; the last five show as chips, newest first, and a chip saves it', async () => {
    const c = await mount()
    const pick = async (name: string) => {
      await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
      await userEvent.click(await within(browser()).findByRole('button', { name: 'Projects' }))
      await userEvent.click(await within(browser()).findByRole('button', { name }))
      await userEvent.click(within(browser()).getByRole('button', { name: 'Use this folder' }))
      await waitFor(() => expect(screen.queryByTestId('folder-browser')).toBeNull())
    }
    c.fakeFolders.setTree(`${HOME}/Projects`, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      c.fakeFolders.setTree(`${HOME}/Projects/${n}`, [])
      await pick(n)
    }
    const chips = within(screen.getByTestId('recent-folders')).getAllByRole('button')
    expect(chips.map((b) => b.textContent)).toEqual([
      '~/Projects/p6',
      '~/Projects/p5',
      '~/Projects/p4',
      '~/Projects/p3',
      '~/Projects/p2',
    ])
    await userEvent.click(chips[2] as HTMLElement)
    await waitFor(() => expect(savedCwd(c)).toBe(`${HOME}/Projects/p4`))
    // stored on this device only, as plain paths
    expect(JSON.parse(localStorage.getItem('talos.recent-folders') ?? '[]')[0]).toBe(`${HOME}/Projects/p4`)
  })

  it('a folder the Mac refused is not remembered', async () => {
    const c = await mount()
    c.failNextPatchWith('thread_session_refused', 'that folder does not exist on your Mac')
    await userEvent.click(within(field()).getByRole('button', { name: 'Choose…' }))
    await userEvent.click(await within(browser()).findByRole('button', { name: 'Documents' }))
    await userEvent.click(await within(browser()).findByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('does not exist'))
    expect(screen.queryByTestId('recent-folders')).toBeNull()
    expect(localStorage.getItem('talos.recent-folders')).toBeNull()
  })

  it('there are no chips before anything was chosen', async () => {
    await mount()
    expect(screen.queryByTestId('recent-folders')).toBeNull()
  })
})
