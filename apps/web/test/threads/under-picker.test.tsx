// Thread settings → Under (sub-threads): which threads it offers, that it writes parent_id through the normal config.patch
// (null to take a thread out), and that the Mac's refusal shows in its own words with the choice back on what is saved.
import { AgentConfig, type AgentConfigT, SUBTHREADS_FEATURE, type ThreadT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadEditor } from '../../src/features/threads/manage/ThreadEditor.tsx'
import { ownFolderNote, underChoices } from '../../src/features/threads/manage/UnderPicker.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

const T = (id: string, name: string, over: Partial<ThreadT> = {}): ThreadT => ({
  id,
  name,
  kind: 'agent',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
})
const EXTRA = [
  T('work', 'Work'),
  T('daily', 'Daily'),
  T('trip', 'Trip'),
  T('visas', 'Visas', { parent_id: 'trip' }),
  T('old', 'Old', { archived: true }),
]

function client(features: string[] = [SUBTHREADS_FEATURE]): FakeClient {
  const c = setup()
  const cur = c.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, ...EXTRA] })
  const presence = c.store.getState().presence
  c.store.setState({
    config: next,
    threads: next.threads,
    presence: { ...presence, bridge_online: true, features: [...(presence.features ?? []), ...features] },
  })
  return c
}
const thread = (c: FakeClient, id: string) => c.store.getState().threads.find((t) => t.id === id) as ThreadT

function open(c: FakeClient, id: string) {
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={c}>
        <MemoryRouter>
          <ThreadEditor open onOpenChange={() => {}} thread={thread(c, id)} />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
}
const select = () => within(screen.getByTestId('thread-under')).getByRole('combobox') as HTMLSelectElement
const offered = () => [...select().options].filter((o) => !o.disabled).map((o) => o.value)

describe('Under: what it offers', () => {
  it('none, or a top-level thread that is not archived, not the inbox and not itself', () => {
    const c = client()
    expect(underChoices(c.store.getState().threads, thread(c, 'daily')).map((t) => t.id)).toEqual(
      expect.arrayContaining(['general', 'work', 'trip']),
    )
    open(c, 'daily')
    const ids = offered()
    expect(ids[0]).toBe('') // No thread (top level)
    expect(ids).toEqual(expect.arrayContaining(['work', 'trip', 'general']))
    for (const never of ['daily', 'visas', 'old', 'inbox']) expect(ids).not.toContain(never)
  })

  it('a thread that has sub-threads cannot go under another: it says why instead of offering a choice', () => {
    const c = client()
    open(c, 'trip')
    expect(screen.getByTestId('thread-under-blocked').textContent).toMatch(/has sub-threads/)
    expect(within(screen.getByTestId('thread-under')).queryByRole('combobox')).toBeNull()
  })

  it('is hidden when the Mac does not take sub-threads (no subthreads/1 in hello)', () => {
    const c = client([])
    open(c, 'daily')
    expect(screen.queryByTestId('thread-under')).toBeNull()
  })

  it('is hidden for the inbox', () => {
    const c = client()
    open(c, 'inbox')
    expect(screen.queryByTestId('thread-under')).toBeNull()
  })
})

