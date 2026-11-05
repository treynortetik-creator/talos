// Trust mode switch in Settings, Account, in a real browser (fake mode): phone and desktop, both themes, by keyboard, and in its
// failed and Mac-offline states. The fake client refuses what the relay refuses (turning it on without a passkey token).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })
const SHOTS = process.env.SHOT_DIR
type Talos = { failNextPatchWith: (code: string) => void; setMacOnline: (on: boolean) => void }
const talos = (page: Page, f: (t: Talos) => void) => page.evaluate(`(${f.toString()})(window.__talos)`)

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('talos-theme', t), theme)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.goto('/settings/account')
      await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
    })
    const sw = (page: Page) => page.getByRole('switch', { name: /Trust mode/ })

    test('by keyboard: Space turns it on (passkey step, then On), Space again turns it off, focus stays', async ({
      page,
    }, info) => {
      await expect(sw(page)).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('trust-mode-state')).toContainText('Turning it on asks for your passkey')
      await sw(page).focus()
      await page.keyboard.press('Space')
      await expect(sw(page)).toHaveAttribute('aria-checked', 'true')
      await expect(sw(page)).toBeFocused()
      await expect(page.getByTestId('trust-mode-state')).toContainText('Turning it off needs no passkey')
      // the switch's own transition must be over before the picture is taken
      await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished)).then(() => undefined))
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: join(SHOTS, `${info.project.name}-trust-on-${theme}.png`) })
      }
      await page.keyboard.press('Space')
      await expect(sw(page)).toHaveAttribute('aria-checked', 'false')
      await expect(sw(page)).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test('a refusal (an older Mac) shows in words, the switch stays Off', async ({ page }) => {
      await talos(page, (t) => t.failNextPatchWith('config_field_forbidden'))
      await sw(page).focus()
      await page.keyboard.press('Space')
      await expect(page.getByRole('alert')).toContainText('older than this setting')
      await expect(sw(page)).toHaveAttribute('aria-checked', 'false')
    })

    test('Mac offline: disabled, and says why', async ({ page }) => {
      await talos(page, (t) => t.setMacOnline(false))
      await expect(sw(page)).toBeDisabled()
      await expect(page.getByTestId('trust-mode-state')).toContainText('Mac has to be online')
    })

    test('axe clean', async ({ page }) => {
      await expectAxeClean(page, ['main'])
    })
  })
}
