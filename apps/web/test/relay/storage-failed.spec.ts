// The device's own storage will not open at startup: the owner sees what happened and a way forward, never the endless
// splash. Fits a phone, takes focus on the button, works by keyboard in both themes, and Try again recovers.
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../helpers/fixtures.ts'
import { waitUntil } from '../helpers/util.ts'

// `refuse`: the open itself fails. `dead`: the open works and the connection then fails every transaction, for good (a
// WebKit tab that lost its database). A new connection, opened after the fault is lifted, works.
for (const [scheme, mode] of [
  ['light', 'refuse'],
  ['dark', 'refuse'],
  ['light', 'dead'],
  ['dark', 'dead'],
] as const) {
  test(`unreadable storage at start shows a Try again screen and recovers (${scheme}, ${mode})`, async ({
    page,
    context,
    harness,
  }, info) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await harness.seedDevice(context, page)
    // From here on the page's IndexedDB opens fail, as a lost WebKit connection or a locked profile does.
    await page.addInitScript((how) => {
      const w = window as unknown as { __idbBroken: boolean }
      w.__idbBroken = true
      const dead = new WeakSet<object>()
      const real = IDBFactory.prototype.open
      IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
        if (how === 'refuse' && w.__idbBroken)
          throw new DOMException('The database connection is closing.', 'InvalidStateError')
        const req = real.call(this, name, version)
        // a connection opened while broken stays dead for ever, even after the fault is lifted
        if (how === 'dead') req.addEventListener('success', () => w.__idbBroken && dead.add(req.result))
        return req
      }
      const tx = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...a: Parameters<typeof tx>) {
        if (dead.has(this)) throw new DOMException('The database connection is closing.', 'InvalidStateError')
        return tx.apply(this, a)
      } as typeof tx
    }, mode)
    await page.goto('/t/general')

    const retry = page.getByRole('button', { name: 'Try again' })
    await expect(retry).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('Nothing was deleted')
    await expect(retry).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const box = await retry.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    await page.screenshot({ path: info.outputPath(`storage-failed-${scheme}.png`) })

    // Still broken: Try again by keyboard stays on the error rather than going blank.
    await page.keyboard.press('Enter')
    await expect(retry).toBeVisible()

    await page.evaluate(() => {
      ;(window as unknown as { __idbBroken: boolean }).__idbBroken = false
    })
    await page.keyboard.press('Enter')
    await waitUntil(() => harness.relay.appCount > 0, 'app socket')
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    await expect(retry).toHaveCount(0)
  })
}
