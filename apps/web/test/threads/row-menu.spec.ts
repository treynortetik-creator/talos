import { expect, type Locator, type Page, test } from '@playwright/test'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

// D36: the thread row menu in a real browser (WebKit for the iPhone project). Fake mode (VITE_FAKE=1). Playwright cannot
// hold a finger down, so a long press and a swipe are PointerEvents of type "touch" dispatched on the row; a real finger on
// a real iPhone is NOT proven by this spec (see the PR).

const touch = (el: Locator, type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
  el.dispatchEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true })

const ROWS = '[data-testid^="thread-row-"]'
/** A thread row with nothing unread (the fake seeds some unread ones). */
const readRow = (page: Page) =>
  page
    .locator(ROWS)
    .filter({ hasNot: page.getByRole('img', { name: /unread/ }) })
    .first()
const badges = (page: Page) => page.locator('main').getByRole('img', { name: /\d+ unread/ })

async function openList(page: Page) {
  await page.goto('/threads')
  await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible()
}

test('a right-click on a thread row opens the menu; Mark unread shows the badge, Mark read clears it', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'right-click is the mouse route')
  await openList(page)
  const row = readRow(page)
  const id = (await row.getAttribute('data-testid'))?.replace('thread-row-', '') ?? ''
  await row.click({ button: 'right' })
  const menu = page.getByTestId('row-menu')
  await expect(menu).toBeVisible()
  await expect(page).toHaveURL(/\/threads$/) // the right-click did not open the thread
  await menu.getByTestId('row-read').click() // "Mark unread": nothing was unread
  await expect(page.getByTestId(`thread-row-${id}`).getByRole('img', { name: '1 unread' })).toBeVisible()
  await expect(page.getByTestId('mark-all-read')).toBeEnabled()
  await page.getByTestId('mark-all-read').click()
  await expect(badges(page)).toHaveCount(0)
  await expect(page.getByTestId('mark-all-read')).toBeDisabled()
})

test('a long press opens the menu, the lift does not open the thread, and iOS gets no touch callout', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'touch route')
  await openList(page)
  const link = readRow(page)
  const id = ((await link.getAttribute('data-testid')) ?? '').replace('thread-row-', '')
  // WebKit on a desktop does not compute -webkit-touch-callout (it is an iOS-only property), so this proves the rule is
  // on the row's wrapper, not that iOS honours it.
  const calloutOff = await link.evaluate((e) => !!e.closest('[class*="webkit-touch-callout:none"]'))
  expect(calloutOff).toBe(true)
  const box = await link.boundingBox()
  const x = (box?.x ?? 0) + 150
  const y = (box?.y ?? 0) + 20
  await touch(link, 'pointerdown', x, y)
  await page.waitForTimeout(650)
  await expect(page.getByTestId('row-menu')).toBeVisible()
  await touch(link, 'pointerup', x, y)
  await link.dispatchEvent('click') // the click a finger-lift makes
  await expect(page).toHaveURL(/\/threads$/)
  await expect(page.getByTestId('row-menu')).toBeVisible() // and the made-up taps did not close it
  await page.getByTestId('row-read').click()
  await expect(page.getByTestId(`thread-row-${id}`).getByRole('img', { name: '1 unread' })).toBeVisible()
})

test('a swipe right on a row marks it unread, and one that starts at the screen edge does not', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'touch route')
  await openList(page)
  const link = readRow(page)
  const id = ((await link.getAttribute('data-testid')) ?? '').replace('thread-row-', '')
  const before = await badges(page).count()
  const box = await link.boundingBox()
  const y = (box?.y ?? 0) + 20
  await touch(link, 'pointerdown', 6, y)
  await touch(link, 'pointermove', 60, y + 1)
  await touch(link, 'pointermove', 160, y + 2)
  await touch(link, 'pointerup', 160, y + 2)
  await expect(badges(page)).toHaveCount(before)
  await touch(link, 'pointerdown', 100, y)
  await touch(link, 'pointermove', 160, y + 1)
  await touch(link, 'pointermove', 240, y + 2)
  await touch(link, 'pointerup', 240, y + 2)
  await expect(page.getByTestId(`thread-row-${id}`).getByRole('img', { name: '1 unread' })).toBeVisible()
  await expect(page).toHaveURL(/\/threads$/) // the swipe's click did not open the thread
})

test('the phone’s left menu rows have the same menu on a long press', async ({ page }, info) => {
  test.skip(!isPhoneWidth(page) || info.project.name === 'desktop', 'the left menu is the phone chrome')
  // The fake starts with General and Inbox only; the menu lists the OTHER threads, so make one and open it. The fake client
  // lives in memory, so everything after the first load is navigation inside the app.
  await openList(page)
  await page.getByTestId('new-thread').filter({ visible: true }).first().click()
  const sheet = page.getByTestId('thread-settings')
  await sheet.getByLabel('Name').fill('Plans')
  await sheet.getByRole('button', { name: 'Create thread' }).click()
  await expect(sheet).toBeHidden()
  await page.getByTestId('thread-row-plans').click()
  await expect(page.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible()
  await openPhoneMenu(page)
  const link = page.getByTestId('phone-menu').locator('[data-testid^="menu-wrap-"] a').first()
  const box = await link.boundingBox()
  const x = (box?.x ?? 0) + 60
  const y = (box?.y ?? 0) + 10
  await touch(link, 'pointerdown', x, y)
  await page.waitForTimeout(650)
  await expect(page.getByTestId('row-menu')).toBeVisible()
  await touch(link, 'pointerup', x, y)
  await expect(page.getByTestId('phone-menu')).toBeVisible() // the menu stayed; no navigation
  await expect(page).toHaveURL(/\/t\/plans$/)
  await expect(page.getByTestId('row-read')).toHaveText('Mark read') // General has one unread in the fake
  await expect(link.getByRole('img', { name: /1 unread/ })).toBeVisible()
  await page.getByTestId('row-read').click()
  await expect(link.getByRole('img', { name: /unread/ })).toHaveCount(0)
})
