// The thread tab strip under the chat header is gone (owner ask, 2026-11-05: every thread is already in the left list).
// Absent at phone and desktop widths, and every thread is still one step away: the sidebar on a wide screen, the header's
// Open menu button and its list on a phone.
import { expect, type Page, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

async function seed(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async () => {
    const c = (
      window as unknown as {
        __talos: {
          store: { getState: () => { config: { threads: unknown[] } } }
          patchConfig: (p: unknown) => Promise<void>
        }
      }
    ).__talos
    const mk = (id: string, name: string, order: number) => ({
      id,
      name,
      kind: 'fixed',
      order,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    })
    await c.patchConfig({
      threads: [...c.store.getState().config.threads, mk('work', 'Work', 2), mk('daily', 'Daily', 3)],
    })
  })
}

test('no thread tab strip under the chat header, and every thread is still reachable', async ({ page }) => {
  await page.goto('/t/general')
  await seed(page)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await expect(page.getByTestId('thread-tabs')).toHaveCount(0)
  // the strip was the only navigation named "Threads" inside the thread screen
  await expect(page.getByTestId('thread-screen').getByRole('navigation', { name: 'Threads' })).toHaveCount(0)
  const names = ['General', 'Work', 'Daily', 'Inbox']
  if (isPhoneWidth(page)) {
    const open = page.getByTestId('phone-menu-button')
    await expect(open).toBeVisible() // a visible way in, not only the edge swipe
    await open.click()
    const menu = page.getByTestId('phone-menu')
    await expect(menu).toBeVisible()
    for (const n of names.filter((x) => x !== 'General'))
      await expect(menu.getByRole('link', { name: new RegExp(n) })).toBeVisible()
    await menu.getByRole('link', { name: /Work/ }).click()
    await expect(page).toHaveURL(/\/t\/work$/)
  } else {
    const side = page.getByRole('complementary', { name: 'Sidebar' })
    for (const n of names) await expect(side.getByRole('link', { name: new RegExp(`^${n}`) })).toBeVisible()
    await side.getByRole('link', { name: /^Work/ }).click()
    await expect(page).toHaveURL(/\/t\/work$/)
  }
  await expect(page.getByTestId('thread-tabs')).toHaveCount(0)
})
