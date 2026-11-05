// When the relay has no OpenAI key the app says how to turn live voice on; when voice is on, the note never shows.
// Fake mode: `?voice=off` stands in for `/api/me` answering voice.available=false.
import { expect, test } from '@playwright/test'

const NOTICE = /Live voice is off\. Add OPENAI_API_KEY to your relay's environment/

test('voice off: the call button explains, with a setup link, and no console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('/t/general?voice=off')
  const button = page.getByRole('button', { name: 'Start a live call' })
  await expect(button).toHaveAttribute('title', /Live voice is off/)
  await expect(page.getByTestId('voice-off-notice')).toHaveCount(0)
  await button.click()
  const notice = page.getByTestId('voice-off-notice')
  await expect(notice).toContainText(NOTICE)
  await expect(notice.getByRole('link', { name: 'How to set this up' })).toHaveAttribute(
    'href',
    /docs\/SETUP\.md#voice$/,
  )
  await page.screenshot({ path: test.info().outputPath(`call-button-${test.info().project.name}.png`) })
  // Voice notes still record: the mic button is there and enabled.
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([])
})

test('voice off: Settings -> Voice shows the same note', async ({ page }) => {
  await page.goto('/settings/voice?voice=off')
  await expect(page.getByTestId('voice-off-notice')).toContainText(NOTICE)
  await page.screenshot({
    path: test.info().outputPath(`settings-voice-${test.info().project.name}.png`),
    fullPage: true,
  })
})

test('voice on: no note on the call button or in Settings', async ({ page }) => {
  await page.goto('/t/general')
  await expect(page.getByRole('button', { name: 'Start a live call' })).not.toHaveAttribute('title', /.+/)
  await page.goto('/settings/voice')
  await expect(page.getByLabel('Voice settings')).toBeVisible()
  await expect(page.getByTestId('voice-off-notice')).toHaveCount(0)
})
