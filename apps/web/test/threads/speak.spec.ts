// Read aloud, the Listen button on an agent message, in a real browser (fake mode, VITE_FAKE=1): it is on the message, it
// shows Preparing and a failure in words, focus stays on the button, nothing overflows a phone, and it reads in both themes.
// The fake Mac has no voice command, so the tap ends in the plain-words failure; no audio is ever made or played.
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function open(page: import('@playwright/test').Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('msg-agent').first()).toBeVisible()
}
const noHorizontalScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Listen: idle, preparing, failed; keyboard; fits the phone; accessible (${colorScheme})`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await open(page)
    const row = page.getByTestId('msg-agent').first()
    const button = row.getByTestId('speak')
    await expect(button).toHaveAccessibleName('Listen to this message')
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await noHorizontalScroll(page)).toBe(true)
    await row.screenshot({ path: info.outputPath(`speak-idle-${colorScheme}.png`) })

    // keyboard: Tab can reach it, Enter asks
    await button.focus()
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('data-state', 'loading')
    await expect(button).toHaveAccessibleName('Cancel preparing audio')
    await expect(button).toBeFocused() // the button stays put, so a keyboard user keeps their place
    await row.screenshot({ path: info.outputPath(`speak-preparing-${colorScheme}.png`) })

    // the fake Mac answers 'working' once, then says it has no voice
    const alert = row.getByTestId('speak-status')
    await expect(alert).toContainText('no voice set up', { timeout: 8000 })
    await expect(alert).toHaveAttribute('role', 'alert')
    await expect(button).toHaveAccessibleName('Try again to this message')
    await expect(button).toBeFocused()
    expect(await noHorizontalScroll(page)).toBe(true)
    await row.screenshot({ path: info.outputPath(`speak-failed-${colorScheme}.png`) })
    const axe = await new AxeBuilder({ page }).include('[data-testid="msg-agent"]').analyze()
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}

test('the Mac being offline is said in words, not as an empty or loading row', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const t = (window as unknown as { __talos: { setMacOnline?: (b: boolean) => void } }).__talos
    t.setMacOnline?.(false)
  })
  const button = page.getByTestId('msg-agent').first().getByTestId('speak')
  await button.click()
  await expect(page.getByTestId('msg-agent').first().getByTestId('speak-status')).toContainText('offline')
})
