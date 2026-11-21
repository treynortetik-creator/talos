// "Report a bug" where the owner looks for it (they did not find it in Help or the palette): the thread's "..." menu on a
// computer, the menu on a phone, and Settings > Bug reports, which also holds where new reports are sent. The picture is of
// the screen behind, never of the menu that opened the reporter. ⌘K and Help still work (bug-report.spec.ts).

import { expect, type Page } from '@playwright/test'
import { BUG_WEBHOOK_URL_RULE } from '@talos-app/protocol'
import { test } from '../helpers/ios-readback.ts'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

async function open(page: Page, path = '/t/general') {
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const reporter = (page: Page) => page.getByRole('dialog', { name: 'Report a bug' })

test('from the thread menu (computer) or the menu (phone): the reporter opens with a picture of the screen behind', async ({
  page,
  browserName,
}, info) => {
  await open(page)
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    await page.getByTestId('menu-report-bug').click()
  } else {
    await page.getByRole('button', { name: 'Thread menu' }).click()
    const menu = page.getByRole('menu', { name: 'Thread menu' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Thread settings', 'Report a bug'])
    await menu.getByRole('menuitem', { name: 'Report a bug' }).click()
  }
  await expect(reporter(page)).toBeVisible()
  // the menu that opened it is gone, and the picture is a real one where the engine can read a drawn page back; WebKit, as on
  // an iPhone (ios-readback.ts), takes none and says so (capture.ts canReadBackPage, 2026-11-15)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('phone-menu')).toHaveCount(0)
  await expect(page.getByTestId('bug-canvas')).toHaveAttribute(
    'data-capture',
    browserName === 'webkit' ? 'failed' : 'ok',
  )
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.screenshot({ path: info.outputPath('reporter-from-menu.png') })
})

test('the thread menu still opens the thread settings, by mouse and by keyboard', async ({ page }) => {
  test.skip(isPhoneWidth(page), 'the phone reaches thread settings from its menu')
  await open(page)
  await page.getByRole('button', { name: 'Thread menu' }).click()
  await page.getByRole('menuitem', { name: 'Thread settings' }).click()
  await expect(page.getByTestId('thread-settings')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-settings')).toBeHidden()
  // The sheet hands focus back to the menu button in a timer after it unmounts (Radix onCloseAutoFocus, ThreadSettings'
  // backTo). Wait for that hand-back itself: one that landed after the Enter below took focus off the open menu (3 in 12 on
  // a busy Linux runner, 2 in 60 here under load). It is also what a keyboard user relies on.
  await expect(page.getByRole('button', { name: 'Thread menu' })).toBeFocused()
  await page.keyboard.press('Enter')
  // the menu opens on its first item: wait for that before moving, or the arrow lands before the menu is up
  await expect(page.getByRole('menuitem', { name: 'Thread settings' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Report a bug' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Thread settings' })).toBeFocused()
})

test('Settings > Bug reports: report a bug, and set, replace and turn off the webhook without ever seeing it again', async ({
  page,
}, info) => {
  await open(page, '/settings/bug-reports')
  const s = page.getByRole('region', { name: 'Bug reports' }).or(page.locator('section[aria-labelledby="bug-reports"]'))
  await expect(s.getByTestId('bug-webhook-state')).toHaveText(
    'Off: reports go to your Mac (through your Talos server) and nowhere else.',
  )
  const field = s.getByLabel('Send new reports to a webhook')

  // an address the relay would never call is refused here, in the relay's own words, and nothing is saved
  for (const bad of ['http://hooks.example.com/x', 'https://localhost/hook', 'https://user:pw@example.com/x']) {
    await field.fill(bad)
    await s.getByRole('button', { name: 'Save address' }).click()
    await expect(s.getByRole('alert')).toHaveText(BUG_WEBHOOK_URL_RULE)
  }
  await expect(s.getByTestId('bug-webhook-state')).toHaveText(
    'Off: reports go to your Mac (through your Talos server) and nowhere else.',
  )

  // a good one: saved with the passkey step, then only its host is shown; the address (and its token) never comes back
  await field.fill('https://hooks.example.com/services/T0/B0/secret-part')
  await s.getByRole('button', { name: 'Save address' }).click()
  await expect(s.getByRole('status')).toContainText('Saved')
  await expect(s.getByTestId('bug-webhook-state')).toHaveText('New reports go to hooks.example.com.')
  await expect(field).toHaveValue('')
  const shown = await page.evaluate(() =>
    JSON.stringify((window as unknown as { __talos: { store: { getState: () => unknown } } }).__talos.store.getState()),
  )
  expect(shown).not.toContain('secret-part')
  await page.screenshot({ path: info.outputPath('settings-bug-reports.png'), fullPage: true })

  await s.getByRole('button', { name: 'Turn off' }).click()
  await expect(s.getByTestId('bug-webhook-state')).toHaveText(
    'Off: reports go to your Mac (through your Talos server) and nowhere else.',
  )

  // and the reporter itself, from here
  await s.getByRole('button', { name: 'Report a bug' }).click()
  await expect(reporter(page)).toBeVisible()
})
