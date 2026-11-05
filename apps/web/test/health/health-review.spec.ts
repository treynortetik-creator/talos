// Adversarial review of PR #47 (WP-V1), web half. Fake-mode app, GET /api/status answered by the test. These fail on
// feat/v2-v1: the feature exists only behind a push tap or a typed URL.
//   R1  the Home banner (V2.5) is never mounted, so a quiet mod or a long-offline Mac shows nothing in the app;
//   R2  Settings has no Health entry (the PR's Request 3 asks WP-C3 for a sheet link; Settings itself is the obvious home);
//   R3  "Send test alert" says "sent" while the screen itself says nobody can be alerted.
import { expect, type Page, test } from '@playwright/test'
import type { HealthStatusT } from '@talos-app/protocol'
import { AT, statusOf } from './status.ts'

test.use({ serviceWorkers: 'block' })

async function serve(page: Page, body: HealthStatusT) {
  await page.clock.install({ time: new Date(AT) })
  await page.route('**/api/status', (r) => r.fulfill({ json: body }))
  await page.route('**/api/health/test', (r) => r.fulfill({ status: 204 }))
}
const ready = (page: Page) => page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))

test('R1 Home shows the health banner when the mod stopped reporting', async ({ page }) => {
  await serve(
    page,
    statusOf({
      mac_problems: ['mod_quiet'],
      mod: { state: 'quiet', last_seen: '2026-10-29T19:40:00.000Z', expected: true },
    }),
  )
  await page.goto('/')
  await ready(page)
  await expect(page.getByTestId('health-banner')).toContainText('Your mod stopped reporting.')
})

test('R2 Settings lists Health and it opens /settings/health', async ({ page }) => {
  await serve(page, statusOf())
  await page.goto('/settings')
  await ready(page)
  const link = page.getByRole('link', { name: /health/i }).first()
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/settings\/health$/)
})

test('R3 with nobody to alert, the test button does not claim the alert is on its way', async ({ page }) => {
  await serve(
    page,
    statusOf({
      relay_ok: false,
      relay_problems: ['no_alert_path'],
      push: { subscriptions: 0, last_ok_at: null, last_error_at: null },
      ntfy: false,
    }),
  )
  await page.goto('/settings/health')
  await ready(page)
  await expect(page.getByTestId('health-row-alerts')).toContainText('Nobody can be alerted')
  await page.getByRole('button', { name: 'Send test alert' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText('It should arrive in a few seconds')).toHaveCount(0)
})
