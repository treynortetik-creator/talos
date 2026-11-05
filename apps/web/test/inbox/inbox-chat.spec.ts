import { expect, test } from '@playwright/test'

// The Inbox thread is a normal thread plus event cards: what the owner says and what the agent answers must show on it.
test('Inbox screen shows the owner message and the agent reply', async ({ page }) => {
  await page.goto('/t/inbox')
  const box = page.getByLabel('Message', { exact: true })
  await box.fill('what needs me today')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').getByText('what needs me today')).toBeVisible()
  await expect(page.getByTestId('msg-agent').getByText('echo: what needs me today')).toBeVisible()
  // The event tabs stay on top.
  await expect(page.getByRole('tab', { name: /^Priority/ })).toBeVisible()
})

test('Settings shows the Integrations label, with the one-line explanation on its page', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByText('Integrations', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Webhooks', { exact: true })).toHaveCount(0)
  await page.goto('/settings/integrations')
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
  await expect(
    page.getByText(
      "Apps and webhooks that send events to your Inbox. Your agent's own tools and connectors are set up in Claude Code.",
    ),
  ).toBeVisible()
})
