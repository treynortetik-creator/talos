// Talos Help in a real browser (fake mode, production build): the Settings row that opens it, phone width and desktop, both
// themes with axe, the keyboard (where focus lands), and the page while loading, when its code fails to load, and when the
// server's version can't be read. Screenshots go to $SHOT_DIR when it is set (outside the repo).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const SHOTS = process.env.SHOT_DIR

// The app registers a service worker. A request it answers never reaches `page.route`, so these specs turn it off and the
// routes below are what the page really gets.
test.use({ serviceWorkers: 'block' })

async function noSidewaysScroll(page: Page, label: string) {
  const o = await page.evaluate(() => {
    const region = document.querySelector('[aria-label="Help"]')
    return {
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      region: region ? region.scrollWidth > region.clientWidth + 1 : null,
    }
  })
  expect(o, label).toEqual({ page: false, region: false })
}

async function shot(page: Page, name: string, info: { project: { name: string } }) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    await page.screenshot({ path: join(SHOTS, `${info.project.name}-help-${name}-${scheme}.png`) })
  }
}

const STATUS = {
  at: '2026-10-29T20:00:00.000Z',
  relay_ok: true,
  relay_problems: [],
  relay: { version: '0.4.1', up_since: '2026-10-29T14:02:00.000Z' },
  mac_problems: [],
  bridge: { online: true, last_seen: '2026-10-29T20:00:00.000Z', down_since: null },
  mod: { state: 'alive', last_seen: '2026-10-29T19:59:57.000Z', expected: true },
  push: { subscriptions: 1, last_ok_at: '2026-10-29T18:00:00.000Z', last_error_at: null },
  ntfy: false,
  beat: {
    mod: { state: 'alive', last_seen: '2026-10-29T20:00:00.000Z', expected: true },
    tts: true,
    stt: true,
    sqlite: { fts5: true },
  },
}

test('Settings ends with a Help row; it opens the page and Back returns to Settings', async ({ page }, info) => {
  await page.goto('/settings')
  const list = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(list).toBeVisible()
  const rows = list.getByRole('link')
  await expect(rows.last()).toHaveText('Help')
  await rows.last().click()
  await expect(page).toHaveURL(/\/help$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Talos Help' })).toBeVisible()
  await shot(page, 'top', info)
  await page.getByRole('link', { name: 'Back to settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
})

test('the page fits the width and is axe clean in light and dark, at rest and while searching', async ({
  page,
}, info) => {
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.goto('/help')
  await expect(page.getByRole('heading', { level: 2, name: 'About' })).toBeVisible()
  await expect(page.getByTestId('help-build')).toContainText('0.4.1')
  await noSidewaysScroll(page, 'at rest')
  await expectAxeClean(page)
  await page.getByRole('searchbox', { name: 'Search Help' }).fill('quiet hours')
  await expect(page.getByTestId('help-count')).toHaveText(/matching/)
  await expect(page.getByTestId('help-fix-no-notifications')).toHaveAttribute('open', '')
  await noSidewaysScroll(page, 'searching')
  await expectAxeClean(page)
  await shot(page, 'search', info)
  await page.getByRole('searchbox', { name: 'Search Help' }).fill('zebra crossing')
  await expect(page.getByTestId('help-empty')).toBeVisible()
  await noSidewaysScroll(page, 'nothing found')
  await expectAxeClean(page)
  await shot(page, 'empty', info)
})

test('the keyboard reaches the search box, the contents and the fixes, and focus lands on the heading it jumps to', async ({
  page,
}) => {
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.goto('/help')
  const box = page.getByRole('searchbox', { name: 'Search Help' })
  await expect(box).toBeVisible()
  await box.focus()
  const contents = page.getByRole('navigation', { name: 'Help contents' })
  // Safari (the iPhone project) leaves links out of the Tab order unless the user turns that on, so only the other
  // browsers are asked to Tab onto the first contents link. Every browser can still focus and activate one.
  if (test.info().project.name !== 'iphone') {
    await page.keyboard.press('Tab')
    await expect(contents.getByRole('link').first()).toBeFocused()
  }
  // Enter on a contents link: focus moves to that section's heading, not left on the link
  await contents.getByRole('link', { name: 'Fix it' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'Fix it' })).toBeFocused()
  // a fix opens and closes from the keyboard
  const fix = page.getByTestId('help-fix-locked-out')
  const summary = fix.locator('summary')
  await summary.focus()
  await expect(fix).not.toHaveAttribute('open', '')
  await page.keyboard.press('Enter')
  await expect(fix).toHaveAttribute('open', '')
  await expect(fix.getByText('Paste a setup link')).toBeVisible()
  await page.keyboard.press('Space')
  await expect(fix).not.toHaveAttribute('open', '')
  // every control has a visible focus ring
  await box.focus()
  const outline = await box.evaluate((el) => getComputedStyle(el).outlineStyle)
  expect(outline).not.toBe('none')
})

test('Ask opens a message in the default thread with the search words, and sends nothing', async ({ page }) => {
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.goto('/help')
  await page.getByRole('searchbox', { name: 'Search Help' }).fill('zebra crossing')
  await page.getByTestId('help-ask').click()
  await expect(page).toHaveURL(/\/t\/general$/)
  const message = page.getByLabel('Message', { exact: true })
  await expect(message).toHaveValue('I need help with Talos. zebra crossing')
  // The fake client signs every frame it sends into `__talos.sent` under its real type, `message`. The count of those is
  // zero after Ask, and goes to one when the owner presses Send: that second step shows this count can move at all.
  const sentMessages = () =>
    page.evaluate(
      () =>
        (window as unknown as { __talos: { sent: Array<{ type: string }> } }).__talos.sent.filter(
          (f) => f.type === 'message',
        ).length,
    )
  expect(await sentMessages()).toBe(0)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(sentMessages).toBe(1)
})

test('Ask keeps an unsent draft in that thread and puts the question under it', async ({ page }) => {
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.goto('/t/general')
  const message = page.getByLabel('Message', { exact: true })
  await message.fill('half a sentence to finish later')
  // the composer saves a moment after the last keystroke; wait for the stored copy, not for a fixed time
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string | null>((resolve) => {
            const open = indexedDB.open('talos-app')
            open.onsuccess = () => {
              const get = open.result.transaction('drafts').objectStore('drafts').get('general')
              get.onsuccess = () => resolve((get.result as string | undefined) ?? null)
              get.onerror = () => resolve(null)
            }
            open.onerror = () => resolve(null)
          }),
      ),
    )
    .toBe('half a sentence to finish later')
  await page.goto('/help')
  await page.getByRole('searchbox', { name: 'Search Help' }).fill('quiet hours')
  await page.getByTestId('help-ask').click()
  await expect(page).toHaveURL(/\/t\/general$/)
  await expect(message).toHaveValue('half a sentence to finish later\n\nI need help with Talos. quiet hours')
})

