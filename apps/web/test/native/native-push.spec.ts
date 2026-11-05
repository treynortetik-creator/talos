// WP-I5 in a real browser: the iPhone app's Settings -> Notifications row at phone width, in both themes, in every state
// (Checking, Needs setup, Off, Blocked, On, failed), by keyboard, with axe. A fake `window.Capacitor` stands in for the
// shell (installed before any page script runs) and the relay's /api/push/apns is answered by the test.
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

type Mode = {
  status?: 'hang' | 500 | 404
  configured?: boolean
  registered?: boolean
  permission?: string
  /** The shell has the notification-key calls (message text and quick actions). */
  grantCalls?: boolean
  /** The relay already holds a grant for this phone. */
  grant?: boolean
  /** This phone remembers the owner chose message text and holds the keys. Defaults to `grant`. */
  localText?: boolean
}

async function open(page: Page, mode: Mode) {
  await page.addInitScript((m) => {
    let permission = m.permission ?? 'prompt'
    // What the phone itself remembers: the owner's text choice and whether the Keychain holds the keys.
    if (m.localText ?? m.grant) {
      localStorage.setItem('talos.nativePush.text', 'on')
      localStorage.setItem('talos.nativePush.grantStored', '1')
    }
    const win = window as unknown as Record<string, unknown>
    win.__push = { calls: [] as string[] }
    win.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        TalosPush: {
          getStatus: async () => ({ permission }),
          register: async (a: { prompt: boolean }) => {
            ;((win.__push as { calls: string[] }).calls as string[]).push(`register:${a.prompt}`)
            permission = 'granted'
            return { token: 'ab'.repeat(32), env: 'sandbox' }
          },
          unregister: async () => {},
          addListener: async () => ({ remove() {} }),
          ...(m.grantCalls
            ? {
                nativeKeys: async () => {
                  ;((win.__push as { calls: string[] }).calls as string[]).push('nativeKeys')
                  return { enc_pub: 'B'.padEnd(87, 'e'), act_pub: 'B'.padEnd(87, 'a') }
                },
                storeGrant: async (a: { grant: string }) => {
                  ;(win.__push as { grant?: string }).grant = a.grant
                },
                clearGrant: async () => {},
              }
            : {}),
        },
      },
    }
  }, mode)
  let registered = mode.registered ?? false
  await page.route('**/api/push/apns', async (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      registered = (req.postDataJSON() as { op: string }).op === 'register'
      return route.fulfill({ status: 204 })
    }
    if (mode.status === 'hang') return // never answers
    if (mode.status) return route.fulfill({ status: mode.status, json: { error: 'x' } })
    return route.fulfill({ json: { configured: mode.configured ?? true, registered } })
  })
  let held = mode.grant ?? false
  let posted: unknown = null
  await page.route('**/api/push/grant', async (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      posted = req.postDataJSON()
      held = (posted as { type?: string }).type === 'native.grant'
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({
      json: held
        ? { registered: true, exp: new Date(Date.now() + 25 * 86_400_000).toISOString() }
        : { registered: false },
    })
  })
  await page.exposeFunction('__grantPosted', () => posted)
  await page.goto('/settings/notifications')
}
const status = (page: Page) => page.getByTestId('native-push-status')
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

const STATES: Array<[string, Mode, string]> = [
  ['checking', { status: 'hang' }, 'Checking...'],
  ['needs setup (server)', { configured: false }, 'Needs setup'],
  ['server too old (404)', { status: 404 }, 'Needs setup'],
  ['off', {}, 'Off'],
  ['blocked', { permission: 'denied' }, 'Blocked'],
  ['on', { permission: 'granted', registered: true }, 'On'],
  ['on with message text', { permission: 'granted', registered: true, grantCalls: true, grant: true }, 'On'],
  ['on without message text yet', { permission: 'granted', registered: true, grantCalls: true, grant: false }, 'On'],
  [
    'on, server still holds a grant the owner turned off',
    { permission: 'granted', registered: true, grantCalls: true, grant: true, localText: false },
    'On',
  ],
  ['off on an older shell', { grantCalls: false }, 'Off'],
  ['failed', { status: 500 }, "Couldn't check"],
]

