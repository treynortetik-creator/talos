// @vitest-environment jsdom
// The HTML page card runs its page at once on every engine (owner, 2026-11-18: no Run page tap): the sandboxed frame is
// there with no tap on Chromium and on WebKit, and Expand opens the full-screen page. Real component, real media gate (fetch
// stubbed). On Chromium the focus guard is what keeps the typing (frame-focus-guard tests, relay/frame-guards.spec.ts).
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

describe('HtmlPageCard runs the page at once, on every engine', () => {
  it.each([
    ['Chromium', CHROME],
    ['WebKit', SAFARI],
  ])(
    '%s: the sandboxed frame is there with no tap, and there is no Run button or "not started" notice',
    async (_n, agent) => {
      ua(agent)
      await show()
      const frame = document.querySelector('iframe')
      expect(frame?.getAttribute('src')).toBe(`/media/${att.media_id}/page?c=2`)
      expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
      expect(screen.queryByRole('button', { name: 'Run report.html' })).toBeNull()
      expect(screen.queryByText(/has not started/)).toBeNull()
    },
  )

  it('Chromium: Expand opens the full-screen page', async () => {
    ua(CHROME)
    await show()
    fireEvent.click(screen.getByRole('button', { name: /Expand report.html/ }))
    expect(screen.getByTitle('report.html (full screen)')).toBeTruthy()
  })
})

describe('Open in new tab sits on the card, beside Expand, without expanding', () => {
  it.each([
    ['Chromium', CHROME],
    ['WebKit', SAFARI],
  ])('%s: the link is there at once, to the same sandboxed page, opened with no opener', async (_name, agent) => {
    ua(agent)
    await show()
    const link = screen.getByRole('link', { name: 'Open report.html in a new tab' })
    expect(link.getAttribute('href')).toBe(`/media/${att.media_id}/page?c=2`)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    // in the caption, next to Expand, before the page is expanded
    const expand = screen.getByRole('button', { name: 'Expand report.html to full screen' })
    expect(link.closest('figcaption')).toBe(expand.closest('figcaption'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