test('while the page code loads it says so, then shows the page', async ({ page }) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/assets/HelpScreen-*.js', async (route) => {
    await gate
    await route.continue()
  })
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  // the page's own load event waits for the held chunk in WebKit, so only wait for the response to start
  await page.goto('/help', { waitUntil: 'commit' })
  await expect(page.getByTestId('help-loading')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Talos Help' })).toHaveCount(0)
  await expectAxeClean(page)
  release()
  await expect(page.getByRole('heading', { level: 1, name: 'Talos Help' })).toBeVisible()
  await expect(page.getByTestId('help-loading')).toHaveCount(0)
})

// The app reloads once on a missing chunk (a deploy may have replaced it) and shows the manual screen only if the chunk is
// still missing after that. The alert is on screen for a few ms after the first failure, then the reload replaces it, so a
// scan has to wait for the second document. The service worker is blocked for the whole file (top of this file), so the
// chunk is refused again after the reload and the manual screen is where the page settles.
test('when the page code cannot load, the app says so and offers a reload instead of a blank screen', async ({
  page,
}) => {
  let documents = 0
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documents += 1
  })
  await page.route('**/assets/HelpScreen-*.js', (route) => route.abort())
  await page.goto('/help', { waitUntil: 'commit' })
  await expect.poll(() => documents, { timeout: 15_000 }).toBe(2)
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('New version available')
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expectAxeClean(page)
  expect(documents, 'one automatic reload, not a loop').toBe(2)
})

test('About: the server version is read, can fail with a way to retry, and a retry fixes it', async ({ page }) => {
  let up = false
  await page.route('**/api/status', (r) =>
    up ? r.fulfill({ json: STATUS }) : r.fulfill({ status: 503, json: { error: 'down' } }),
  )
  await page.goto('/help')
  const failed = page.getByTestId('help-build-failed')
  await expect(failed).toBeVisible()
  await expect(page.getByTestId('help-build')).not.toContainText('0.4.1')
  await expectAxeClean(page)
  up = true
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('help-build')).toContainText('0.4.1')
  await expect(failed).toHaveCount(0)
})

test('About: while the server has not answered it says it is reading', async ({ page }) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/status', async (r) => {
    await gate
    await r.fulfill({ json: STATUS })
  })
  await page.goto('/help')
  await expect(page.getByTestId('help-build-loading')).toBeVisible()
  await expect(page.getByTestId('help-build')).toContainText('App build')
  release()
  await expect(page.getByTestId('help-build')).toContainText('0.4.1')
})
