// The Report a bug button in a thread on a phone (placement B): it sits in the message box's button row, on the left beside
// + (Attach), and the timeline keeps no room for it. Real app (fake mode), both themes, default phone and 320 x 568.
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../helpers/ios-readback.ts'

test.use({ bypassCSP: true })

const box = async (loc: Locator) => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const centreY = (b: { y: number; height: number }) => b.y + b.height / 2

async function open(page: Page, query = '') {
  await page.goto(`/t/general${query}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await expect(page.getByTestId('composer')).toBeVisible()
}
const bugIn = (page: Page) => page.getByTestId('thread-screen').getByTestId('bug-button')

const sizes = [
  { name: 'phone', viewport: null },
  { name: '320px phone', viewport: { width: 320, height: 568 } },
] as const

for (const size of sizes) {
  test.describe(size.name, () => {
    if (size.viewport) test.use({ viewport: size.viewport })
    // 'phone' takes the project's own device: the desktop project renders the desktop layout (no bug button in a thread,
    // the message box a column), which these phone checks do not describe. The 320 px block sets a phone viewport everywhere.
    if (!size.viewport) test.skip(({ isMobile }) => !isMobile, 'phone layout only')

    for (const colorScheme of ['light', 'dark'] as const) {
      test.describe(colorScheme, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme })
        })

        test('the bug button is in the message box, on the + row, to its right, and nothing covers it', async ({
          page,
        }) => {
          await open(page)
          const bug = bugIn(page)
          await expect(bug).toHaveCount(1)
          const composer = page.getByTestId('composer')
          await expect(composer.getByTestId('bug-button')).toBeVisible()
          await expect(bug).toHaveAttribute('aria-label', 'Report a bug')
          await expect(bug).toHaveAttribute('data-no-capture', '')
          const attach = composer.getByRole('button', { name: 'Attach' })
          const b = await box(bug)
          const a = await box(attach)
          expect(Math.abs(centreY(b) - centreY(a)), 'not on the + row').toBeLessThanOrEqual(4)
          expect(b.x, 'not to the right of +').toBeGreaterThanOrEqual(a.x + a.width - 0.5)
          expect(b.x - (a.x + a.width), 'not next to +').toBeLessThanOrEqual(16)
          // the same size and plain look as the other icon buttons of the row
          const mic = await box(composer.getByTestId('mic'))
          expect(b.width).toBeCloseTo(mic.width, 0)
          expect(b.height).toBeCloseTo(mic.height, 0)
          const look = await bug.evaluate((el) => {
            const s = getComputedStyle(el)
            return { border: s.borderTopWidth, shadow: s.boxShadow, bg: s.backgroundColor }
          })
          expect(look.border).toBe('0px')
          expect(look.shadow).toBe('none')
          expect(look.bg).toBe('rgba(0, 0, 0, 0)')
          // not over the buttons on the right either
          expect(b.x + b.width).toBeLessThanOrEqual(mic.x)
          const covered = await bug.evaluate((el) => {
            const r = el.getBoundingClientRect()
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            return hit === null || !el.contains(hit)
          })
          expect(covered, 'something covers the bug button').toBe(false)
        })

        test('a tap opens the bug report', async ({ page }) => {
          await open(page)
          await bugIn(page).click()
          await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible()
        })

        test('the timeline reserves only 16 px under the last row, and the button costs the message box no height', async ({
          page,
        }) => {
          await open(page)
          await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)
          const pad = await page.getByTestId('timeline').evaluate((el) => getComputedStyle(el).paddingBottom)
          expect(pad).toBe('16px')
          const withBtn = await box(page.getByTestId('composer'))
          const tlWith = await box(page.getByTestId('timeline'))
          await open(page, '?bugbtn=a')
          await expect(page.getByTestId('composer').getByTestId('bug-button')).toHaveCount(0)
          const without = await box(page.getByTestId('composer'))
          // WebKit lays the box out at 111 or 112 px from one load to the next, with or without the button: 1 px of rounding.
          // A button that cost a row would add about 44 px, so "within 1 px" still catches it.
          expect(
            Math.abs(withBtn.height - without.height),
            'the button made the message box taller',
          ).toBeLessThanOrEqual(1)
          const tlWithout = await box(page.getByTestId('timeline'))
          expect(Math.abs(tlWith.height - tlWithout.height)).toBeLessThanOrEqual(1)
          await page.evaluate(() => localStorage.removeItem('talos.bugbtn'))
        })
      })
    }
  })
}

test('placement A keeps the icon out of the message box', async ({ page }) => {
  await open(page, '?bugbtn=a')
  await expect(page.getByTestId('composer').getByTestId('bug-button')).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('talos.bugbtn'))
})
