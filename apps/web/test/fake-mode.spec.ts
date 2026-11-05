import { expect, test } from '@playwright/test'
import { isPhoneWidth, threadSwitcher } from './helpers/phone.ts'

// VITE_FAKE=1 (the in-memory client): what WP4 and WP7 build against must keep working.
test('fake mode boots into the shell with seeded threads', async ({ page }) => {
  await page.goto('/t/general')
  await expect(
    isPhoneWidth(page) ? page.getByTestId('phone-header') : page.getByRole('complementary', { name: 'Sidebar' }),
  ).toBeVisible()
  await expect(page.getByTestId('msg-agent').getByText('Hi. I am a fake agent.')).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('ping')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-agent').getByText('echo: ping')).toBeVisible()
})

test('fake mode: thread list and Ctrl+2', async ({ page }) => {
  await page.goto('/t/general')
  // Ctrl+2 resolves against the loaded thread list and is a silent no-op until it arrives, so wait for the tabs
  // themselves (the real precondition), not just the empty tab bar.
  const phone = isPhoneWidth(page)
  let tabs = await threadSwitcher(page)
  await expect(tabs.locator('a[href="/t/general"]')).toHaveAttribute('aria-current', 'page')
  await expect(tabs.locator('a[href="/t/inbox"]')).toBeVisible()
  if (phone) await page.keyboard.press('Escape')
  await page.keyboard.press('Control+2')
  await expect(page).toHaveURL(/\/t\/inbox$/)
  tabs = await threadSwitcher(page)
  await expect(tabs.locator('a[href="/t/inbox"]')).toHaveAttribute('aria-current', 'page')
})

test('fake mode: settings sections, appearance switch', async ({ page }) => {
  await page.goto('/settings/appearance')
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('radio', { name: 'System' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)
})
