import { expect, type Page, test } from '@playwright/test'

// PR #60 review: keyboard users keep their place. Real keys via page.keyboard (locator.press re-focuses the target first,
// which hides focus loss; the PR's own spec uses it). REVIEW-FAIL on 677cf2b: the list disables every handle and arrow
// while a save is in flight (ReorderList disabled={!macOnline || busy}), and a focused control that becomes disabled
// loses focus to <body>, so after each drop or Move the keyboard / screen-reader user starts again from the top.

async function addThread(page: Page, scope: ReturnType<Page['locator']>, name: string) {
  await scope.getByTestId('new-thread').click()
  const sheet = page.getByTestId('thread-settings')
  await sheet.getByLabel('Name').fill(name)
  await sheet.getByRole('button', { name: 'Create thread' }).click()
  await expect(sheet).toBeHidden()
}

test('control: focus stays on the handle after a keyboard drop (desktop sidebar)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'sidebar is desktop only')
  await page.goto('/')
  const side = page.getByLabel('Sidebar')
  await addThread(page, side, 'Garden')
  await side.getByTestId('edit-threads').click()
  const handle = side.getByTestId('reorder-handle-garden')
  await handle.focus()
  await page.keyboard.press(' ')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press(' ')
  await expect(page.getByTestId('reorder-announce')).toContainText('dropped')
  await page.waitForTimeout(300)
  await expect(side.getByTestId('reorder-handle-garden')).toBeFocused()
})

test('REVIEW-FAIL: focus stays on Move down after using it (phone Threads tab)', async ({ page }, info) => {
  test.skip(info.project.name !== 'pixel', 'phone arrows')
  await page.goto('/threads')
  const main = page.locator('main')
  await addThread(page, main, 'Garden')
  await addThread(page, main, 'Trips')
  await main.getByTestId('edit-threads').click()
  const down = page.getByRole('button', { name: 'Move General down' })
  await down.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('reorder-announce')).toContainText('moved to position 2 of 3')
  await page.waitForTimeout(300)
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
  )
  expect(focused).toBe('Move General down')
})
