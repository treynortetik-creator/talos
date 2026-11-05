// D36 (the thread row menu: long press, right-click, swipe, Mark all read) and the D14 leftover (Share on a message), plus
// the D38 row line, in jsdom against the in-memory client.
import type { MessageT, ThreadT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
import { archiveBlockedReason } from '../../src/features/threads/ThreadRowMenu.tsx'
import { ClientProvider, type TalosClient, TalosClientError } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { type Platform, setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  setPlatform(webPlatform)
  vi.unstubAllGlobals()
})

const T = (id: string, over: Partial<ThreadT> = {}): ThreadT =>
  ({
    id,
    name: id[0]?.toUpperCase() + id.slice(1),
    kind: 'fixed',
    order: 0,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as ThreadT

describe('archiveBlockedReason: ThreadEditor’s three rules', () => {
  const all = [T('inbox', { kind: 'system' }), T('general'), T('plans'), T('ideas')]
  it('allows a plain thread', () => expect(archiveBlockedReason(all[2] as ThreadT, all, 'general')).toBeNull())
  it('keeps the default thread', () =>
    expect(archiveBlockedReason(all[1] as ThreadT, all, 'general')).toMatch(/default/))
  it('keeps a system thread', () =>
    expect(archiveBlockedReason(all[0] as ThreadT, all, 'general')).toMatch(/cannot be archived/))
  it('keeps the last active thread', () => {
    const two = [T('inbox', { kind: 'system' }), T('general'), T('plans', { archived: true })]
    expect(archiveBlockedReason(two[1] as ThreadT, two, 'plans')).toMatch(/at least one/)
  })
  it('always lets an archived thread come back', () => {
    const t = T('plans', { archived: true })
    expect(archiveBlockedReason(t, [t], 'plans')).toBeNull()
  })
})

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}
function mountList(client: TalosClient) {
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/threads']}>
          <Where />
          <Routes>
            <Route path="/threads" element={<ThreadList />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
}
function listClient(over: { online?: boolean; unread?: Record<string, number> } = {}) {
  const client = setup({})
  const threads = [
    T('inbox', { kind: 'system', order: 0 }),
    T('general', { order: 1 }),
    T('plans', { order: 2 }),
    T('ideas', { order: 3 }),
  ]
  client.store.setState((s) => ({
    ...s,
    threads,
    config: s.config ? { ...s.config, threads, default_thread: 'general' } : s.config,
    unread: over.unread ?? { plans: 2 },
    lastSeq: 77,
    presence: { ...s.presence, bridge_online: over.online ?? true },
  }))
  client.markThreadRead = vi.fn(() => true)
  client.markThreadUnread = vi.fn(() => true)
  client.patchConfig = vi.fn(async () => {})
  return client
}

describe('thread row menu', () => {
  it('a right-click opens Mark read, Mute and Archive on a row that has unread', async () => {
    const client = listClient()
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    const menu = await screen.findByTestId('row-menu')
    expect(within(menu).getByTestId('row-read').textContent).toBe('Mark read')
    expect(within(menu).getByTestId('row-mute').textContent).toBe('Mute')
    expect(within(menu).getByTestId('row-archive').textContent).toBe('Archive')
    fireEvent.click(within(menu).getByTestId('row-read'))
    expect(client.markThreadRead).toHaveBeenCalledWith('plans', 77, { needConnection: true })
    await waitFor(() => expect(screen.queryByTestId('row-menu')).toBeNull())
  })

  it('a thread with nothing unread offers Mark unread, and a refusal is said out loud', async () => {
    const client = listClient()
    client.markThreadUnread = vi.fn(() => false)
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-ideas'))
    fireEvent.click(await screen.findByTestId('row-read'))
    expect(client.markThreadUnread).toHaveBeenCalledWith('ideas')
    expect((await screen.findByTestId('row-menu-note')).textContent).toMatch(/relay/)
  })

  it('Mute patches notify off through the config, and a muted thread offers Unmute', async () => {
    const client = listClient()
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    fireEvent.click(await screen.findByTestId('row-mute'))
    await waitFor(() => expect(client.patchConfig).toHaveBeenCalledTimes(1))
    const sent = (client.patchConfig as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      threads: Array<{ id: string; notify: string }>
    }
    expect(sent.threads.find((t) => t.id === 'plans')?.notify).toBe('off')
    expect(sent.threads.find((t) => t.id === 'ideas')?.notify).toBe('all')
  })

  it('Archive follows the editor: allowed on a plain thread, refused on the default and on the system thread', async () => {
    const client = listClient()
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-general'))
    expect((await screen.findByTestId('row-archive')).hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('row-menu-note').textContent).toMatch(/default/)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('row-menu')).toBeNull())

    fireEvent.contextMenu(screen.getByTestId('thread-row-inbox'))
    expect((await screen.findByTestId('row-archive')).hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('row-menu-note').textContent).toMatch(/cannot be archived/)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('row-menu')).toBeNull())

    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    fireEvent.click(await screen.findByTestId('row-archive'))
    await waitFor(() => expect(client.patchConfig).toHaveBeenCalledTimes(1))
    const sent = (client.patchConfig as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      threads: Array<{ id: string; archived: boolean }>
    }
    expect(sent.threads.find((t) => t.id === 'plans')?.archived).toBe(true)
  })

  it('with the Mac offline Mute and Archive are off and say why; Mark read still works', async () => {
    const client = listClient({ online: false })
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    expect((await screen.findByTestId('row-mute')).hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('row-archive').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('row-menu-note').textContent).toMatch(/Mac has to be online/)
    expect(screen.getByTestId('row-read').hasAttribute('disabled')).toBe(false)
  })

  it('a 500 ms touch press opens it and the click that follows does not open the thread; a short tap still does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mountList(listClient())
      const link = screen.getByTestId('thread-row-plans')
      fireEvent.pointerDown(link, { pointerType: 'touch', clientX: 200, clientY: 50 })
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByTestId('row-menu')).toBeTruthy()
      fireEvent.pointerUp(link, { pointerType: 'touch', clientX: 200, clientY: 50 })
      fireEvent.click(link) // the click iOS makes up when the finger lifts
      expect(screen.getByTestId('where').textContent).toBe('/threads')
      act(() => void vi.advanceTimersByTime(700))
      fireEvent.keyDown(document.body, { key: 'Escape' })
      act(() => void vi.advanceTimersByTime(50))

      const ideas = screen.getByTestId('thread-row-ideas')
      fireEvent.pointerDown(ideas, { pointerType: 'touch', clientX: 200, clientY: 50 })
      act(() => void vi.advanceTimersByTime(150))
      fireEvent.pointerUp(ideas, { pointerType: 'touch', clientX: 200, clientY: 50 })
      fireEvent.click(ideas)
      expect(screen.getByTestId('where').textContent).toBe('/t/ideas')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a swipe right on a row with unread marks it read; on a read row it marks it unread', () => {
    const client = listClient()
    mountList(client)
    const swipe = (id: string, from: number, to: number) => {
      const el = screen.getByTestId(`thread-row-${id}`)
      fireEvent.pointerDown(el, { pointerType: 'touch', clientX: from, clientY: 40 })
      fireEvent.pointerMove(el, { pointerType: 'touch', clientX: (from + to) / 2, clientY: 42 })
      fireEvent.pointerMove(el, { pointerType: 'touch', clientX: to, clientY: 44 })
      fireEvent.pointerUp(el, { pointerType: 'touch', clientX: to, clientY: 44 })
    }
    swipe('plans', 100, 220)
    expect(client.markThreadRead).toHaveBeenCalledWith('plans', 77, { needConnection: true })
    swipe('ideas', 100, 220)
    expect(client.markThreadUnread).toHaveBeenCalledWith('ideas')
  })

  it('a swipe that starts in the edge strip is left to the edge swipes', () => {
    const client = listClient()
    mountList(client)
    const el = screen.getByTestId('thread-row-plans')
    fireEvent.pointerDown(el, { pointerType: 'touch', clientX: 8, clientY: 40 })
    fireEvent.pointerMove(el, { pointerType: 'touch', clientX: 60, clientY: 41 })
    fireEvent.pointerMove(el, { pointerType: 'touch', clientX: 140, clientY: 42 })
    fireEvent.pointerUp(el, { pointerType: 'touch', clientX: 140, clientY: 42 })
    expect(client.markThreadRead).not.toHaveBeenCalled()
    expect(client.markThreadUnread).not.toHaveBeenCalled()
  })

  it('a swipe left archives a plain thread, and on the default thread opens the menu with the reason instead', async () => {
    const client = listClient()
    mountList(client)
    const swipeLeft = (id: string) => {
      const el = screen.getByTestId(`thread-row-${id}`)
      fireEvent.pointerDown(el, { pointerType: 'touch', clientX: 260, clientY: 40 })
      fireEvent.pointerMove(el, { pointerType: 'touch', clientX: 200, clientY: 41 })
      fireEvent.pointerMove(el, { pointerType: 'touch', clientX: 120, clientY: 42 })
      fireEvent.pointerUp(el, { pointerType: 'touch', clientX: 120, clientY: 42 })
    }
    swipeLeft('general')
    expect((await screen.findByTestId('row-menu-note')).textContent).toMatch(/default/)
    expect(client.patchConfig).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('row-menu')).toBeNull())
    swipeLeft('plans')
    await waitFor(() => expect(client.patchConfig).toHaveBeenCalledTimes(1))
  })

  it('Mark all read reads every thread that shows unread, once each, and is off when there is none', () => {
    const client = listClient({ unread: { plans: 2, ideas: 1, general: 0 } })
    mountList(client)
    fireEvent.click(screen.getByTestId('mark-all-read'))
    expect(client.markThreadRead).toHaveBeenCalledTimes(2)
    expect(client.markThreadRead).toHaveBeenCalledWith('plans', 77, { needConnection: true })
    expect(client.markThreadRead).toHaveBeenCalledWith('ideas', 77, { needConnection: true })
    cleanup()
    mountList(listClient({ unread: {} }))
    expect(screen.getByTestId('mark-all-read').hasAttribute('disabled')).toBe(true)
  })
})

