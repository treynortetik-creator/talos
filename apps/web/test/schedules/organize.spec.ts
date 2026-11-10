// The Schedules page organized for many jobs, on the real shell: iPhone (WebKit, 390 wide), Pixel and desktop, both themes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { NOW_ISO } from './clock.ts'
import type { VariantName } from './variants.ts'

test.use({ bypassCSP: true })

async function open(page: Page, variant: VariantName = 'organized') {
  await page.clock.install({ time: new Date(NOW_ISO) })
  await page.goto(
    `/test/schedules/harness/index.html?${new URLSearchParams({ route: '/schedules', variant, threads: '1' })}`,
  )
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const chip = (page: Page, name: string) => page.getByRole('group', { name: 'Show only' }).getByRole('button', { name })
const toggle = (page: Page, key: string) => page.getByTestId(`group-toggle-${key}`)
const wide = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme })

    test('groups start shut; the failed one is open; the next job and its countdown sit on top', async ({ page }) => {
      await open(page)
      await expect(toggle(page, '__main__')).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle(page, 'trip')).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle(page, 'garden')).toHaveAttribute('aria-expanded', 'true')
      await expect(toggle(page, 'garden').getByTestId('group-failed')).toBeVisible()
      await expect(page.getByTestId('schedule-row-water-plants')).toBeVisible()
      await expect(page.getByTestId('schedule-row-packing-check')).toHaveCount(0)
      await expect(page.getByTestId('next-up')).toContainText('Soon job')
      // the page clock runs from the fixed start, so the second hand is a little past 45:00
      const countdown = page.getByTestId('next-up-countdown')
      await expect(countdown).toHaveText(/^in (45 min 00 s|44 min \d\d s)$/)
      const before = (await countdown.textContent()) ?? ''
      await page.clock.fastForward(5_000)
      await expect(countdown).not.toHaveText(before)
      await expect(countdown).toHaveText(/^in 44 min \d\d s$/)
      expect(await wide(page)).toBe(false)
    })

    test('a header opens its group with the keyboard; Edit is reachable', async ({ page, browserName }) => {
      await open(page)
      await toggle(page, 'trip').focus()
      await page.keyboard.press('Enter')
      await expect(toggle(page, 'trip')).toHaveAttribute('aria-expanded', 'true')
      const edit = page.getByRole('button', { name: 'Edit Packing check' })
      await edit.focus()
      await expect(edit).toBeFocused()
      await expect(edit).toBeEnabled()
      void browserName
    })

    test('chips narrow the list, and clear again', async ({ page }) => {
      await open(page)
      await chip(page, 'One-off').click()
      await expect(page.getByTestId('schedule-row-passport')).toBeVisible()
      await expect(page.getByTestId('schedule-row-water-plants')).toHaveCount(0)
      await chip(page, 'One-off').click()
      await chip(page, 'Failed').click()
      await expect(page.getByTestId('schedule-row-water-plants')).toBeVisible()
      await expect(page.getByTestId('schedule-row-passport')).toHaveCount(0)
    })

    test('search shows only past 15 jobs', async ({ page }) => {
      await open(page)
      await expect(page.getByRole('searchbox')).toHaveCount(0)
      await open(page, 'many')
      await page.getByRole('searchbox').fill('job 17')
      await expect(page.locator('li[data-testid^="schedule-row-"]')).toHaveCount(1)
    })

    test('with every group open there is no sideways scroll and axe is clean', async ({ page }) => {
      await open(page)
      for (const k of ['__main__', 'trip', 'oneoff']) await toggle(page, k).click()
      await expect(page.getByTestId('schedule-row-packing-check')).toBeVisible()
      expect(await wide(page)).toBe(false)
      await expectAxeClean(page)
    })

    test('journey: expand a thread, Edit a job, review the change; the card carries the new name', async ({ page }) => {
      await open(page)
      await toggle(page, 'trip').click()
      await page.getByRole('button', { name: 'Edit Packing check' }).click()
      await page.getByLabel('Name').fill('Packing list')
      await page.getByRole('button', { name: 'Review change' }).click()
      const card = page.locator('[data-card-state="pending"]')
      await expect(card).toContainText('Change scheduled job: Packing list')
      await expect(card).toContainText('your form')
      await expect(card.getByRole('button', { name: 'Save change' })).toBeVisible()
    })
  })
}

test.describe('screenshots', () => {
  test.skip(!process.env.SCHED_SHOTS, 'set SCHED_SHOTS to a directory to write them')
  for (const scheme of ['light', 'dark'] as const) {
    test(`organized list, ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(page)
      await toggle(page, 'trip').click()
      await page.waitForTimeout(250)
      const dir = process.env.SCHED_SHOTS as string
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: join(dir, `${info.project.name}-${scheme}-organized.png`) })
    })
  }
})

// The narrow layout the owner asked for (an iPhone-sized 390 x 844), whatever project runs it.
test.describe('phone 390 x 844', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: one-line rows fit, no sideways scroll, axe is clean, Edit and the switch are tappable`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(page)
      await toggle(page, 'trip').click()
      await expect(page.getByTestId('schedule-row-packing-check')).toBeVisible()
      expect(await wide(page)).toBe(false)
      const row = await page.getByTestId('schedule-row-packing-check').boundingBox()
      expect(row?.height).toBeLessThanOrEqual(48) // one line: the 44 px tap height plus its divider
      for (const b of [
        page.getByRole('button', { name: 'Edit Packing check' }),
        page.getByRole('switch', { name: 'Packing check runs on schedule' }),
      ]) {
        const box = await b.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(24)
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
      }
      await expectAxeClean(page)
      if (process.env.SCHED_SHOTS) {
        mkdirSync(process.env.SCHED_SHOTS, { recursive: true })
        await page.screenshot({
          path: join(process.env.SCHED_SHOTS, `${info.project.name}-390x844-${scheme}-organized.png`),
        })
      }
    })
  }
})
