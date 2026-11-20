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

/** The ids of the reorder rows in `scope`, top to bottom, as the page draws them now. */
function rowOrder(scope: ReturnType<Page['locator']>) {
  return scope.locator('[data-reorder-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-reorder-row')))
}

test('control: focus stays on the handle after a keyboard drop (desktop sidebar)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'sidebar is desktop only')
  await page.goto('/')
  const side = page.getByLabel('Sidebar')
  await addThread(page, side, 'Garden')
  await side.getByTestId('edit-threads').click()
  const handle = side.getByTestId('reorder-handle-garden')
  const orderBefore = (await rowOrder(side)).filter((id): id is string => id !== null)
  const was = orderBefore.indexOf('garden')
  expect(was).toBeGreaterThan(0)
  const passed = orderBefore[was - 1] as string // the row Garden moves past
  await handle.focus()
  await page.keyboard.press(' ')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press(' ')
  await expect(page.getByTestId('reorder-announce')).toContainText('dropped')
  // the reorder is on screen (Garden drawn above the row it passed): focus is checked after the list re-rendered
  await expect
    .poll(async () => {
      const order = await rowOrder(side)
      return order.indexOf('garden') < order.indexOf(passed)
    })
    .toBe(true)
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
  // the reorder is on screen (General drawn below Garden): focus is checked after the list re-rendered
  await expect
    .poll(async () => {
      const order = await rowOrder(main)
      return order.indexOf('general') > order.indexOf('garden')
    })
    .toBe(true)
  // focus comes back a frame after the rows move (ReorderList puts it back in requestAnimationFrame): poll for it
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName),
    )
    .toBe('Move General down')
})