const msg = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'agent',
    kind: 'text',
    text: 'The venue is booked for Saturday.',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as MessageT
function mountMsg(m: MessageT, client: TalosClient = setup({})) {
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MetaProvider store={createMetaStore()}>
          <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>,
  )
}
const withShare = (share: Platform['share']) => setPlatform({ ...webPlatform, share })

describe('Share on a message', () => {
  const open = async () => {
    fireEvent.contextMenu(screen.getByText('The venue is booked for Saturday.'))
    return await screen.findByTestId('msg-share')
  }
  it('hands the text to the share sheet and closes quietly when it was shared', async () => {
    const share = vi.fn(async () => 'shared' as const)
    withShare(share)
    mountMsg(msg())
    fireEvent.click(await open())
    await waitFor(() => expect(share).toHaveBeenCalledWith({ text: 'The venue is booked for Saturday.' }))
    await waitFor(() => expect(screen.queryByTestId('msg-share')).toBeNull())
  })
  it('"unsupported" (also what a cancelled sheet returns) closes with no error and no words', async () => {
    withShare(vi.fn(async () => 'unsupported' as const))
    mountMsg(msg())
    fireEvent.click(await open())
    await waitFor(() => expect(screen.queryByTestId('msg-share')).toBeNull())
    expect(screen.queryByText(/couldn.t|failed|error/i)).toBeNull()
  })
  it('"copied" says Copied', async () => {
    withShare(vi.fn(async () => 'copied' as const))
    mountMsg(msg())
    fireEvent.click(await open())
    expect(await screen.findByText('Copied')).toBeTruthy()
  })
  it('a share that throws (the clipboard fallback refused) says it could not', async () => {
    withShare(
      vi.fn(async () => {
        throw new Error('denied')
      }),
    )
    mountMsg(msg())
    fireEvent.click(await open())
    expect(await screen.findByText("Couldn't copy")).toBeTruthy()
  })
})

