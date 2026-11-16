// The page card in the chat (org pages, phase 1), drawn for a message's `page` (page_id, title, version). The message is not
// trusted for anything but which page to ask about (a thread session can mint it): the card shows only once GET /api/pages/:id
// says the page is this thread's, with the relay's title, version count and share, never the message's. A 404 says the page
// was deleted; a version the page no longer lists is called older; Open shows the current page in the sandboxed frame from
// /p/<id>/frame; Share is off until phase 3 and says why.
import type { PageRefT } from '@talos-app/protocol'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_CARD_TEXT, PageCard } from '../../src/features/pages/PageCard.tsx'
import { PAGES_TEXT } from '../../src/features/pages/pagesData.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const H = (c: string) => c.repeat(64)
const ID = 'pg_01JBF3V7Q8K2M4N6P8R0S2T4AB'
const REF: PageRefT = { page_id: ID, title: 'Trip budget', version: H('c') }
const info = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: 'Trip budget (final)',
  thread_id: 'trip',
  created_at: '2026-11-10T09:00:00.000Z',
  updated_at: '2026-11-11T09:00:00.000Z',
  current: H('c'),
  versions: [
    { hash: H('c'), bytes: 4096, at: '2026-11-11T09:00:00.000Z' },
    { hash: H('b'), bytes: 4000, at: '2026-11-10T12:00:00.000Z' },
    { hash: H('a'), bytes: 3900, at: '2026-11-10T09:00:00.000Z' },
  ],
  share: null,
  ...over,
})

let urls: string[]
function relay(answer: () => Response) {
  urls = []
  vi.stubGlobal('fetch', async (u: string) => {
    urls.push(String(u))
    return answer()
  })
}
const show = (ref: PageRefT = REF, threadId = 'trip') =>
  renderWith(<PageCard pageRef={ref} threadId={threadId} nowMs={NOW} />, setup())
const card = () => screen.getByTestId('page-card')
const chip = () => card().querySelector('[data-chip="share"]')?.textContent

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the page card', () => {
  it("shows the relay's page, not the message's words: its live title, which version, and who can open it", async () => {
    relay(() => Response.json(info()))
    show()
    const c = await screen.findByTestId('page-card')
    expect(urls).toEqual([`/api/pages/${ID}`])
    expect(within(c).getByRole('heading').textContent).toBe('Trip budget (final)') // not the message's "Trip budget"
    expect(c.textContent).toContain('Version 3')
    expect(chip()).toBe(PAGES_TEXT.share.you)
    expect(screen.queryByTestId('page-older')).toBeNull()
  })

  it("draws nothing for another thread's page: a session cannot pass one off as its own", async () => {
    relay(() => Response.json(info({ thread_id: 'work' })))
    show()
    await waitFor(() => expect(urls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('page-card')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull()
  })

  it('draws nothing before the relay answers, or when it cannot: the message text is all there is', async () => {
    relay(() => new Response('{}', { status: 500 }))
    show()
    expect(screen.queryByTestId('page-card')).toBeNull() // still asking
    await waitFor(() => expect(urls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('page-card')).toBeNull()
  })

  it('a page the relay no longer has says it was deleted, without the title the message claimed, and has no Open', async () => {
    relay(() => new Response('{}', { status: 404 }))
    show()
    const gone = await screen.findByTestId('page-missing')
    expect(gone.textContent).toBe(PAGES_TEXT.missing)
    expect(document.body.textContent).not.toContain('Trip budget')
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull()
  })

  it('a message about a version the page no longer lists says it is about an older one', async () => {
    relay(() => Response.json(info()))
    show({ ...REF, version: H('9') })
    expect((await screen.findByTestId('page-older')).textContent).toBe(PAGE_CARD_TEXT.older)
  })

  it('Share is off until coworker sharing exists, and says why', async () => {
    relay(() => Response.json(info()))
    show()
    const share = await screen.findByRole('button', { name: PAGE_CARD_TEXT.share })
    expect((share as HTMLButtonElement).disabled).toBe(true)
    expect(document.getElementById(share.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      PAGE_CARD_TEXT.shareLater,
    )
  })

  it('the share chip follows the page now: org, people, and a share that ended', async () => {
    relay(() =>
      Response.json(
        info({ share: { scope: 'org', emails: [], shared_at: '2026-11-10T00:00:00.000Z', expires_at: null } }),
      ),
    )
    show()
    await waitFor(() => expect(chip()).toBe(PAGES_TEXT.share.org))
    cleanup()
    const people = {
      scope: 'people',
      emails: ['alex@example.com'],
      shared_at: '2026-11-10T00:00:00.000Z',
      expires_at: '2026-12-01T00:00:00.000Z',
    }
    relay(() => Response.json(info({ share: people })))
    show()
    await waitFor(() => expect(chip()).toBe('1 person'))
    cleanup()
    relay(() => Response.json(info({ share: { ...people, expires_at: '2026-11-01T00:00:00.000Z' } })))
    show()
    await waitFor(() => expect(chip()).toBe(PAGES_TEXT.share.ended))
  })

  it('Open shows the current page full screen in the sandboxed frame from the relay frame route, and closes', async () => {
    relay(() => Response.json(info()))
    show()
    fireEvent.click(await screen.findByRole('button', { name: PAGE_CARD_TEXT.openLabel('Trip budget (final)') }))
    const dialog = screen.getByRole('dialog', { name: 'Trip budget (final)' })
    const frame = dialog.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`/p/${ID}/frame`)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts') // opaque origin: never allow-same-origin
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
