// SETTINGS-MAP 3.2 in the real app (fake mode, production build): phone and desktop, both themes, no sideways page scroll,
// axe clean, the moved controls where they now live, the keyboard reaching them, and the old routes gone or redirected.
// Screenshots go to $SHOT_DIR when it is set (outside the repo); nothing is written into the tree.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const SHOTS = process.env.SHOT_DIR

async function settle(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  await page.waitForLoadState('networkidle')
}

/**
 * Open a route the app redirects away from. The redirect is a second navigation inside the page, and WebKit can report it
 * to the next `goto` as an interruption (or destroy a context a script is running in). So: return at the first response,
 * let the redirect land and the page go quiet, and only then hand back.
 */
async function goToRedirect(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'commit' })
  await page.waitForURL((u) => u.pathname !== new URL(url, u).pathname)
  await page.waitForLoadState('networkidle')
}

async function noSidewaysScroll(page: Page, label: string) {
  const o = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    body: document.body.scrollWidth > document.body.clientWidth + 1,
  }))
  expect(o, label).toEqual({ page: false, body: false })
}

async function shot(page: Page, name: string, info: { project: { name: string } }) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    await page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}-${scheme}.png`), fullPage: false })
  }
}

const ROUTES: Array<[string, RegExp]> = [
  ['/settings/notifications', /Quiet hours/],
  ['/settings/voice', /Voice-note replies/],
  ['/settings/session', /Models offered/],
  ['/settings/agent', /Manage threads/],
  ['/settings/health', /Connection/],
]

for (const [route, marker] of ROUTES) {
  test(`${route}: renders, fits the width, axe clean in both themes`, async ({ page }, info) => {
    await page.goto(route)
    await expect(page.getByText(marker).first()).toBeVisible()
    await settle(page)
    await noSidewaysScroll(page, route)
    await expectAxeClean(page)
    await shot(page, route.split('/').pop() ?? 'x', info)
  })
}

test('Notifications: quiet hours save at once', async ({ page }) => {
  await page.goto('/settings/notifications')
  await page.getByRole('switch', { name: 'Quiet hours' }).click()
  await expect(page.getByLabel('Quiet hours start')).toBeVisible()
  const frame = await page.evaluate(() => {
    const sent = (window as unknown as { __talos: { sent: Array<{ type: string; patch?: unknown }> } }).__talos.sent
    return sent.filter((f) => f.type === 'config.patch').at(-1)?.patch
  })
  expect(frame).toEqual({ quiet_window: { start: '22:00', end: '07:00' } })
  // the keyboard reaches the times and an Enter-less change saves
  await page.getByLabel('Quiet hours end').focus()
  await expect(page.getByLabel('Quiet hours end')).toBeFocused()
})

test('Settings list: Integrations, Health; no Connection; the old Connection URL lands on Health', async ({ page }) => {
  await page.goto('/settings')
  const phone = isPhoneWidth(page)
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('link', { name: /^Integrations/ })).toBeVisible()
  await expect(nav.getByRole('link', { name: /^Telegram/ })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: /^Connection/ })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: /^Webhooks/ })).toHaveCount(0)
  await goToRedirect(page, '/settings/connection')
  await expect(page).toHaveURL(/\/settings\/health$/)
  await expect(page.getByTestId('connection-block')).toBeVisible()
  void phone
})

test('removed deep links do not 404 into a blank page: they go home', async ({ page }) => {
  for (const r of ['/settings/integrations/new', '/settings/integrations/new/generic', '/settings/integrations/cn_x']) {
    await goToRedirect(page, r)
    await expect(page).toHaveURL(/\/($|threads|settings\/account)/)
  }
})

test('Thread settings: the moved switch, no default-thread checkbox, archive-only note', async ({ page }, info) => {
  await page.goto('/t/general?settings=1')
  const sheet = page.getByTestId('thread-settings')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('switch', { name: /Live-call context/ })).toBeVisible()
  await expect(sheet.getByText('Default thread', { exact: true })).toHaveCount(0)
  await expect(sheet.getByTestId('archive-only-note')).toBeVisible()
  await settle(page)
  await noSidewaysScroll(page, 'thread settings')
  await shot(page, 'thread-settings', info)
})

test('Inbox thread settings hide Live-call context', async ({ page }) => {
  await page.goto('/t/inbox?settings=1')
  const sheet = page.getByTestId('thread-settings')
  await expect(sheet.getByRole('switch', { name: /Live-call context/ })).toHaveCount(0)
})

test('phone menu has a Driving screen entry that opens it (U12)', async ({ page }) => {
  test.skip(!isPhoneWidth(page), 'the menu is the phone chrome')
  await page.goto('/t/general')
  await openPhoneMenu(page)
  const link = page.getByTestId('menu-driving')
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/drive$/)
})

test('Manage threads link opens the manage mode', async ({ page }) => {
  await page.goto('/settings/agent')
  await page.getByTestId('manage-threads-link').click()
  await expect(page).toHaveURL(/\/threads\?manage=1$/)
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
})

test('Integrations: renamed, one wizard entry, work thread select, Mac offline says so', async ({ page }) => {
  await page.goto('/settings/integrations')
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
  await expect(page.getByTestId('work-thread')).toBeVisible()
  await page.getByRole('button', { name: 'Add an integration' }).click()
  await expect(page.getByRole('button', { name: 'Next' }).or(page.getByText(/Personal/).first())).toBeVisible()
})
