// @vitest-environment jsdom
// The HTML page card on a Chromium engine: no iframe (so no script) until the owner taps Run page; on WebKit the frame is
// there at once. Expand is a tap, so the full-screen page runs either way. Real component, real media gate (fetch stubbed).
import { type AttachmentRefT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HtmlPageCard } from '../../src/features/threads/Attachments.tsx'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'

const CHROME =
  'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'
const att: AttachmentRefT = {
  media_id: newId('md'),
  kind: 'html',
  role: 'attachment',
  mime: 'text/html',
  name: 'report.html',
  size: 2048,
  sha256: 'a'.repeat(64),
}
const client = { onFrame: () => () => {}, fetchMedia: () => {} } as unknown as TalosClient
const ua = (v: string) => Object.defineProperty(navigator, 'userAgent', { value: v, configurable: true })

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  )
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  ua('')
})

async function show() {
  render(
    <ClientProvider client={client}>
      <HtmlPageCard att={att} />
    </ClientProvider>,
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

describe('HtmlPageCard waits for a tap on Chromium only', () => {
  it('Chromium: a Run button and no iframe; the tap mounts the sandboxed frame and focus lands on Expand', async () => {
    ua(CHROME)
    await show()
    expect(document.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run report.html' }))
    const frame = document.querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe(`/media/${att.media_id}/page?c=2`)
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(screen.queryByRole('button', { name: 'Run report.html' })).toBeNull()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Expand report.html/ }))
  })

  it('Chromium: Expand is a tap, so the full-screen page runs without Run', async () => {
    ua(CHROME)
    await show()
    fireEvent.click(screen.getByRole('button', { name: /Expand report.html/ }))
    expect(screen.getByTitle('report.html (full screen)')).toBeTruthy()
  })

  it('WebKit: the frame is there at once and there is no Run button', async () => {
    ua(SAFARI)
    await show()
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`/media/${att.media_id}/page?c=2`)
    expect(screen.queryByRole('button', { name: 'Run report.html' })).toBeNull()
  })
})
