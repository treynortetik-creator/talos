// Small controls still take a 44 px tall touch: the switch draws 28 px but pads its hit area with a ::before.
import { expect, test } from '@playwright/test'

test('a switch answers a tap 20 px above or below its centre', async ({ page }) => {
  await page.goto('/schedules')
  const toggle = page.getByRole('switch').first()
  await expect(toggle).toBeVisible()
  const box = await toggle.boundingBox()
  if (!box) throw new Error('no switch box')
  expect(box.height).toBeLessThan(32) // drawn size unchanged
  const hit = await toggle.evaluate((el, b) => {
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    const at = (dy: number) => el.contains(document.elementFromPoint(x, y + dy))
    return [at(-20), at(20)]
  }, box)
  expect(hit).toEqual([true, true])
})
