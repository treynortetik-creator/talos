// The desktop chat header after the clean-up: the status pill on the title's own line, no search icon, no Greek-key rule, no
// description line; "Search this thread" stays reachable from the thread's settings menu.
import { expect, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

test.describe('desktop chat header', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'desktop header only')

  test('the status pill sits beside the title on the same line', async ({ page }) => {
    await page.goto('/t/general')
    const title = await page.getByRole('heading', { level: 1, name: 'General' }).boundingBox()
    const pill = await page.getByTestId('status-word').first().boundingBox()
    expect(title && pill).toBeTruthy()
    if (!title || !pill) return
    expect(pill.x).toBeGreaterThanOrEqual(title.x + title.width - 1) // to the right of the title
    expect(Math.abs(pill.y + pill.height / 2 - (title.y + title.height / 2))).toBeLessThan(title.height / 2)
  })

  test('no search icon, no Greek-key rule, no description line', async ({ page }) => {
    await page.goto('/t/general')
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    await expect(page.getByTestId('thread-search')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Search this thread' })).toHaveCount(0)
    await expect(page.getByTestId('thread-screen').locator('[data-meander]')).toHaveCount(0)
    await expect(page.getByTestId('thread-purpose')).toHaveCount(0)
  })

  test('a thread with a topic still shows no description line; the topic is in the settings menu', async ({ page }) => {
    await page.goto('/t/general')
    await page.evaluate(async () => {
      const c = (
        window as unknown as {
          __talos: { store: { getState(): { threads: Array<{ id: string }> } }; patchConfig(p: unknown): Promise<void> }
        }
      ).__talos
      const cur = c.store.getState().threads
      await c.patchConfig({
        threads: cur.map((t) => (t.id === 'general' ? { ...t, topic: 'Everything that has no other home' } : t)),
      })
    })
    await expect(page.getByTestId('thread-purpose')).toHaveCount(0)
    await page.getByTestId('thread-settings-trigger').click()
    await expect(page.getByLabel('What goes here')).toHaveValue('Everything that has no other home')
  })

  test('"Search this thread" is in the thread settings menu and opens the search for that thread', async ({ page }) => {
    await page.goto('/t/general')
    await page.getByTestId('thread-settings-trigger').click()
    await page.getByRole('button', { name: 'Search this thread' }).click()
    await expect(page).toHaveURL(/\/search\?thread=general/)
  })
})

test('on a phone the thread settings sheet also offers "Search this thread"', async ({ page }) => {
  test.skip(!isPhoneWidth(page), 'phone only')
  await page.goto('/t/general?settings=1')
  await expect(page.getByTestId('thread-settings')).toBeVisible()
  await page.getByRole('button', { name: 'Search this thread' }).click()
  await expect(page).toHaveURL(/\/search\?thread=general/)
})
