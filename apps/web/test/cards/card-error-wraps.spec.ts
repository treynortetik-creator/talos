import { expect, test } from '@playwright/test'
import { open } from './e2e.ts'
import { IDS } from './harness/seed.ts'

const PHONE = { width: 375, height: 812 }

test('a long unbroken error line wraps inside the card at phone width', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await open(page, '/cards', { seed: 'full' })
  // The relay's sentence is shown as it is: 120 characters with no space to break at.
  await page.evaluate(() => {
    window.__talos.resolveCard = async () => {
      throw new window.TalosClientError('internal', 'x'.repeat(120))
    }
  })
  const article = page.locator(`[data-card-id="${IDS.low}"]`)
  await article.getByRole('button', { name: 'Kill draft' }).click()
  await expect(article.getByRole('alert')).toHaveText('x'.repeat(120))
  const page_ = await page.evaluate(() => document.documentElement.scrollWidth)
  const card = await article.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(page_).toBeLessThanOrEqual(PHONE.width)
  expect(card).toBeLessThanOrEqual(0)
})
