// @vitest-environment jsdom
// A stored name with no extension (older attachments, or a title the agent gave) must still download as the file it is:
// the download attribute carries the extension the mime calls for. Real FileChip and real video fallback.
import { type AttachmentRefT, newId } from '@talos-app/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileChip, VideoAttachment } from '../../src/features/threads/Attachments.tsx'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'

const mk = (over: Partial<AttachmentRefT>): AttachmentRefT => ({
  media_id: newId('md'),
  kind: 'file',
  role: 'attachment',
  mime: 'text/html',
  name: 'WaterCooler Go full send (v2)',
  size: 2048,
  sha256: 'a'.repeat(64),
  ...over,
})
const client = { onFrame: () => () => {}, fetchMedia: () => {} } as unknown as TalosClient

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function show(el: ReactElement) {
  render(<ClientProvider client={client}>{el}</ClientProvider>)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

describe('download names keep an extension', () => {
  it('an html attachment named without an extension downloads as .html', async () => {
    await show(<FileChip att={mk({})} />)
    expect(screen.getByTestId('attachment-share').getAttribute('download')).toBe('WaterCooler Go full send (v2).html')
  })

  it('the undecodable-video fallback link also gets the extension', async () => {
    await show(<VideoAttachment att={mk({ kind: 'video', mime: 'video/mp4', name: 'clip' })} />)
    const v = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(v, 'error', { value: { code: 4 } })
    await act(async () => {
      v.dispatchEvent(new Event('error'))
    })
    const link = screen.getByTestId('video-undecodable').querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('download')).toBe('clip.mp4')
  })
})
