// CC-C3 screenshots for review: phone (iPhone 15 project) and desktop (1440x900) only.
import { expect, type Page, test } from '@playwright/test'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const DIR = '../../docs/screenshots/cc-c3'
// These rewrite tracked PNGs, so they run only on request (TALOS_SHOTS=1), like shell/phone-chat.spec.ts.
test.beforeEach(({ page: _page }, info) => {
  test.skip(!process.env.TALOS_SHOTS, 'screenshots are rewritten only with TALOS_SHOTS=1')
  test.skip(info.project.name === 'pixel', 'phone shots come from the iPhone project')
})

const kind = (name: string) => (name === 'iphone' ? 'phone' : 'desktop')

async function settle(page: Page) {
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  await page.waitForTimeout(250)
}

test('sheet (live)', async ({ page }, info) => {
  await page.goto('/t/general')
  await page.evaluate(() =>
    (window as never as { __talos: { session: { patch(p: object): void } } }).__talos.session.patch({
      busy: true,
      turn_id: 't1',
    }),
  )
  await page.getByTestId('session-trigger').click()
  await expect(page.getByTestId('session-sheet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIR}/sheet-${kind(info.project.name)}.png` })
})

test('picker', async ({ page }, info) => {
  await page.goto('/t/general')
  await expect(page.getByTestId('session-trigger')).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('/')
  await expect(page.getByRole('listbox')).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIR}/picker-${kind(info.project.name)}.png` })
})

for (const mod of ['offline', 'absent'] as const) {
  test(`mod ${mod}`, async ({ page }, info) => {
    await page.goto(`/t/general?fake_mod=${mod}`)
    await page.getByTestId('session-trigger').click()
    await expect(page.getByTestId('mod-hint')).toBeVisible()
    await settle(page)
    await page.screenshot({ path: `${DIR}/${mod}-${kind(info.project.name)}.png` })
  })
}
