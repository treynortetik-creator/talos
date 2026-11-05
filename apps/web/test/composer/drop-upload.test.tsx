// Drop files on the chat -> the composer's attach flow; upload failures say why; paste image still attaches.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { DropZone } from '../../src/features/composer/DropZone.tsx'
import { TOO_BIG, uploadFailureNote } from '../../src/features/composer/uploadError.ts'
import { ClientProvider, TalosClientError } from '../../src/lib/client.ts'
import { HttpError } from '../../src/lib/http.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const file = (name: string, type = 'text/plain', body = 'x') => new File([body], name, { type })
const dt = (files: File[], types: string[] = ['Files']) => ({ types, files, items: [], dropEffect: 'none' })

function mount(client = setup({})) {
  const view = render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <DropZone threadId="t1" data-testid="zone">
          <Composer threadId="t1" placeholder="Message" />
        </DropZone>
      </ClientProvider>
    </StorageProvider>,
  )
  return { client, ...view }
}

describe('drop to attach', () => {
  it('shows an overlay while files hover and attaches every dropped file as a chip', async () => {
    const { client } = mount()
    const up = vi.spyOn(client, 'uploadMedia')
    const zone = screen.getByTestId('zone')
    fireEvent.dragEnter(zone, { dataTransfer: dt([]) })
    expect(screen.getByTestId('drop-overlay')).toBeTruthy()
    fireEvent.drop(zone, { dataTransfer: dt([file('a.txt'), file('b.png', 'image/png')]) })
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
    await waitFor(() => expect(up).toHaveBeenCalledTimes(2))
    expect(screen.getByText('a.txt')).toBeTruthy()
    expect(screen.getByText('b.png')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
  })

  it('ignores drags that carry no files (text, links)', () => {
    mount()
    fireEvent.dragEnter(screen.getByTestId('zone'), { dataTransfer: dt([], ['text/plain']) })
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
  })

  it('overlay stays until the last nested dragleave', () => {
    mount()
    const zone = screen.getByTestId('zone')
    fireEvent.dragEnter(zone, { dataTransfer: dt([]) })
    fireEvent.dragEnter(screen.getByLabelText('Message'), { dataTransfer: dt([]) })
    fireEvent.dragLeave(screen.getByLabelText('Message'), { dataTransfer: dt([]) })
    expect(screen.getByTestId('drop-overlay')).toBeTruthy()
    fireEvent.dragLeave(zone, { dataTransfer: dt([]) })
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
  })

  it('does nothing on touch devices', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q }) as MediaQueryList)
    mount()
    fireEvent.dragEnter(screen.getByTestId('zone'), { dataTransfer: dt([]) })
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
  })

  it('applies the same size limit as the + button', async () => {
    mount()
    const big = file('huge.bin', 'application/octet-stream')
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 })
    fireEvent.drop(screen.getByTestId('zone'), { dataTransfer: dt([big]) })
    expect(await screen.findByText(TOO_BIG)).toBeTruthy()
  })

  it('shows the real reason when the upload is refused', async () => {
    const client = setup({})
    client.uploadMedia = async () => {
      throw new HttpError(507, undefined, { error: 'disk full' })
    }
    mount(client)
    fireEvent.drop(screen.getByTestId('zone'), { dataTransfer: dt([file('a.txt')]) })
    expect(await screen.findByText("Couldn't upload: disk full")).toBeTruthy()
  })

  it('still attaches a pasted image', async () => {
    const { client } = mount()
    const up = vi.spyOn(client, 'uploadMedia')
    fireEvent.paste(screen.getByLabelText('Message'), {
      clipboardData: { files: [file('shot.png', 'image/png')], getData: () => '' },
    })
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1))
  })
})

describe('uploadFailureNote', () => {
  it('maps size, limit and disk failures, and passes a bridge reason through', () => {
    expect(uploadFailureNote(new TalosClientError('too_large'))).toBe(TOO_BIG)
    expect(uploadFailureNote(new HttpError(413))).toBe(TOO_BIG)
    expect(uploadFailureNote(new HttpError(429))).toMatch(/limit/i)
    expect(uploadFailureNote(new HttpError(500, undefined, { error: 'no_space_left_on_device' }))).toBe(
      "Couldn't upload: the Mac is out of disk space",
    )
    expect(uploadFailureNote(new HttpError(500, undefined, { message: 'ENOSPC: disk is full' }))).toBe(
      "Couldn't upload: ENOSPC: disk is full",
    )
    expect(uploadFailureNote(new HttpError(507))).toMatch(/disk/i)
    expect(uploadFailureNote(new HttpError(502))).toMatch(/server error 502/)
    expect(uploadFailureNote(new TypeError('Failed to fetch'))).toBeUndefined()
  })
})

describe('upload errors read as plain words, never a raw code', () => {
  it('turns the relay codes into a reason after "Couldn\'t upload:"', () => {
    for (const error of ['csrf_content_type', 'csrf_header', 'csrf_origin']) {
      const note = uploadFailureNote(new HttpError(403, undefined, { error })) as string
      expect(note).toMatch(/^Couldn't upload: .*reload the app/)
      expect(note).not.toMatch(/csrf|_/)
    }
    expect(uploadFailureNote(new HttpError(415, undefined, { error: 'file_type_not_allowed' }))).toBe(
      "Couldn't upload: this file type isn't supported",
    )
    expect(uploadFailureNote(new HttpError(401, undefined, { error: 'unauthorized' }))).toMatch(/^Couldn't upload: /)
  })

  it('an unknown code is not shown: the row falls back to plain "Couldn\'t upload"', () => {
    expect(uploadFailureNote(new HttpError(403, undefined, { error: 'some_new_server_code' }))).toBeUndefined()
    expect(uploadFailureNote(new TalosClientError('internal'))).toBeUndefined()
  })
})
