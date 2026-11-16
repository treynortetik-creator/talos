// "Undo to here" in an owner message's menu: shown only when the relay says undo/1 and the message carries its undo
// point; it asks the Mac once (a signed undo.request) and then says nothing (the card comes) or the Mac's why, under
// the menu. Too large and not saved are said, not offered. Closing the menu ends the wait.
import { type MessageT, UNDO_FEATURE } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider, TalosClientError } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const msg = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'owner',
    kind: 'text',
    text: 'tidy the readme please',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    undo: { state: 'ready' },
    ...over,
  }) as MessageT

function mount(m: MessageT, o: { undo?: boolean } = {}) {
  const client = setup({}) as FakeClient
  client.store.setState((s) => ({
    ...s,
    relayFeatures: [...s.relayFeatures, ...(o.undo === false ? [] : [UNDO_FEATURE])],
  }))
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MetaProvider store={createMetaStore()}>
          <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}
const openMenu = () => fireEvent.click(screen.getByTestId('msg-actions'))
const asked = (client: FakeClient) => client.sent.filter((f) => f.type === 'undo.request')

describe('Undo to here', () => {
  it('a ready point: asks the Mac once, for this message, and closes when the card is on its way', async () => {
    const client = mount(msg())
    client.sendOwnerFrame = vi.fn(async () => {})
    openMenu()
    fireEvent.click(await screen.findByTestId('msg-undo'))
    await waitFor(() => expect(client.sendOwnerFrame).toHaveBeenCalledTimes(1))
    const frame = vi.mocked(client.sendOwnerFrame).mock.calls[0]?.[0] as Record<string, unknown>
    expect(frame).toMatchObject({ type: 'undo.request', thread_id: 'general', message_id: msg().id })
    act(() =>
      client.emit('undo.request.result', {
        control_id: frame.control_id as string,
        ok: true,
        text: '',
        at: msg().created_at,
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('msg-undo')).toBeNull()) // the menu closed
  })

  it("the Mac's refusal is a line under the menu, never a line in the thread", async () => {
    const client = mount(msg())
    const before = client.store.getState().messages.general?.length ?? 0
    openMenu()
    fireEvent.click(await screen.findByTestId('msg-undo'))
    // the demo client answers as a Mac with nothing to undo
    await waitFor(() =>
      expect(screen.getByTestId('msg-undo-said').textContent).toBe('Nothing to undo: the files already match.'),
    )
    expect(asked(client)).toHaveLength(1)
    expect(client.store.getState().messages.general?.length ?? 0).toBe(before)
  })

  it('too large, or not saved: said, not offered', async () => {
    mount(msg({ undo: { state: 'too_large' } }))
    openMenu()
    expect((await screen.findByTestId('msg-undo-off')).textContent).toBe('Too large to undo')
    expect(screen.queryByTestId('msg-undo')).toBeNull()
    cleanup()
    mount(msg({ undo: { state: 'not_saved' } }))
    openMenu()
    expect((await screen.findByTestId('msg-undo-off')).textContent).toBe('No undo point was saved')
  })

  it('no item: the relay without undo/1, a message with no undo point, or the agent', async () => {
    for (const [m, o] of [
      [msg(), { undo: false }],
      [msg({ undo: undefined }), {}],
      [msg({ author: 'agent' }), {}],
    ] as const) {
      mount(m, o)
      openMenu()
      await screen.findByTestId('msg-copy')
      expect(screen.queryByTestId('msg-undo')).toBeNull()
      expect(screen.queryByTestId('msg-undo-off')).toBeNull()
      cleanup()
    }
  })

  it('the Mac offline: says so, and nothing is put back', async () => {
    const client = mount(msg())
    client.sendOwnerFrame = vi.fn(async () => {
      throw new TalosClientError('mac_offline', 'your Mac is offline')
    })
    openMenu()
    fireEvent.click(await screen.findByTestId('msg-undo'))
    await waitFor(() => expect(screen.getByTestId('msg-undo-said').textContent).toMatch(/is offline/))
  })

  it('closing the menu ends the wait: the listener goes, and no timer is left', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const client = mount(msg())
    client.sendOwnerFrame = vi.fn(async () => {})
    const offs: Array<ReturnType<typeof vi.fn>> = []
    const onFrame = client.onFrame.bind(client)
    client.onFrame = ((type: string, l: (f: never) => void) => {
      const off = vi.fn(onFrame(type as never, l))
      if (type === 'undo.request.result') offs.push(off)
      return off
    }) as typeof client.onFrame
    openMenu()
    fireEvent.click(await screen.findByTestId('msg-undo'))
    await waitFor(() => expect(client.sendOwnerFrame).toHaveBeenCalledTimes(1))
    expect(offs).toHaveLength(1)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('msg-undo')).toBeNull())
    expect(offs[0]).toHaveBeenCalledTimes(1) // no longer listening: a late answer finds nobody
    expect(vi.getTimerCount()).toBe(0)
  })

  it('no answer in 30 s: says so, and that a late card is still good', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const client = mount(msg())
    client.sendOwnerFrame = vi.fn(async () => {})
    openMenu()
    fireEvent.click(await screen.findByTestId('msg-undo'))
    await waitFor(() => expect(client.sendOwnerFrame).toHaveBeenCalledTimes(1))
    act(() => vi.advanceTimersByTime(30_000))
    await waitFor(() =>
      expect(screen.getByTestId('msg-undo-said').textContent).toMatch(/has not answered yet\. If an undo card comes/),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it("an answer for another request is not this one's; a second click while asking sends nothing more", async () => {
    const client = mount(msg())
    client.sendOwnerFrame = vi.fn(async () => {})
    openMenu()
    const item = await screen.findByTestId('msg-undo')
    fireEvent.click(item)
    fireEvent.click(item)
    await waitFor(() => expect(client.sendOwnerFrame).toHaveBeenCalledTimes(1))
    act(() =>
      client.emit('undo.request.result', {
        control_id: '01JBF3V7Q8K2M4N6P8R0S1T2U9',
        ok: false,
        text: 'not yours',
        at: msg().created_at,
      }),
    )
    expect(screen.getByTestId('msg-undo').textContent).toBe('Asking…')
    expect(screen.getByTestId('msg-undo-said').textContent).toBe('')
  })

  it('a refusal with no words still says something', async () => {
    const client = mount(msg())
    client.sendOwnerFrame = vi.fn(async () => {})
    openMenu()
    fireEvent.click(await screen.findByTestId('msg-undo'))
    await waitFor(() => expect(client.sendOwnerFrame).toHaveBeenCalledTimes(1))
    const frame = vi.mocked(client.sendOwnerFrame).mock.calls[0]?.[0] as Record<string, unknown>
    act(() =>
      client.emit('undo.request.result', {
        control_id: frame.control_id as string,
        ok: false,
        text: '',
        at: msg().created_at,
      }),
    )
    await waitFor(() => expect(screen.getByTestId('msg-undo-said').textContent).toMatch(/couldn't undo that/))
  })
})
