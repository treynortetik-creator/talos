// A send that fails after the owner left the thread: the words and attachments wait with the failure and come back in
// the thread's box, whatever else was put there in the meantime.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { type Chip, prefillComposer, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

afterEach(() => {
  cleanup()
  useComposerStore.setState({ chips: {}, prefill: {}, sendFailure: {} })
})

const ref = (id: string) => ({ id, name: `${id}.txt`, mime: 'text/plain', size: 1 }) as never
const chip = (key: string): Chip => ({ key, name: `${key}.txt`, state: 'ready', ref: ref(key) })
const storageRefused = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')
const REFUSED_LINE = "Couldn't send. Your message is still here."

/** Every send stays in flight until the test fails it, in the order the test chooses. */
function setup() {
  const client = createFakeClient()
  const rejects: Array<(e: Error) => void> = []
  vi.spyOn(client, 'sendMessage').mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejects.push(reject)
      }),
  )
  const ui = (
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>
    </StorageProvider>
  )
  const textbox = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
  const failAll = () =>
    act(async () => {
      for (const reject of rejects) reject(storageRefused())
    })
  return { ui, textbox, failAll }
}
const send = () => userEvent.click(screen.getByRole('button', { name: 'Send' }))

describe('a failed send after leaving the thread', () => {
  it('puts the sent words first and newer typing after them', async () => {
    const { ui, textbox, failAll } = setup()
    const first = render(ui)
    await userEvent.type(textbox(), 'sent words')
    await send()
    first.unmount()
    render(ui) // back on the thread while the send is still in flight
    await userEvent.type(textbox(), 'newer words')
    await failAll()
    await waitFor(() => expect(textbox().value).toBe('sent words\n\nnewer words'))
    expect(await screen.findByText(REFUSED_LINE)).toBeTruthy()
  })

  it('keeps the words when another feature fills the box before the owner returns', async () => {
    const { ui, textbox, failAll } = setup()
    const first = render(ui)
    await userEvent.type(textbox(), 'sent words')
    await send()
    first.unmount()
    await failAll()
    act(() => prefillComposer('general', 're: some item')) // "Ask" on an inbox item, a schedule or Help
    render(ui)
    await waitFor(() => expect(textbox().value).toContain('sent words'))
    expect(textbox().value).toBe('sent words\n\nre: some item')
    expect(await screen.findByText(REFUSED_LINE)).toBeTruthy()
  })

  it('keeps both messages when two sends fail while the owner is away', async () => {
    const { ui, textbox, failAll } = setup()
    const first = render(ui)
    await userEvent.type(textbox(), 'first')
    await send()
    await userEvent.type(textbox(), 'second')
    await send()
    first.unmount()
    await failAll()
    render(ui)
    await waitFor(() => expect(textbox().value).toBe('first\n\nsecond'))
  })

  it('gives back the attachments that were sent with the words', async () => {
    const { ui, textbox, failAll } = setup()
    const first = render(ui)
    act(() => useComposerStore.getState().setChips('general', [chip('sent')]))
    await userEvent.type(textbox(), 'words')
    await send()
    first.unmount()
    expect(useComposerStore.getState().chips.general).toEqual([])
    await failAll()
    expect((useComposerStore.getState().chips.general ?? []).map((c) => c.key)).toEqual(['sent'])
  })

  it('merges the attachments added meanwhile with the ones that were sent', async () => {
    const { ui, textbox, failAll } = setup()
    const first = render(ui)
    act(() => useComposerStore.getState().setChips('general', [chip('sent')]))
    await userEvent.type(textbox(), 'words')
    await send()
    first.unmount()
    act(() => useComposerStore.getState().setChips('general', (c) => [...c, chip('added')]))
    await failAll()
    expect((useComposerStore.getState().chips.general ?? []).map((c) => c.key).sort()).toEqual(['added', 'sent'])
  })
})