for (const [name, mode, text] of STATES) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${name}: reads "${text}", fits the phone, accessible (${colorScheme})`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await open(page, mode)
      await expect(status(page)).toHaveText(text)
      await page.getByTestId('native-push').scrollIntoViewIfNeeded()
      await noHorizontalScroll(page)
      await expectAxeClean(page)
      await page.getByTestId('native-push').screenshot({
        path: info.outputPath(`native-push-${name.replace(/\W+/g, '-')}-${colorScheme}.png`),
      })
    })
  }
}

test('keyboard: Tab reaches Turn on notifications, Enter turns it on, and it asks iOS exactly once with the prompt', async ({
  page,
}) => {
  await open(page, {})
  const button = page.getByRole('button', { name: 'Turn on notifications' })
  await expect(button).toBeVisible()
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('On')
  expect(await page.evaluate(() => (window as unknown as { __push: { calls: string[] } }).__push.calls)).toEqual([
    'register:true',
  ])
})

test('opening Settings never prompts iOS', async ({ page }) => {
  await open(page, { permission: 'prompt' })
  await expect(status(page)).toHaveText('Off')
  expect(await page.evaluate(() => (window as unknown as { __push: { calls: string[] } }).__push.calls)).toEqual([])
})

test('a browser (no shell) shows the old web push block and no iPhone row', async ({ page }) => {
  await page.goto('/settings/notifications')
  await expect(page.getByTestId('push-status')).toBeVisible()
  await expect(page.getByTestId('native-push')).toHaveCount(0)
})

test('message text: the row says what Apple gets and what the server can read, in words that fit the phone', async ({
  page,
}) => {
  await open(page, { permission: 'granted', registered: true, grantCalls: true, grant: true })
  const text = page.getByTestId('native-push-text')
  await expect(text).toContainText('Apple only gets a fixed phrase')
  await expect(text).toContainText('server can still read them')
  await noHorizontalScroll(page)
})

test('message text: without a grant the row says notifications are a fixed phrase and how to get text', async ({
  page,
}) => {
  await open(page, { permission: 'granted', registered: true, grantCalls: true, grant: false })
  const text = page.getByTestId('native-push-text')
  await expect(text).toContainText('Notifications show a fixed phrase')
  await expect(text).toContainText('Message text and the Reply and Approve buttons are off')
  await expect(page.getByRole('button', { name: 'Show message text' })).toBeVisible()
  await noHorizontalScroll(page)
})

test('message text: a grant the server holds but the owner turned off shows the pending line, not "text is on"', async ({
  page,
}) => {
  await open(page, { permission: 'granted', registered: true, grantCalls: true, grant: true, localText: false })
  await expect(page.getByTestId('native-push-pending')).toContainText('has not confirmed')
  await expect(page.getByTestId('native-push-text')).toContainText('fixed phrase')
  await noHorizontalScroll(page)
})

test('an older shell is told notifications are a fixed phrase, with no text choice promised', async ({ page }) => {
  await open(page, { grantCalls: false })
  await expect(page.getByTestId('native-push-text-intro')).toContainText('cannot show message text')
  await expect(page.getByTestId('native-push-names')).not.toContainText('turn on message text')
})

test('Turn on makes no grant; "Show message text" (a tap, by keyboard) registers a signed one and hands the shell exactly those bytes', async ({
  page,
}) => {
  await open(page, { grantCalls: true })
  await page.getByRole('button', { name: 'Turn on notifications' }).click()
  await expect(status(page)).toHaveText('On')
  expect(await page.evaluate(() => (window as unknown as { __grantPosted: () => unknown }).__grantPosted())).toBeNull()
  await expect(page.getByTestId('native-push-text')).toContainText('Notifications show a fixed phrase')
  const show = page.getByRole('button', { name: 'Show message text' })
  await show.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('native-push-text')).toContainText('Apple only gets a fixed phrase')
  const posted = (await page.evaluate(() =>
    (window as unknown as { __grantPosted: () => unknown }).__grantPosted(),
  )) as Record<string, unknown>
  expect(posted).toMatchObject({
    type: 'native.grant',
    scopes: ['reply', 'approve_low'],
    enc_pub: 'B'.padEnd(87, 'e'),
    act_pub: 'B'.padEnd(87, 'a'),
  })
  expect(typeof posted.osig).toBe('string')
  const stored = await page.evaluate(() => (window as unknown as { __push: { grant?: string } }).__push.grant)
  expect(JSON.parse(stored ?? 'null')).toEqual(posted)
})
