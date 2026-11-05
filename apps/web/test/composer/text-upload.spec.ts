// The owner's 2026-11-04 bug: attaching a meeting transcript (.txt) showed "csrf content type" with a Retry button.
// Fake mode (VITE_FAKE=1). Phone and desktop projects both run this.
import { expect, type Page, test } from '@playwright/test'

type Talos = { uploadMedia: (...a: unknown[]) => Promise<unknown> }

async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('composer')).toBeVisible()
}

test('attaching transcript-style text files uploads each one', async ({ page }) => {
  await open(page)
  const names = ['call.txt', 'call.md', 'call.csv', 'call.vtt', 'call.srt', 'call.json']
  const types = ['text/plain', 'text/markdown', 'text/csv', '', '', 'application/json']
  await page
    .getByTestId('pick-files')
    .setInputFiles(
      names.map((name, i) => ({ name, mimeType: types[i] as string, buffer: Buffer.from('Alex: hi\nBo: hello\n') })),
    )
  for (const name of names)
    await expect(page.getByTestId('chip').filter({ hasText: name })).toHaveAttribute('data-state', 'ready')
  await expect(page.getByText("Couldn't upload")).toHaveCount(0)
  await expect(page.getByText(/csrf/i)).toHaveCount(0)
})

test("a failed upload reads Couldn't upload (never a raw code) and offers Retry", async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    ;(window as unknown as { __talos: Talos }).__talos.uploadMedia = async () => {
      throw new Error('csrf_content_type')
    }
  })
  await page
    .getByTestId('pick-files')
    .setInputFiles({ name: 'call.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  const chip = page.getByTestId('chip').filter({ hasText: 'call.txt' })
  await expect(chip).toHaveAttribute('data-state', 'error')
  await expect(page.getByText(/csrf/i)).toHaveCount(0)
  await expect(chip.getByTestId('chip-status')).toHaveText(/^Couldn't upload/)
  await expect(chip.getByTestId('chip-retry')).toBeVisible()
})
