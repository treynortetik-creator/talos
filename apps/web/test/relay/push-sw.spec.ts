import type { BrowserContext, Worker } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'
import { openSignedIn } from '../helpers/util.ts'

// New headless Chromium (the "chromium" channel): the old headless shell cannot show service-worker notifications.
test.use({ channel: 'chromium' })
test.beforeEach(({ browserName }) =>
  test.skip(browserName !== 'chromium', 'service worker push events are driven through the Chromium protocol'),
)

type Shown = { title: string; body?: string; tag?: string; data?: unknown; error?: string }

// What the service worker asked the browser to show. We record it at `registration.showNotification` instead of
// reading it back with `getNotifications()`: Chromium answers that from the OS notification tray (on macOS, the
// Notification Center over XPC), returns only the rows the tray already reports as on display, and DELETES the
// rest (content/browser/notifications/platform_notification_context_impl.cc). A read that lands before the tray
// catches up loses the notification for good, so a single push could never be seen under load. The real display
// call still runs; only the read-back is replaced.
async function recordShows(context: BrowserContext, origin: string): Promise<Worker> {
  const mine = (w: Worker) => w.url() === `${origin}/sw.js`
  const sw = context.serviceWorkers().find(mine) ?? (await context.waitForEvent('serviceworker', { predicate: mine }))
  await sw.evaluate(() => {
    const g = self as unknown as ServiceWorkerGlobalScope & { __shown: Shown[] }
    g.__shown = []
    const reg = g.registration
    const show = reg.showNotification.bind(reg)
    reg.showNotification = async (title, options) => {
      const entry: Shown = { title, body: options?.body, tag: options?.tag, data: options?.data }
      try {
        await show(title, options)
      } catch (e) {
        entry.error = String(e)
      }
      g.__shown.push(entry)
    }
  })
  return sw
}

const shown = (sw: Worker) => sw.evaluate(() => (self as unknown as { __shown: Shown[] }).__shown)

test('the service worker shows a push built from PushPayload (fixed template, no message text)', async ({
  page,
  context,
  harness,
}) => {
  await context.grantPermissions(['notifications'], { origin: harness.url })
  const cdp = await context.newCDPSession(page)
  let registrationId = ''
  cdp.on(
    'ServiceWorker.workerRegistrationUpdated',
    (e: { registrations: Array<{ registrationId: string; scopeURL: string }> }) => {
      const r = e.registrations.find((x) => x.scopeURL === `${harness.url}/`)
      if (r) registrationId = r.registrationId
    },
  )
  await cdp.send('ServiceWorker.enable')
  await openSignedIn(harness, page, context, '/t/general')
  // `ready` resolves while the worker is still `activating`; push only once it is `activated`, so every push below
  // is delivered exactly once to a live worker (no re-sending until something sticks).
  await page.evaluate(async () => {
    const w = (await navigator.serviceWorker.ready).active
    if (!w || w.state === 'activated') return
    await new Promise<void>((resolve) => w.addEventListener('statechange', () => w.state === 'activated' && resolve()))
  })
  await expect.poll(() => registrationId).not.toBe('')
  const sw = await recordShows(context, harness.url)
  const push = (data: unknown) =>
    cdp.send('ServiceWorker.deliverPushMessage', { origin: harness.url, registrationId, data: JSON.stringify(data) })

  await push({
    web_push: 8030,
    notification: {
      title: 'Talos',
      body: 'New reply in General',
      navigate: '/t/general',
      tag: 'reply-general',
      silent: false,
    },
    talos: { v: 1, kind: 'reply', thread_id: 'general' },
  })
  await expect.poll(() => shown(sw)).toHaveLength(1)
  expect((await shown(sw))[0]).toEqual({
    title: 'Talos',
    body: 'New reply in General',
    tag: 'reply-general',
    data: { navigate: '/t/general', kind: 'reply', thread_id: 'general' },
  })

  // A payload that is not a PushPayload shows a fixed fallback (a push that shows nothing can cost the subscription).
  await push({ title: 'x', body: 'leaked text' })
  await expect.poll(() => shown(sw)).toHaveLength(2)
  const all = await shown(sw)
  expect(all[1]).toEqual({
    title: 'Talos',
    body: 'You have an update.',
    tag: 'talos-update',
    data: { navigate: '/', kind: 'system' },
  })
  // Nothing built from the non-PushPayload data ever reaches the screen.
  expect(JSON.stringify(all)).not.toMatch(/leaked text/)
})
