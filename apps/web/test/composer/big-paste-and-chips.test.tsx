// Package C (D5, D31): a paste over the message cap is stopped in the box and offered as a text file; attachment chips
// live per thread (a thread switch keeps them), show percent, cancel an upload in flight and retry a failed one.
import type { AttachmentRefT } from '@talos-app/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { MAX_MESSAGE_CHARS } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

beforeEach(() => useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {} }))
afterEach(cleanup)

const mount = (threadId: string, client = setup({}), storage = createMemoryStorage()) =>
  render(
    <StorageProvider storage={storage}>
      <ClientProvider client={client}>
        <Composer threadId={threadId} placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement
const paste = (n: number) => fireEvent.change(box(), { target: { value: 'x'.repeat(n) } })
const ref = (name: string): AttachmentRefT =>
  ({
    media_id: `md_${name}`,
    kind: 'file',
    role: 'attachment',
    mime: 'text/plain',
    name,
    size: 1,
    sha256: '0'.repeat(64),
  }) as AttachmentRefT

describe('D5 big paste', () => {
  it('over the cap: says so, sends nothing, keeps the text', async () => {
    const client = setup({})
    const send = vi.spyOn(client, 'sendMessage')
    mount('general', client)
    paste(MAX_MESSAGE_CHARS + 1)
    expect(screen.getByTestId('too-long').textContent).toContain('32,001')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.keyDown(box(), { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 30))
    expect(send).not.toHaveBeenCalled()
    expect(box().value.length).toBe(MAX_MESSAGE_CHARS + 1)
  })

  it('exactly at the cap is an ordinary message', async () => {
    const client = setup({})
    const send = vi.spyOn(client, 'sendMessage')
    mount('general', client)
    paste(MAX_MESSAGE_CHARS)
    expect(screen.queryByTestId('too-long')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('"Send as a text file" uploads message.txt with the full text, then clears the box', async () => {
    const client = setup({})
    const up = vi.spyOn(client, 'uploadMedia')
    mount('general', client)
    paste(300_000)
    fireEvent.click(screen.getByTestId('send-as-file'))
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1))
    const file = up.mock.calls[0]?.[0] as File
    expect(file.name).toBe('message.txt')
    expect(file.size).toBe(300_000)
    await waitFor(() => expect(box().value).toBe(''))
    expect(screen.queryByTestId('too-long')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()) // the file is ready to go
  })

  it('if that upload fails, the text is NOT cleared', async () => {
    const client = setup({})
    vi.spyOn(client, 'uploadMedia').mockRejectedValue(new Error('down'))
    mount('general', client)
    paste(40_000)
    fireEvent.click(screen.getByTestId('send-as-file'))
    await waitFor(() => expect(screen.getByTestId('chip').getAttribute('data-state')).toBe('error'))
    expect(box().value.length).toBe(40_000)
  })

  it('a client that refuses (too_large) gives the words back with the reason', async () => {
    const { TalosClientError } = await import('../../src/lib/client.ts')
    const client = setup({})
    vi.spyOn(client, 'sendMessage').mockRejectedValue(new TalosClientError('too_large', 'Nope, too long.'))
    mount('general', client)
    fireEvent.change(box(), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Nope, too long.'))
    expect(box().value).toBe('hello')
  })
})

describe('D31 attachment chips', () => {
  it('survive leaving the thread and coming back', async () => {
    const client = setup({})
    vi.spyOn(client, 'uploadMedia').mockImplementation(async (_b, m) => ref(m.name))
    const first = mount('general', client)
    fireEvent.change(screen.getByTestId('pick-files'), {
      target: { files: [new File(['hi'], 'notes.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(screen.getByTestId('chip').getAttribute('data-state')).toBe('ready'))
    first.unmount()
    mount('errands', client)
    expect(screen.queryByTestId('chip')).toBeNull() // another thread has its own
    cleanup()
    mount('general', client)
    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('an upload that finishes while the owner is in another thread still lands in its own thread', async () => {
    const client = setup({})
    let done: (r: AttachmentRefT) => void = () => {}
    vi.spyOn(client, 'uploadMedia').mockImplementation(() => new Promise((r) => (done = r)))
    const first = mount('general', client)
    fireEvent.change(screen.getByTestId('pick-files'), { target: { files: [new File(['hi'], 'slow.txt')] } })
    await waitFor(() => expect(screen.getByTestId('chip').getAttribute('data-state')).toBe('uploading'))
    first.unmount()
    mount('errands', client)
    done(ref('slow.txt'))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('chip')).toBeNull()
    expect(useComposerStore.getState().chips.general?.[0]?.state).toBe('ready')
    expect(useComposerStore.getState().chips.errands ?? []).toHaveLength(0)
  })

  it('shows percent while uploading', async () => {
    const client = setup({})
    let report: (f: number) => void = () => {}
    vi.spyOn(client, 'uploadMedia').mockImplementation((_b, m) => {
      report = m.onProgress ?? report
      return new Promise(() => {})
    })
    mount('general', client)
    fireEvent.change(screen.getByTestId('pick-files'), { target: { files: [new File(['hi'], 'big.zip')] } })
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy())
    report(0.42)
    await waitFor(() => expect(screen.getByTestId('chip-status').textContent).toBe('Uploading 42%'))
  })

  it('Cancel aborts the request in flight and drops the chip', async () => {
    const client = setup({})
    let signal: AbortSignal | undefined
    vi.spyOn(client, 'uploadMedia').mockImplementation((_b, m) => {
      signal = m.signal
      return new Promise(() => {})
    })
    mount('general', client)
    fireEvent.change(screen.getByTestId('pick-files'), { target: { files: [new File(['hi'], 'big.zip')] } })
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of big.zip' }))
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByTestId('chip')).toBeNull()
  })

  it('Retry re-uploads a failed file and it becomes ready', async () => {
    const client = setup({})
    const up = vi
      .spyOn(client, 'uploadMedia')
      .mockRejectedValueOnce(new Error('flaky'))
      .mockImplementation(async (_b, m) => ref(m.name))
    mount('general', client)
    fireEvent.change(screen.getByTestId('pick-files'), { target: { files: [new File(['hi'], 'a.txt')] } })
    await waitFor(() => expect(screen.getByTestId('chip').getAttribute('data-state')).toBe('error'))
    fireEvent.click(screen.getByTestId('chip-retry'))
    await waitFor(() => expect(screen.getByTestId('chip').getAttribute('data-state')).toBe('ready'))
    expect(up).toHaveBeenCalledTimes(2)
    expect(screen.getAllByTestId('chip')).toHaveLength(1)
  })
})
