// Browser check of the two controls added with trust mode, at phone width and desktop, by keyboard, in both themes, and
// with the failed state: the permission-relay switch (Health) and the work wording and retention (Work systems).
import { expect, type Page, test } from '@playwright/test'
import { statusOf } from '../health/status.ts'

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

test.use({ serviceWorkers: 'block' }) // page.route must see /api/status

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('talos-theme', t), theme)
    })

    test('Health: the permission relay switch works by keyboard and keeps focus', async ({ page }) => {
      await page.goto('/settings/health')
      const sw = page.getByRole('switch', { name: /Tool prompts as approval cards/ })
      await expect(sw).toBeVisible()
      await sw.focus()
      const before = await sw.getAttribute('aria-checked')
      await page.keyboard.press('Space')
      await expect(page.getByRole('status').filter({ hasText: 'Restart the agent' })).toBeVisible()
      await expect(sw).not.toHaveAttribute('aria-checked', before ?? '')
      await expect(sw).toBeFocused()
      const box = await sw.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24)
      await noSideways(page)
    })

    test('Health: saved On but the session did not declare it reads "On after restart", by keyboard, no sideways scroll', async ({
      page,
    }) => {
      await page.route('**/api/status', (r) =>
        r.fulfill({ json: { ...statusOf(), beat: { ...statusOf().beat, permission_relay_declared: false } } }),
      )
      await page.goto('/settings/health')
      await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
      await page.evaluate(() => {
        const c = (window as unknown as { __talos: { store: { setState: (f: (s: never) => never) => void } } }).__talos
        c.store.setState(
          (s: never) =>
            ({
              ...(s as object),
              config: { ...(s as { config: object }).config, permission_relay: true },
            }) as never,
        )
      })
      const sw = page.getByRole('switch', { name: /Tool prompts as approval cards: On after restart/ })
      await expect(sw).toBeVisible()
      await expect(page.getByTestId('permission-relay-state')).toContainText('Restart session')
      await expect(page.getByTestId('permission-relay-state')).toContainText(
        'quit and restart Claude Code in your terminal',
      )
      await sw.focus()
      await expect(sw).toBeFocused()
      await noSideways(page)
    })

    test('Work systems: wording saves, the empty name is refused, retention changes', async ({ page }) => {
      await page.goto('/settings/integrations')
      const name = page.getByLabel('What to call work systems')
      await expect(name).toBeVisible()
      const save = page.getByRole('button', { name: 'Save wording' })
      await expect(save).toBeDisabled()
      await name.fill('   ')
      await save.click()
      await expect(page.getByRole('alert')).toContainText('can’t be empty')
      await name.fill('Office tools')
      await name.press('Enter')
      await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
      await page.getByLabel('Events from work systems').selectOption('buffer')
      await expect(page.getByLabel('Events from work systems')).toHaveValue('buffer')
      await noSideways(page)
    })
  })
}
