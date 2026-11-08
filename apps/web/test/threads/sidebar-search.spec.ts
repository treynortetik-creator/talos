// Search lives in the thread list: a magnifier beside + and the pencil turns that row into a search box, and the results
// replace the threads right there (the same search the /search screen runs). Esc or the cross puts the list back. There is
// no "Threads" label and no bottom "Search" row on desktop, and the phone menu has the same row with no current-thread card.
import { expect, type Page, test } from '@playwright/test'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

/** The list the owner searches from: the desktop sidebar, or the phone menu after it slid in. */
async function scope(page: Page) {
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    return page.getByTestId('phone-menu')
  }
  return page.getByRole('complementary', { name: 'Sidebar' })
}

test('the magnifier turns the row into a search box and the results take the threads place', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  await expect(nav.getByRole('link', { name: 'Inbox' })).toBeVisible()
  await nav.getByRole('button', { name: 'Search threads' }).click()
  const box = nav.getByRole('searchbox', { name: 'Search all threads' })
  await expect(box).toBeFocused()
  await box.fill('fake agent')
  const hit = nav.getByTestId('hit-row').first()
  await expect(hit).toContainText('fake agent')
  // the thread list is gone while the results are there
  await expect(nav.getByRole('link', { name: 'Inbox' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Schedules' })).toHaveCount(0)
  // a result opens its message in context and puts the list back
  await hit.click()
  await expect(page).toHaveURL(/\/t\/general\?m=/)
})

test('Escape and the cross both restore the thread list', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  for (const how of ['Escape', 'cross'] as const) {
    await nav.getByRole('button', { name: 'Search threads' }).click()
    await nav.getByRole('searchbox', { name: 'Search all threads' }).fill('fake')
    await expect(nav.getByTestId('hit-row').first()).toBeVisible()
    if (how === 'Escape') await page.keyboard.press('Escape')
    else await nav.getByRole('button', { name: 'Close search' }).click()
    await expect(nav.getByRole('searchbox')).toHaveCount(0)
    await expect(nav.getByTestId('hit-row')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Inbox' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Search threads' })).toBeVisible()
  }
})

test('a search with nothing found says so', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  await nav.getByRole('button', { name: 'Search threads' }).click()
  await nav.getByRole('searchbox', { name: 'Search all threads' }).fill('zzzqqq')
  await expect(nav.getByText(/Nothing found/)).toBeVisible()
})

test('search, new and edit sit in one row, and there is no "Threads" label', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  const names = ['Search threads', 'Add a thread', 'Manage threads']
  const boxes = await Promise.all(names.map((n) => nav.getByRole('button', { name: n }).boundingBox()))
  for (const b of boxes) expect(b).not.toBeNull()
  const ys = boxes.map((b) => Math.round((b?.y ?? 0) + (b?.height ?? 0) / 2))
  expect(new Set(ys).size).toBe(1)
  await expect(nav.getByText('Threads', { exact: true })).toHaveCount(0)
})

test('desktop has no bottom "Search" row; phone has no current-thread card', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  await expect(nav.getByRole('link', { name: 'Search', exact: true })).toHaveCount(0)
  if (isPhoneWidth(page)) {
    await expect(nav.getByTestId('phone-menu-current')).toHaveCount(0)
    await expect(nav.getByTestId('thread-purpose')).toHaveCount(0)
    await expect(nav.getByText('Search this thread')).toHaveCount(0)
    // the thread on screen is an ordinary row of the list now
    await expect(nav.getByRole('link', { name: 'General' })).toBeVisible()
  }
})

test('the folded rail still reaches search: its magnifier unfolds the sidebar into search', async ({ page }) => {
  test.skip(isPhoneWidth(page), 'the rail is a desktop control')
  await page.goto('/t/general')
  await page.getByTestId('sidebar-toggle').click()
  const rail = page.getByRole('complementary', { name: 'Sidebar' })
  await expect(rail).toHaveAttribute('data-collapsed', 'true')
  await rail.getByRole('button', { name: 'Search threads' }).click()
  await expect(rail).toHaveAttribute('data-collapsed', 'false')
  await expect(rail.getByRole('searchbox', { name: 'Search all threads' })).toBeFocused()
})

test('closing the search puts focus on the magnifier, not on the page (Escape and the cross)', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  for (const how of ['Escape', 'cross'] as const) {
    await nav.getByRole('button', { name: 'Search threads' }).click()
    await nav.getByRole('searchbox', { name: 'Search all threads' }).fill('fake')
    if (how === 'Escape') await page.keyboard.press('Escape')
    else await nav.getByRole('button', { name: 'Close search' }).click()
    await expect(nav.getByRole('searchbox')).toHaveCount(0)
    await expect(nav.getByRole('button', { name: 'Search threads' })).toBeFocused()
  }
})

test('the results end with a link to the full search, carrying the query', async ({ page }) => {
  await page.goto('/t/general')
  const nav = await scope(page)
  await nav.getByRole('button', { name: 'Search threads' }).click()
  await nav.getByRole('searchbox', { name: 'Search all threads' }).fill('fake agent')
  await expect(nav.getByTestId('hit-row').first()).toBeVisible()
  const all = nav.getByRole('link', { name: 'See all results' })
  await expect(all).toHaveAttribute('href', '/search?q=fake%20agent')
  await all.click()
  await expect(page).toHaveURL(/\/search\?q=fake%20agent$/)
})
