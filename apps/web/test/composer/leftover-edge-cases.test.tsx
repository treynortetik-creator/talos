// Edge cases around a send: chips attached while it is in flight, a typed command that fails locally, and a value
// written onto an unfocused box with no event.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { type Chip, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

afterEach(() => {
  cleanup()
  useComposerStore.setState({ chips: {} })
})

const ref = (id: string) => ({ id, name: `${id}.txt`, mime: 'text/plain', size: 1 }) as never
const chip = (key: string): Chip => ({ key, name: `${key}.txt`, state: 'ready', ref: ref(key) })
const storageRefused = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')

function mount() {
  const client = createFakeClient()
  let fail: (e: Error) => void = () => {}
  const send = vi.spyOn(client, 'sendMessage').mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>
    </StorageProvider>,
  )
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
  return { box, send, fail: (e: Error) => fail(e) }
}

describe('a failed send and attachments', () => {
  it('keeps a chip attached while the send was in flight', async () => {
    const { box, fail } = mount()
    act(() => useComposerStore.getState().setChips('general', [chip('old')]))
    await userEvent.type(box, 'words')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    act(() => useComposerStore.getState().setChips('general', (c) => [...c, chip('new')]))
    fail(storageRefused())
    await screen.findByText("Couldn't send. Your message is still here.")
    const keys = (useComposerStore.getState().chips.general ?? []).map((c) => c.key).sort()
    expect(keys).toEqual(['new', 'old'])
  })
})

describe('a value written with no event', () => {
  it('on an unfocused box does not come back after Send', async () => {
    const { box, send } = mount()
    await userEvent.type(box, 'abc')
    box.blur()
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    set?.call(box, 'silent words') // a tool writes the element directly: no event, React still holds 'abc'
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'silent words' }))
    await new Promise((r) => setTimeout(r, 450)) // two polls of the focused box
    expect(box.value).toBe('')
  })
})

describe('a failed send after leaving the thread', () => {
  it('gives the words back and says so when the owner returns', async () => {
    const storage = createMemoryStorage()
    const client = createFakeClient()
    let fail: (e: Error) => void = () => {}
    vi.spyOn(client, 'sendMessage').mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const ui = (
      <StorageProvider storage={storage}>
        <ClientProvider client={client}>
          <Composer threadId="general" />
        </ClientProvider>
      </StorageProvider>
    )
    const first = render(ui)
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'lost words')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    first.unmount() // switched to another thread while the send was in flight
    await act(async () => {
      fail(storageRefused())
      await new Promise((r) => setTimeout(r, 30))
    })
    render(ui) // back on the thread
    const box = (await screen.findByRole('textbox', { name: 'Message' })) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe('lost words'))
    expect(await screen.findByText("Couldn't send. Your message is still here.")).toBeTruthy()
  })
})
