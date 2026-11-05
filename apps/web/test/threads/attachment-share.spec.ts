import { expect, type Page, test } from '@playwright/test'

// Fake mode (VITE_FAKE=1). Every attachment has one Download (desktop) / Share (phone) control that hands over the same bytes
// the viewer shows, under the attachment's own name. Nothing is sent anywhere: the media route is stubbed here.
const HTML = '<!doctype html><title>Notes</title><h1>Quarterly notes</h1>'

test.use({ serviceWorkers: 'block' })

type Stubs = { head?: number; get?: number }

async function send(
  page: Page,
  file = { name: 'quarterly-notes.html', mimeType: 'text/html', body: HTML },
  s: Stubs = {},
) {
  const gets: string[] = []
  await page.context().route('**/media/**', (r) => {
    const m = r.request().method()
    if (m === 'GET') gets.push(r.request().url())
    const status = (m === 'HEAD' ? s.head : s.get) ?? 200
    return r.fulfill({ status, contentType: file.mimeType, body: status === 200 && m === 'GET' ? file.body : '' })
  })
  await page.goto('/t/general')
  await page.getByTestId('pick-files').setInputFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.body),
  })
  await page.getByRole('button', { name: 'Send' }).click()
  return gets
}

/** share() that throws NotAllowedError unless it is called in the same turn as a click, like a phone browser does. */
async function stubShare(page: Page, mode: 'sync-only' | 'always-refuse' = 'sync-only') {
  await page.addInitScript((m) => {
    const w = window as unknown as { __shared: unknown[]; __inClick: boolean; __blobs: number; __tries: number }
    w.__shared = []
    w.__blobs = 0
    w.__tries = 0
    w.__inClick = false
    addEventListener(
      'click',
      () => {
        w.__inClick = true
        setTimeout(() => {
          w.__inClick = false
        }, 0)
      },
      true,
    )
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob | MediaSource) => {
      w.__blobs++
      return create(b)
    }
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: { files: File[] }) => {
        w.__tries++
        if (m === 'always-refuse' || !w.__inClick)
          throw Object.assign(new Error('no activation'), { name: 'NotAllowedError' })
        w.__shared.push({
          n: d.files.length,
          name: d.files[0]?.name,
          type: d.files[0]?.type,
          text: await d.files[0]?.text(),
        })
      },
    })
  }, mode)
}

const sharedOf = (page: Page) => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)

test('desktop: Download is a real download of the relay file under the attachment own name', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop browsers save with an anchor download')
  await send(page)
  const link = page.getByRole('link', { name: 'Download quarterly-notes.html' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', /\/media\/md_[0-9A-Z]+/)
  await expect(link).toHaveAttribute('download', 'quarterly-notes.html')
  // A real download of the relay file: Playwright cannot stub the body of an anchor download, so the name and the request
  // are what is checked here (the bytes are the relay's own; no blob is made).
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(download.suggestedFilename()).toBe('quarterly-notes.html')
  expect(download.url()).toMatch(/\/media\/md_[0-9A-Z]+/)
})

test('phone: Share calls the share sheet in the tap itself, with one File of the right name and type', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'phones use the share sheet')
  await stubShare(page)
  await send(page)
  const share = page.getByRole('link', { name: 'Share quarterly-notes.html' })
  // The file is prepared before the tap.
  await expect(share).toHaveAttribute('data-prepared', 'true')
  await share.click()
  await expect
    .poll(() => sharedOf(page))
    .toEqual([{ n: 1, name: 'quarterly-notes.html', type: 'text/html', text: HTML }])
  expect(await page.evaluate(() => (window as unknown as { __blobs: number }).__blobs)).toBe(0)
  await expect(page.getByTestId('delivery-note')).toHaveCount(0)
})

test('phone: if the browser refuses the share sheet the owner is told how to do it by hand; nothing downloads', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'phones use the share sheet')
  await stubShare(page, 'always-refuse')
  await send(page)
  const share = page.getByRole('link', { name: 'Share quarterly-notes.html' })
  await expect(share).toHaveAttribute('data-prepared', 'true')
  let downloaded = false
  page.on('download', () => {
    downloaded = true
  })
  const url = page.url()
  await share.click()
  const note = page.getByRole('alert')
  await expect(note).toContainText("Safari's share button")
  await expect(note.getByRole('link', { name: /Open quarterly-notes.html/ })).toBeVisible()
  await page.waitForTimeout(300)
  expect(downloaded).toBe(false)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => (window as unknown as { __blobs: number }).__blobs)).toBe(0)
})

test('phone: a file the relay no longer has says so once and is not fetched again', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'phones use the share sheet')
  await stubShare(page)
  const gets = await send(page, undefined, { get: 410 })
  const share = page.getByRole('link', { name: 'Share quarterly-notes.html' })
  await expect(share).toBeVisible()
  await expect.poll(() => gets.length).toBe(1) // the prepare before the tap
  await expect(page.getByRole('alert')).toContainText('expired from the relay; ask the agent to resend')
  await page.waitForTimeout(500)
  expect(gets.length).toBe(1)
  expect(await sharedOf(page)).toEqual([])
})

test('a file the relay dropped shows its own status and no link that lands on a 410', async ({ page }) => {
  await send(page, undefined, { head: 410 })
  await expect(page.getByTestId('file-chip-unavailable')).toBeVisible()
  await expect(page.getByRole('link', { name: /quarterly-notes.html/ })).toHaveCount(0)
})

test('iPhone shell: the tap posts a native share message and touches no blob or download', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'phone width')
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }
    w.__posted = []
    w.__blobs = 0
    w.webkit = {
      messageHandlers: { talosShareMedia: { postMessage: (m: unknown) => (w.__posted as unknown[]).push(m) } },
    }
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob | MediaSource) => {
      ;(w.__blobs as number)++
      return create(b)
    }
  })
  await send(page)
  let downloaded = false
  page.on('download', () => {
    downloaded = true
  })
  const url = page.url()
  const share = page.getByRole('link', { name: 'Share quarterly-notes.html' })
  await share.click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted))
    .toEqual([
      { path: expect.stringMatching(/^\/media\/md_[0-9A-Z]+$/), name: 'quarterly-notes.html', mime: 'text/html' },
    ])
  await page.waitForTimeout(300)
  expect(downloaded).toBe(false)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => (window as unknown as { __blobs: number }).__blobs)).toBe(0)
})

test('iPhone shell: the tap shows Preparing, a second tap posts nothing, the shell answering clears it', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'phone width')
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }
    w.__posted = []
    w.webkit = {
      messageHandlers: { talosShareMedia: { postMessage: (m: unknown) => (w.__posted as unknown[]).push(m) } },
    }
  })
  await send(page)
  const posted = () => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted.length)
  const share = page.getByTestId('attachment-share')
  await share.click()
  await expect(share).toHaveAttribute('aria-busy', 'true')
  await expect(share).toContainText('Preparing…')
  await share.click()
  await share.click()
  await page.waitForTimeout(200)
  expect(await posted()).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('talos:share-media-done')))
  await expect(share).toHaveAttribute('aria-busy', 'false')
  await expect(share).toContainText('Share')
  await share.click()
  await expect.poll(posted).toBe(2)
})

test('a PDF chip is the one control for the file: no second Share button under it', async ({ page }) => {
  await send(page, { name: 'plan.pdf', mimeType: 'application/pdf', body: '%PDF-1.4' })
  await expect(page.getByTestId('attachment-share')).toHaveCount(1)
  await expect(page.getByRole('link', { name: /plan\.pdf/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /plan\.pdf/ })).toHaveCount(0)
})
