// The phone header and edge swipes in a real browser (iphone WebKit, pixel Chromium; desktop must be unchanged), against
// the fake client (`VITE_FAKE=1`, `?fake_mod=offline|absent`).
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { swipe, swipeCancelled } from './swipe.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768
const size = (page: Page) => page.viewportSize() ?? { width: 0, height: 0 }
const SHOTS = '../../docs/screenshots/phone-header'

test.use({ reducedMotion: 'reduce' })

async function openThread(page: Page, q = '') {
  await page.goto(`/t/general${q}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}
const leftEdge = (page: Page) => ({
  from: { x: 4, y: size(page).height / 2 },
  to: { x: 200, y: size(page).height / 2 + 6 },
})
const rightEdge = (page: Page) => ({
  from: { x: size(page).width - 4, y: size(page).height / 2 },
  to: { x: size(page).width - 200, y: size(page).height / 2 + 6 },
})
async function settle(page: Page) {
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  await page.waitForTimeout(200)
}

test.describe('phone', () => {
  test.beforeEach(({ page }) => test.skip(!isPhone(page), 'phone layout only'))

  test('one slim row: menu, thread name, context ring; the rest is gone', async ({ page }) => {
    await openThread(page)
    const header = page.getByTestId('phone-header')
    await expect(header).toBeVisible()
    expect((await header.boundingBox())?.height ?? 99).toBeLessThanOrEqual(48)
    await expect(header.getByRole('button', { name: 'Open menu' })).toBeVisible()
    await expect(header.getByRole('heading', { level: 1 })).toHaveText('General')
    const ring = page.getByTestId('session-trigger')
    await expect(ring).toContainText('31%')
    await expect(ring).toHaveAttribute('aria-label', /context 31% used/)
    // redundant chrome removed
    await expect(page.getByTestId('thread-tabs')).toHaveCount(0)
    await expect(page.getByTestId('thread-screen').locator('.mascot')).toHaveCount(0)
    await expect(page.locator('[data-meander]')).toHaveCount(0)
    await expect(page.getByTestId('session-chip')).toHaveCount(0)
    await expect(page.getByTestId('agents-chip')).toHaveCount(0)
    await expect(header).not.toContainText('5h')
    await expect(ring).not.toHaveAttribute('aria-label', /5-hour/)
    // the status is still there for a screen reader, as a dot
    await expect(page.getByTestId('phone-status')).toContainText('Idle')
    expect((await page.getByTestId('phone-status').boundingBox())?.width ?? 99).toBeLessThanOrEqual(12) // a dot, no words
    // every target is 44 px
    for (const b of [header.getByRole('button', { name: 'Open menu' }), ring]) {
      const box = await b.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    }
  })

  test('the ring opens the session panel from the right with usage, context, agents and status', async ({ page }) => {
    await openThread(page, '?fake_agents=demo')
    await page.getByTestId('session-trigger').click()
    const sheet = page.getByTestId('session-sheet')
    await expect(sheet).toBeVisible()
    const box = await sheet.boundingBox()
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(size(page).width)
    await expect(sheet.getByTestId('meter-five')).toHaveCount(0)
    await expect(sheet.getByTestId('meter-week')).toContainText('60% used')
    await expect(sheet.getByTestId('meter-context')).toContainText('31% used')
    await expect(sheet.getByRole('list', { name: 'Agents' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId('session-trigger')).toBeFocused()
  })

  test('the menu button opens the thread menu; keyboard in, Escape out, focus returns', async ({ page }) => {
    await openThread(page)
    const btn = page.getByRole('button', { name: 'Open menu' })
    await btn.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('phone-menu')
    await expect(menu).toBeVisible()
    const nav = menu.getByRole('navigation', { name: 'Threads' })
    for (const name of ['Needs you', 'All threads', 'General', 'Inbox', 'Schedules']) {
      await expect(nav.getByRole('link', { name })).toBeVisible()
    }
    await expect(menu.getByRole('link', { name: 'Settings' })).toBeVisible()
    await expect(menu.getByRole('link', { name: 'Search', exact: true })).toBeVisible()
    await expect(menu.getByRole('link', { name: 'Search this thread' })).toBeVisible()
    await expect(menu.getByTestId('thread-settings-trigger')).toBeVisible()
    // focus is trapped inside while it is open
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="phone-menu"]') !== null)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(btn).toBeFocused()
  })

  test('choosing a thread in the menu navigates and closes it', async ({ page }) => {
    await openThread(page)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByTestId('phone-menu').getByRole('link', { name: 'Inbox' }).click()
    await expect(page).toHaveURL(/\/t\/inbox$/)
    await expect(page.getByTestId('phone-menu')).toBeHidden()
    await expect(page.getByTestId('phone-header').getByRole('heading', { level: 1 })).toHaveText('Inbox')
  })

  test('edge swipe from the left opens the menu, from the right opens the session panel', async ({ page }) => {
    await openThread(page)
    const l = leftEdge(page)
    await swipe(page, l.from, l.to)
    await expect(page.getByTestId('phone-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('phone-menu')).toBeHidden()
    const r = rightEdge(page)
    await swipe(page, r.from, r.to)
    await expect(page.getByTestId('session-sheet')).toBeVisible()
  })

  test('swipes that are not edge swipes do nothing', async ({ page }) => {
    await openThread(page)
    const h = size(page).height / 2
    const none = async () => {
      await page.waitForTimeout(150)
      await expect(page.getByTestId('phone-menu')).toHaveCount(0)
      await expect(page.getByTestId('session-sheet')).toHaveCount(0)
    }
    await swipe(page, { x: 120, y: h }, { x: 320, y: h }) // starts inside the screen
    await none()
    await swipe(page, { x: size(page).width - 120, y: h }, { x: 20, y: h })
    await none()
    await swipe(page, { x: 4, y: h }, { x: 40, y: h }) // too short
    await none()
    await swipe(page, { x: 4, y: h }, { x: 40, y: h + 300 }) // a vertical scroll that began at the edge
    await none()
    await swipe(page, { x: size(page).width - 4, y: h }, { x: size(page).width - 1, y: h }) // toward the edge
    await none()
  })

  test('a second finger (pinch) and a system cancel abort the swipe', async ({ page }) => {
    await openThread(page)
    const l = leftEdge(page)
    await swipe(page, l.from, l.to, { second: { x: 250, y: 400 } })
    await page.waitForTimeout(150)
    await expect(page.getByTestId('phone-menu')).toHaveCount(0)
    await swipeCancelled(page, l.from, l.to)
    await page.waitForTimeout(150)
    await expect(page.getByTestId('phone-menu')).toHaveCount(0)
  })

  test('a code block that can still scroll keeps the touch; at its start the edge swipe works', async ({ page }) => {
    // `text`, not a bare fence: a bare or shell fence from the agent gets a Run button and wraps whole, so it never scrolls
    await openThread(page)
    await page.getByLabel('Message', { exact: true }).fill(`code:\n\`\`\`text\n${'x'.repeat(400)}\n\`\`\``)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const pre = page.locator('pre').last()
    await expect(pre).toBeVisible()
    expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
    await pre.evaluate((e) => {
      e.scrollLeft = 80
    })
    const l = leftEdge(page)
    await swipe(page, l.from, l.to, { target: pre })
    await page.waitForTimeout(150)
    await expect(page.getByTestId('phone-menu')).toHaveCount(0)
    await pre.evaluate((e) => {
      e.scrollLeft = 0
    })
    await swipe(page, l.from, l.to, { target: pre })
    await expect(page.getByTestId('phone-menu')).toBeVisible()
  })

  test('an open dialog owns the edge: no second panel opens over it', async ({ page }) => {
    await openThread(page)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(page.getByTestId('phone-menu')).toBeVisible()
    const r = rightEdge(page)
    await swipe(page, r.from, r.to)
    await page.waitForTimeout(600) // longer than the session panel's lazy load
    await expect(page.getByTestId('session-sheet')).toHaveCount(0)
    await expect(page.getByTestId('phone-menu')).toBeVisible()
  })

  test('unknown thread and a route with no thread: no panel, no crash', async ({ page }) => {
    await page.goto('/settings')
    const r = rightEdge(page)
    await swipe(page, r.from, r.to) // the session panel needs a thread
    await page.waitForTimeout(150)
    await expect(page.getByTestId('session-sheet')).toHaveCount(0)
    const l = leftEdge(page)
    await swipe(page, l.from, l.to) // the menu works anywhere
    await expect(page.getByTestId('phone-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/t/no-such-thread')
    await expect(page).toHaveURL(/\/threads$/)
  })

  test('states: no reading shows a bare ring, mod offline says so, both stay tappable', async ({ page }) => {
    await openThread(page, '?fake_mod=absent')
    const ring = page.getByTestId('session-trigger')
    await expect(ring).toBeVisible()
    await expect(ring).not.toContainText('%')
    await expect(ring).toHaveAttribute('aria-label', 'Session')
    await page.goto('/t/general?fake_mod=offline')
    await expect(page.getByTestId('session-trigger')).toHaveAttribute('aria-label', /mod offline/)
    await page.getByTestId('session-trigger').click()
    await expect(page.getByTestId('session-sheet')).toBeVisible()
  })

  test('reduced motion: the drawer just appears; otherwise it slides', async ({ page }) => {
    await openThread(page)
    await page.getByRole('button', { name: 'Open menu' }).click()
    const name = () => page.getByTestId('phone-menu').evaluate((e) => getComputedStyle(e).animationName)
    expect(await name()).toBe('none')
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: 'Open menu' }).click()
    expect(await name()).toBe('drawer-in-left')
  })

  test('closing then reopening at once keeps the panel open (focus is not yanked back mid-exit)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await openThread(page)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(page.getByTestId('phone-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.waitForTimeout(600) // longer than the exit animation
    await expect(page.getByTestId('phone-menu')).toBeVisible()
  })

  test('accessible in light and dark, header and both drawers', async ({ page }) => {
    await openThread(page)
    await expectAxeClean(page)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await expectAxeClean(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('session-trigger').click()
    await expectAxeClean(page)
  })

  test('screenshots', async ({ page }, info) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await openThread(page)
      await settle(page)
      await page.screenshot({ path: `${SHOTS}/after-header-${scheme}-${info.project.name}.png` })
      await page.getByRole('button', { name: 'Open menu' }).click()
      await settle(page)
      await page.screenshot({ path: `${SHOTS}/after-menu-${scheme}-${info.project.name}.png` })
      await page.keyboard.press('Escape')
      await page.getByTestId('session-trigger').click()
      await expect(page.getByTestId('session-sheet')).toBeVisible()
      await settle(page)
      await page.screenshot({ path: `${SHOTS}/after-session-${scheme}-${info.project.name}.png` })
    }
  })
})

test('desktop and tablet: the full header, tabs and no edge swipes', async ({ page }) => {
  test.skip(isPhone(page), 'wide layouts only')
  await openThread(page)
  await expect(page.getByTestId('phone-header')).toHaveCount(0)
  await expect(page.getByTestId('thread-tabs')).toBeVisible()
  await expect(page.getByTestId('session-chip')).toContainText('wk 60% used')
  const l = leftEdge(page)
  await swipe(page, l.from, l.to)
  await page.waitForTimeout(150)
  await expect(page.getByTestId('phone-menu')).toHaveCount(0)
})
