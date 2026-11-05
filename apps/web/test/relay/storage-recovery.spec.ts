// The recovery screens in real Chromium and WebKit. Two ways storage fails: a second page holds the device database open at
// its old version (the app's open never answers: "Taking too long?" is there from the first frame), and the browser refuses
// the open outright (the "can't open its storage" screen). Both end in Try again and plain instructions for clearing this
// device's data; the app deletes nothing itself. Phone width, both themes, no sideways scroll.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'

async function holdDatabaseOpen(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('talos-app', 1)
        open.onsuccess = () => {
          ;(window as unknown as { __held: IDBDatabase }).__held = open.result // no onversionchange: it never closes by itself
          resolve()
        }
        open.onerror = () => reject(open.error)
      }),
  )
}
const releaseDatabase = (page: Page) =>
  page.evaluate(() => (window as unknown as { __held: IDBDatabase }).__held.close())

async function checkScreen(page: Page) {
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled()
  await expect(page.getByText("Clear this site's data in your browser's settings")).toBeVisible()
  await expect(page.getByText('every Talos tab in this browser')).toBeVisible()
  await expect(page.getByRole('button', { name: /reset|delete/i })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a stuck storage open: "Taking too long?" leads to Try again and the instructions (${scheme})`, async ({
    page,
    context,
    harness,
  }, info) => {
    await page.setViewportSize({ width: 375, height: 740 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await harness.seedDevice(context, page)
    const holder = await context.newPage()
    await holder.goto(`${harness.url}/manifest.webmanifest`)
    await holdDatabaseOpen(holder)

    await page.goto('/')
    await page.getByRole('button', { name: 'Taking too long?' }).click()
    await expect(page.getByText('Still opening Talos storage')).toBeVisible()
    await checkScreen(page)
    await page.screenshot({ path: info.outputPath(`recovery-opening-${scheme}.png`) })

    // the other page lets go: the open finishes by itself and Try again was never needed
    await releaseDatabase(holder)
    await expect(page.getByText('Still opening Talos storage')).toHaveCount(0)
  })

  test(`a storage the browser refuses to open shows Try again and the instructions (${scheme})`, async ({
    page,
    context,
    harness,
  }, info) => {
    await page.setViewportSize({ width: 375, height: 740 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await harness.seedDevice(context, page)
    await page.addInitScript(() => {
      const real = IDBFactory.prototype.open
      IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
        if (name === 'talos-app')
          throw new DOMException('The operation failed for unknown transient reasons.', 'UnknownError')
        return real.call(this, name, version)
      }
    })
    await page.goto('/')
    await expect(page.getByText("Talos can't open its storage")).toBeVisible()
    await checkScreen(page)
    await page.screenshot({ path: info.outputPath(`recovery-storage-${scheme}.png`) })
  })
}
