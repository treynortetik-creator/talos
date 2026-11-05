import { expect, type Page, test } from '@playwright/test'

// Fake mode (VITE_FAKE=1): the fake client cannot ask a Mac, so an expired file ends in the failed state, which is the
// state this spec drives (the HTML card, images and audio are driven in old-attachments.test.tsx): the relay answers 410 (HEAD and GET), the chip says it is loading, then (clock moved past the
// client timeout) says it failed, with a Retry a thumb can hit. Once the relay has the file again, Retry gives a real link.
async function sendFile(page: Page, name: string, mime: string, body: string) {
  await page.goto('/t/general')
  await page.getByTestId('pick-files').setInputFiles({ name, mimeType: mime, buffer: Buffer.from(body) })
  await page.getByRole('button', { name: 'Send' }).click()
}

for (const scheme of ['light', 'dark'] as const) {
  test(`expired file chip: loading, failed with Retry, then a real link (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    let gone = true
    await page.route('**/media/**', (r) =>
      gone
        ? r.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"gone","rehydrate":true}' })
        : r.fulfill({ status: 200, contentType: 'application/zip', body: 'PK' }),
    )
    await page.clock.install()
    await sendFile(page, 'old-report.zip', 'application/zip', 'PK')

    await expect(page.getByTestId('media-fetching')).toBeVisible()
    await expect(page.locator('a[download]')).toHaveCount(0) // no dead download link while it is out

    await page.clock.fastForward(25_000)
    const failed = page.getByTestId('media-failed')
    await expect(failed).toBeVisible()
    await expect(failed).toContainText("Couldn't load old-report.zip")
    await expect(page.getByTestId('media-fetching')).toHaveCount(0)

    const retry = page.getByRole('button', { name: 'Retry' })
    const box = (await retry.boundingBox()) as { height: number }
    expect(box.height).toBeGreaterThanOrEqual(43) // a thumb target
    // phone width: nothing pushes the page sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await retry.focus()
    gone = false
    await page.keyboard.press('Enter') // by keyboard
    const link = page.locator('a[download]')
    await expect(link).toHaveCount(1)
    await expect(link).toHaveAttribute('href', /\/media\/md_/)
  })
}
