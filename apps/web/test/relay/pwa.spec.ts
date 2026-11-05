import { expect, test } from '../helpers/fixtures.ts'
import { openSignedIn } from '../helpers/util.ts'

test('the manifest has name, id, icons and standalone display, and is linked from the page', async ({
  page,
  harness,
  request,
}) => {
  await page.goto(`${harness.url}/enroll`)
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBe('/manifest.webmanifest')
  const res = await request.get(`${harness.url}${href}`)
  expect(res.ok()).toBe(true)
  const m = await res.json()
  expect(m.name).toBe('Talos')
  expect(m.id).toBe('/')
  expect(m.display).toBe('standalone')
  expect(m.start_url).toBe('/')
  const sizes = (m.icons as Array<{ sizes: string; purpose: string }>).map((i) => `${i.sizes}:${i.purpose}`)
  expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']))
  for (const icon of m.icons as Array<{ src: string }>) {
    const r = await request.get(`${harness.url}${icon.src}`)
    expect(r.ok(), icon.src).toBe(true)
    expect(r.headers()['content-type']).toContain('image/png')
  }
})

test('the service worker registers and takes control', async ({ page, context, harness, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebKit service workers need an installed app profile in this harness')
  await openSignedIn(harness, page, context, '/t/general')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready
        return reg.active?.state
      }),
    )
    .toBe('activated')
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(`${harness.url}/`)
})

test('push permission is requested only after a tap, never on load', async ({
  page,
  context,
  harness,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'notification permission is automated in Chromium only')
  // Headless Chromium starts at "denied"; model a fresh install ("default") and count the prompts.
  await page.addInitScript(() => {
    const w = window as unknown as { __permissionRequests: number }
    w.__permissionRequests = 0
    let current: NotificationPermission = 'default'
    Object.defineProperty(Notification, 'permission', { get: () => current, configurable: true })
    Notification.requestPermission = (async () => {
      w.__permissionRequests++
      current = 'granted'
      return current
    }) as typeof Notification.requestPermission
  })
  await openSignedIn(harness, page, context, '/t/general')
  await page.goto(`${harness.url}/settings/notifications`)
  await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible()
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as unknown as { __permissionRequests: number }).__permissionRequests)).toBe(
    0,
  )
  await page.getByRole('button', { name: 'Turn on notifications' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __permissionRequests: number }).__permissionRequests))
    .toBe(1)
})