describe('Under: what it writes', () => {
  it('picking Work writes parent_id through config.patch', async () => {
    const c = client()
    open(c, 'daily')
    await act(async () => fireEvent.change(select(), { target: { value: 'work' } }))
    await waitFor(() => expect(thread(c, 'daily').parent_id).toBe('work'))
    expect(select().value).toBe('work')
  })

  it('"No thread" takes a sub-thread out: the patch says null, so the Mac does not keep the old parent', async () => {
    const c = client()
    const sent: Array<Record<string, unknown>> = []
    const real = c.patchConfig.bind(c)
    c.patchConfig = (patch) => {
      sent.push(patch)
      return real(patch)
    }
    open(c, 'visas')
    expect(select().value).toBe('trip')
    await act(async () => fireEvent.change(select(), { target: { value: '' } }))
    await waitFor(() => expect(thread(c, 'visas').parent_id).toBeUndefined())
    expect(sent).toHaveLength(1)
    const wire = ((sent[0]?.threads ?? []) as Array<Record<string, unknown>>).find((t) => t.id === 'visas')
    expect(wire).toHaveProperty('parent_id', null)
  })

  it("the Mac's refusal shows in its own words, and the choice goes back to what is saved", async () => {
    const c = client()
    const reason = 'thread "daily": a sub-thread\'s folder must be inside its parent\'s folder'
    c.failNextPatchWith('bad_frame', reason)
    open(c, 'daily')
    await act(async () => fireEvent.change(select(), { target: { value: 'work' } }))
    await waitFor(() =>
      expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContainEqual(expect.stringContaining(reason)),
    )
    expect(screen.getAllByRole('alert').filter((a) => a.textContent?.includes(reason))).toHaveLength(1) // shown once
    expect(thread(c, 'daily').parent_id).toBeUndefined()
    expect(select().value).toBe('')
  })
})

describe('Under: a sub-thread that keeps its own folder', () => {
  const own = [
    T('boss', 'Boss', {
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/agent', model: 'inherit', idle_park_min: 30 },
    }),
    T('repo', 'Repo', {
      parent_id: 'boss',
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/repo', model: 'inherit', idle_park_min: 30 },
    }),
    T('inner', 'Inner', {
      parent_id: 'boss',
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/agent/inner', model: 'inherit', idle_park_min: 30 },
    }),
  ]
  const line =
    'thread "repo" keeps its own folder, so it does not get "boss"\'s instructions; the parent\'s privacy rules still apply'

  it('says it once, for that thread only', () => {
    expect(ownFolderNote(own, own[1] as ThreadT)).toBe(line)
    expect(ownFolderNote(own, own[2] as ThreadT)).toBeNull()
    expect(ownFolderNote(own, own[0] as ThreadT)).toBeNull()
  })

  it('shows under the picker in thread settings, and not for a thread inside its parent', () => {
    const c = client()
    const cur = c.store.getState().config as AgentConfigT
    const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, ...own] })
    c.store.setState({ config: next, threads: next.threads })
    open(c, 'repo')
    expect(screen.getByTestId('thread-under-own-folder').textContent).toBe(line)
    cleanup()
    open(c, 'inner')
    expect(screen.queryByTestId('thread-under-own-folder')).toBeNull()
  })
})

describe("Under: a sub-thread that works in its parent's folder", () => {
  const dedicated = { session: 'dedicated' as const }
  const opts = (cwd?: string) => ({ session_opts: { ...(cwd ? { cwd } : {}), model: 'inherit', idle_park_min: 30 } })
  const shared = [
    T('boss', 'Boss', { ...dedicated, ...opts('/home/alex/agent') }),
    T('none', 'None', { parent_id: 'boss', ...dedicated, ...opts() }),
    T('same', 'Same', { parent_id: 'boss', ...dedicated, ...opts('/home/alex/agent/') }),
    T('inner', 'Inner', { parent_id: 'boss', ...dedicated, ...opts('/home/alex/agent/inner') }),
  ]
  const line = (id: string) =>
    `thread "${id}" and its parent "boss" work in the same folder; they can edit the same files`

  it('says so once, for that thread only (no folder, or the same one)', () => {
    expect(ownFolderNote(shared, shared[1] as ThreadT)).toBe(line('none'))
    expect(ownFolderNote(shared, shared[2] as ThreadT)).toBe(line('same'))
    expect(ownFolderNote(shared, shared[3] as ThreadT)).toBeNull()
    expect(ownFolderNote(shared, shared[0] as ThreadT)).toBeNull()
  })

  it('shows under the picker in thread settings', () => {
    const c = client()
    const cur = c.store.getState().config as AgentConfigT
    const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, ...shared] })
    c.store.setState({ config: next, threads: next.threads })
    open(c, 'none')
    expect(screen.getByTestId('thread-under-own-folder').textContent).toBe(line('none'))
    cleanup()
    open(c, 'inner')
    expect(screen.queryByTestId('thread-under-own-folder')).toBeNull()
  })
})
