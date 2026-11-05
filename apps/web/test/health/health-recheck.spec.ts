// Re-check probes for PR #47 after the review fixes: the banner shows once, wherever Home is drawn.
import { expect, type Page, test } from '@playwright/test'
import { AT, statusOf } from './status.ts'

test.use({ serviceWorkers: 'block' })
const ready = (page: Page) => page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
const quiet = statusOf({
  mac_problems: ['mod_quiet'],
  mod: { state: 'quiet', last_seen: '2026-10-29T19:40:00.000Z', expected: true },
})

for (const path of ['/', '/t/general', '/settings']) {
  test(`one health banner on ${path}`, async ({ page }) => {
    await page.clock.install({ time: new Date(AT) })
    await page.route('**/api/status', (r) => r.fulfill({ json: quiet }))
    await page.goto(path)
    await ready(page)
    await expect(page.getByTestId('health-banner').first()).toBeVisible()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('health-banner')).toHaveCount(1)
  })
}
