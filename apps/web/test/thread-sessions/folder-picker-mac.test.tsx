// "Choose…" inside the Mac app: the page asks the Mac for its own open panel (`pick_folder`), and the Mac answers
// `folder_picked` with the folder or null. The path then goes through the same thread patch as typing. A Mac app that
// does not list `pick-folder` in its user agent (an older one) gets the in-app browser instead of a question nobody answers.
import {
  AgentConfig,
  type AgentConfigT,
  FOLDERS_FEATURE,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
} from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { attachShell } from '../../src/features/native/attach.ts'
import { OwnSession } from '../../src/features/thread-sessions/OwnSession.tsx'
import { ClientProvider, useTalos } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { DESKTOP_UA_MARK } from '../../src/lib/native/detect.ts'
import { folderPicked, PICK_WAIT_MS, pendingPickCount, pickFolderNative } from '../../src/lib/native/folderPick.ts'
import { getShell, installShell } from '../../src/lib/native/shell.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const HOME = '/Users/alex'
const posted: Array<Record<string, unknown>> = []
const picks = () => posted.filter((m) => m.type === 'pick_folder')

beforeAll(() => {
  const scope: Record<string, unknown> = {
    webkit: { messageHandlers: { talos: { postMessage: (m: unknown) => posted.push(m as Record<string, unknown>) } } },
    navigator: { userAgent: `Mozilla/5.0${DESKTOP_UA_MARK}1.0 TalosFeatures/pick-folder` },
  }
  scope.top = scope
  expect(installShell(scope)).not.toBeNull()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  posted.length = 0
})

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
function Live() {
  const thread = useTalos((s) => s.threads.find((t) => t.id === 'trip')) as ThreadT
  return <OwnSession thread={thread} />
}
async function mount(without = false) {
  const client: FakeClient = setup({
    folders: { home: HOME, tree: { [HOME]: ['Projects'], [`${HOME}/Projects`]: [] } },
  })
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({ ...cur, dedicated: { enabled: true }, threads: [...cur.threads, trip] })
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: {
      ...client.store.getState().presence,
      features: [...(client.store.getState().presence.features ?? []), THREAD_SESSIONS_FEATURE, FOLDERS_FEATURE],
    },
  })
  const shell = getShell()
  if (!shell)
    throw new Error('no shell')
    // an older Mac app does not list pick-folder in its user agent
  ;(shell as { features: readonly string[] }).features = without ? [] : ['pick-folder']
  attachShell(shell, client)
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>
          <Live />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  await act(async () =>
    client.emit('workers.status', {
      status: {
        supported: true,
        supervisor_online: true,
        threads: [{ thread_id: 'trip', state: 'live' }],
        governor: { state: 'ok' },
        at: '2026-10-30T00:00:00.000Z',
      },
    }),
  )
  return client
}
const cwdOf = (c: FakeClient) => (c.store.getState().threads.find((t) => t.id === 'trip') as ThreadT).session_opts?.cwd
const choose = () => within(screen.getByTestId('folder-field')).getByRole('button', { name: 'Choose…' })

describe('Choose… in the Mac app', () => {
  it('asks the Mac for its open panel and does not open the in-app browser', async () => {
    await mount()
    await userEvent.click(choose())
    expect(picks()).toHaveLength(1)
    expect(picks()[0]?.req).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(screen.queryByTestId('folder-browser')).toBeNull()
  })

  it('the Mac answers with a folder: it is saved through the thread patch and remembered', async () => {
    const c = await mount()
    await userEvent.click(choose())
    const req = picks()[0]?.req
    await act(async () => {
      getShell()?.bridge.receive({ type: 'folder_picked', req, path: `${HOME}/Projects` })
    })
    await waitFor(() => expect(cwdOf(c)).toBe(`${HOME}/Projects`))
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('talos.recent-folders') ?? '[]')).toEqual([`${HOME}/Projects`])
  })

  it('the owner cancels the panel: nothing is saved', async () => {
    const c = await mount()
    await userEvent.click(choose())
    await act(async () => {
      getShell()?.bridge.receive({ type: 'folder_picked', req: picks()[0]?.req, path: null })
    })
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(0)
    expect(cwdOf(c)).toBeUndefined()
  })

  it('an answer to a request nobody made is ignored', async () => {
    const c = await mount()
    await act(async () => {
      getShell()?.bridge.receive({ type: 'folder_picked', req: 'nobody', path: `${HOME}/Projects` })
    })
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(0)
  })

  it('an older Mac app (no pick-folder in its user agent) gets the in-app browser', async () => {
    await mount(true)
    await userEvent.click(choose())
    expect(picks()).toHaveLength(0)
    await waitFor(() => expect(screen.getByTestId('folder-browser')).toBeTruthy())
  })

  it('a path the Mac app returns is still checked by the Mac: the refusal shows in words', async () => {
    const c = await mount()
    c.failNextPatchWith('thread_session_refused', "the folder can't be inside ~/.claude")
    await userEvent.click(choose())
    await act(async () => {
      getShell()?.bridge.receive({ type: 'folder_picked', req: picks()[0]?.req, path: `${HOME}/.claude/x` })
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('~/.claude'))
    expect(cwdOf(c)).toBeUndefined()
  })
})

describe('when the Mac cannot or will not show the panel', () => {
  it('"not now" is said in words, not taken for the owner cancelling', async () => {
    const c = await mount()
    await userEvent.click(choose())
    await act(async () => {
      getShell()?.bridge.receive({ type: 'folder_picked', req: picks()[0]?.req, path: null, why: 'not_now' })
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/can't show the folder panel/))
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(0)
  })

  it('a folder whose name has a character Talos cannot use says so, and nothing is saved', async () => {
    const c = await mount()
    await userEvent.click(choose())
    await act(async () => {
      getShell()?.bridge.receive({ type: 'folder_picked', req: picks()[0]?.req, path: null, why: 'bad_name' })
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/character/))
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(0)
  })

  it('a request nobody answers is dropped after a long wait, its slot is freed, and a late answer is ignored', async () => {
    vi.useFakeTimers()
    try {
      const before = pendingPickCount() // requests other tests left unanswered stay (their timers are not ours)
      const p = pickFolderNative()
      const req = posted.filter((m) => m.type === 'pick_folder').at(-1)?.req as string
      expect(pendingPickCount()).toBe(before + 1)
      await vi.advanceTimersByTimeAsync(PICK_WAIT_MS + 1000)
      expect(await p).toEqual({ path: null })
      expect(pendingPickCount()).toBe(before)
      expect(() => folderPicked(req, `${HOME}/Projects`)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