describe('review findings', () => {
  const swipeLeft = (id: string) => {
    const el = screen.getByTestId(`thread-row-${id}`)
    fireEvent.pointerDown(el, { pointerType: 'touch', clientX: 260, clientY: 40 })
    fireEvent.pointerMove(el, { pointerType: 'touch', clientX: 200, clientY: 41 })
    fireEvent.pointerMove(el, { pointerType: 'touch', clientX: 120, clientY: 42 })
    fireEvent.pointerUp(el, { pointerType: 'touch', clientX: 120, clientY: 42 })
  }

  it('a swipe-left Archive the Mac refuses opens the menu with the reason, never a silent snap-back', async () => {
    const client = listClient()
    client.patchConfig = vi.fn(async () => {
      throw new TalosClientError('config_conflict', 'stale')
    })
    mountList(client)
    swipeLeft('plans')
    const note = await screen.findByTestId('row-menu-note')
    expect(note.textContent).toMatch(/changed the threads at the same time/)
  })

  it('a failed swipe-left Archive from a timeout says what the error said', async () => {
    const client = listClient()
    client.patchConfig = vi.fn(async () => {
      throw new Error('Your Mac did not answer.')
    })
    mountList(client)
    swipeLeft('ideas')
    expect((await screen.findByTestId('row-menu-note')).textContent).toBe('Your Mac did not answer.')
  })

  it('offline, Mark read in the menu does not look done: the menu stays and says so', async () => {
    const client = listClient()
    client.markThreadRead = vi.fn(() => false)
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    fireEvent.click(await screen.findByTestId('row-read'))
    expect((await screen.findByTestId('row-menu-note')).textContent).toMatch(/relay/)
    expect(screen.getByTestId('row-menu')).toBeTruthy()
  })

  it('offline, Mark all read says so in the header', async () => {
    const client = listClient({ unread: { plans: 2, ideas: 1 } })
    client.markThreadRead = vi.fn(() => false)
    mountList(client)
    fireEvent.click(screen.getByTestId('mark-all-read'))
    expect((await screen.findByTestId('mark-all-read-note')).textContent).toMatch(/nothing was marked read/)
    client.markThreadRead = vi.fn(() => true)
    fireEvent.click(screen.getByTestId('mark-all-read'))
    await waitFor(() => expect(screen.queryByTestId('mark-all-read-note')).toBeNull())
  })

  it('Mark read on a device that has not caught up (lastSeq 0) sends the relay seq from ready, not 0', () => {
    const client = listClient()
    client.store.setState({ lastSeq: 0, serverSeq: 412 })
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    fireEvent.click(screen.getByTestId('row-read'))
    expect(client.markThreadRead).toHaveBeenCalledWith('plans', 412, { needConnection: true })
    cleanup()
    const c2 = listClient({ unread: { plans: 2, ideas: 1 } })
    c2.store.setState({ lastSeq: 0, serverSeq: 412 })
    mountList(c2)
    fireEvent.click(screen.getByTestId('mark-all-read'))
    expect(c2.markThreadRead).toHaveBeenCalledWith('plans', 412, { needConnection: true })
    expect(c2.markThreadRead).toHaveBeenCalledWith('ideas', 412, { needConnection: true })
  })

  it('Unmute gives a needs_you thread back needs_you, not all', async () => {
    const client = listClient()
    const plans = T('plans', { order: 2, notify: 'needs_you' })
    client.store.setState((s) => ({ ...s, threads: s.threads.map((t) => (t.id === 'plans' ? plans : t)) }))
    mountList(client)
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    fireEvent.click(await screen.findByTestId('row-mute'))
    await waitFor(() => expect(client.patchConfig).toHaveBeenCalledTimes(1))
    const first = (client.patchConfig as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      threads: Array<{ id: string; notify: string }>
    }
    expect(first.threads.find((t) => t.id === 'plans')?.notify).toBe('off')
    // the Mac applied it
    client.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === 'plans' ? { ...t, notify: 'off' as const } : t)),
    }))
    await waitFor(() => expect(screen.queryByTestId('row-menu')).toBeNull())
    fireEvent.contextMenu(screen.getByTestId('thread-row-plans'))
    const mute = await screen.findByTestId('row-mute')
    expect(mute.textContent).toBe('Unmute')
    fireEvent.click(mute)
    await waitFor(() => expect(client.patchConfig).toHaveBeenCalledTimes(2))
    const second = (client.patchConfig as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as {
      threads: Array<{ id: string; notify: string }>
    }
    expect(second.threads.find((t) => t.id === 'plans')?.notify).toBe('needs_you')
  })
})

