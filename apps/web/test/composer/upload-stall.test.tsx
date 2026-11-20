// An attachment upload that never answers must not lock the message box (the owner, 2026-11-20 03:22: text and a photo in
// the box, no Send, Enter did nothing, a reload fixed it). An upload with no progress for UPLOAD_STALL_MS gives up: the chip
// says it could not upload and offers Retry and Remove, and the words can be sent. While an upload runs, Enter and Send say
// why nothing is sent yet instead of doing nothing.
import type { AttachmentRefT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { answerWaitMs, UPLOAD_STALL_MS, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

beforeEach(() => {
  useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {} })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const mount = (client = setup({})) =>
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="general" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement
const send = () => screen.getByRole('button', { name: 'Send' })
const chipState = () => screen.getByTestId('chip').getAttribute('data-state')
const attach = (name = 'photo.png') => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([new Uint8Array(2048)], name, { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })
}
const ref = {
  media_id: 'md_1',
  kind: 'image',
  role: 'attachment',
  mime: 'image/png',
  name: 'photo.png',
  size: 2048,
  sha256: '0'.repeat(64),
} as AttachmentRefT
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

describe('an upload that never answers', () => {
  it('gives up after the stall time: the chip says so with Retry, and the words can be sent', async () => {
    const client = setup({})
    // never answers, and ignores its abort signal
    vi.spyOn(client, 'uploadMedia').mockImplementation(() => new Promise<AttachmentRefT>(() => {}))
    const sent = vi.spyOn(client, 'sendMessage')
    mount(client)
    fireEvent.change(box(), { target: { value: 'look at this' } })
    attach()
    await advance(10)
    expect(chipState()).toBe('uploading')
    expect(send().getAttribute('aria-disabled')).toBe('true')
    await advance(UPLOAD_STALL_MS + 100)
    expect(chipState()).toBe('error')
    expect(screen.getByTestId('chip-status').textContent).toMatch(/no answer/i)
    expect(screen.getByTestId('chip-retry')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove photo.png' })).toBeTruthy()
    // the box is not locked: Send is on and sends the words (the failed photo stays, with its line)
    expect(send().getAttribute('aria-disabled')).toBeNull()
    fireEvent.keyDown(box(), { key: 'Enter' })
    await advance(10)
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('an upload that keeps making progress is not cut off, however long it takes', async () => {
    const client = setup({})
    let progress: ((f: number) => void) | undefined
    let done: ((r: AttachmentRefT) => void) | undefined
    vi.spyOn(client, 'uploadMedia').mockImplementation(
      (_b, meta) =>
        new Promise<AttachmentRefT>((resolve) => {
          progress = meta.onProgress
          done = resolve
        }),
    )
    mount(client)
    attach()
    for (let i = 1; i <= 5; i++) {
      await advance(UPLOAD_STALL_MS - 1000)
      act(() => progress?.(i / 10))
    }
    expect(chipState()).toBe('uploading')
    act(() => done?.(ref))
    await advance(10)
    expect(chipState()).toBe('ready')
  })

  it('at 100% the answer gets longer: bytes the phone has handed over may still be on their way on a slow uplink', async () => {
    const client = setup({})
    let progress: ((f: number) => void) | undefined
    vi.spyOn(client, 'uploadMedia').mockImplementation(
      (_b, meta) =>
        new Promise<AttachmentRefT>(() => {
          progress = meta.onProgress
        }),
    )
    mount(client)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const big = new File([new Uint8Array(4 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [big] } })
    await advance(10)
    act(() => progress?.(1))
    await advance(UPLOAD_STALL_MS * 2)
    expect(chipState()).toBe('uploading') // still within the answer's allowance for 4 MB
    await advance(answerWaitMs(big.size))
    expect(chipState()).toBe('error') // but not forever
  })

  it('a retry after a stall starts a fresh wait, and can succeed', async () => {
    const client = setup({})
    const up = vi.spyOn(client, 'uploadMedia').mockImplementationOnce(() => new Promise<AttachmentRefT>(() => {}))
    up.mockResolvedValueOnce(ref)
    mount(client)
    attach()
    await advance(UPLOAD_STALL_MS + 100)
    expect(chipState()).toBe('error')
    fireEvent.click(screen.getByTestId('chip-retry'))
    await advance(10)
    expect(chipState()).toBe('ready')
  })
})

describe('while an upload runs', () => {
  it('Enter says it is waiting for the upload and sends nothing', async () => {
    const client = setup({})
    vi.spyOn(client, 'uploadMedia').mockImplementation(() => new Promise<AttachmentRefT>(() => {}))
    const sent = vi.spyOn(client, 'sendMessage')
    mount(client)
    fireEvent.change(box(), { target: { value: 'with a photo' } })
    attach()
    await advance(10)
    fireEvent.keyDown(box(), { key: 'Enter' })
    await advance(10)
    expect(sent).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-note').textContent).toMatch(/waiting for the upload/i)
    expect(box().value).toBe('with a photo')
  })

  it('a tap on Send says the same, and Send shows it is waiting', async () => {
    const client = setup({})
    vi.spyOn(client, 'uploadMedia').mockImplementation(() => new Promise<AttachmentRefT>(() => {}))
    const sent = vi.spyOn(client, 'sendMessage')
    mount(client)
    fireEvent.change(box(), { target: { value: 'with a photo' } })
    attach()
    await advance(10)
    expect(send().getAttribute('title')).toBe('Waiting for the upload')
    expect(send().getAttribute('data-waiting')).toBe('true')
    fireEvent.click(send())
    await advance(10)
    expect(sent).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-note').textContent).toMatch(/waiting for the upload/i)
  })

  it('an empty box with no upload: a tap on the dimmed Send shows no note', async () => {
    mount()
    fireEvent.click(send())
    await advance(10)
    expect(screen.queryByTestId('composer-note')).toBeNull()
  })
})