describe('D38 the row line', () => {
  const lost = (over: Partial<MessageT> = {}) =>
    msg({ author: 'owner', text: 'my long words', receipt: 'not_delivered', ...over })
  it('says plainly that it did not reach the agent, shows no Sent tick, and offers Edit and Delete', () => {
    const client = setup({}) as unknown as TalosClient & { discardMessage: ReturnType<typeof vi.fn> }
    client.discardMessage = vi.fn(async () => {})
    mountMsg(lost(), client)
    expect(screen.getByTestId('send-not-delivered').textContent).toMatch(/did not reach your agent/)
    expect(screen.queryByRole('img', { name: 'Sent' })).toBeNull()
    expect(screen.getByTestId('send-failed-edit')).toBeTruthy()
    fireEvent.click(screen.getByTestId('send-failed-delete'))
    expect(client.discardMessage).toHaveBeenCalledWith(lost().id)
  })
  it('a voice note can only be deleted: there are no words to take back', () => {
    const client = setup({}) as unknown as TalosClient & { discardMessage: ReturnType<typeof vi.fn> }
    client.discardMessage = vi.fn(async () => {})
    mountMsg(lost({ kind: 'voice_note', text: undefined }), client)
    expect(screen.getByTestId('send-not-delivered').textContent).toMatch(/voice note did not reach your agent/)
    expect(screen.queryByTestId('send-failed-edit')).toBeNull()
    expect(screen.getByTestId('send-failed-delete')).toBeTruthy()
  })
})

describe('D38 Edit on a lost message with a file', () => {
  it('the file comes back as an error chip that says to attach it again, never a ready one', async () => {
    const client = setup({}) as unknown as TalosClient & { discardMessage: ReturnType<typeof vi.fn> }
    client.discardMessage = vi.fn(async () => {})
    const photo = { media_id: 'md_gone', name: 'photo.jpg', mime: 'image/jpeg', size: 10 } as never
    mountMsg(
      msg({ author: 'owner', text: 'see this', receipt: 'not_delivered', attachments: [photo], kind: 'text' }),
      client,
    )
    fireEvent.click(screen.getByTestId('send-failed-edit'))
    await waitFor(() => expect(useComposerStore.getState().chips.general?.length).toBe(1))
    const chip = useComposerStore.getState().chips.general?.[0]
    expect(chip?.state).toBe('error')
    expect(chip?.ref).toBeUndefined()
    expect(chip?.note).toMatch(/Attach it again/)
  })
})
