// WP-I6 / audit O1: in an app shell with no passkey, a high-risk Approve says where to approve instead of "cancelled",
// sends nothing, and the card stays pending. In a plain browser nothing changes (cards.spec.ts covers that path).
import { expect, test } from '@playwright/test'
import { expectAxeClean, open, sentFrames } from './e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const IPHONE_SHELL = () => {
  const w = window as unknown as Record<string, unknown>
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
}
const MAC_SHELL = () => {
  const w = window as unknown as Record<string, unknown>
  w.webkit = { messageHandlers: { talos: { postMessage: () => {} } } }
  Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Macintosh) TalosDesktop/1.0' })
}

for (const [name, init, copy, confirm] of [
  [
    'iPhone app, relay not linked',
    IPHONE_SHELL,
    "This app can't use your passkey yet. Approve in Safari or the Home Screen app.",
    'Confirm with Face ID', // an iPhone says Face ID
  ],
  ['Mac app', MAC_SHELL, 'Approve on your phone or in a browser.', "Confirm it's you"], // a Mac does not
] as const) {
  test(`${name}: enabling a work integration says where to approve, never "cancelled", and sends nothing`, async ({
    page,
  }) => {
    await page.addInitScript(init)
    await open(page, '/settings/integrations')
    await page.locator('[data-tile="slack"]').click()
    await page.getByRole('button', { name: confirm }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toHaveText(copy)
    await expect(alert).not.toContainText(/cancel/i)
    expect(await sentFrames(page)).toEqual([])
    await expect(page.locator('[data-tile="slack"]')).toHaveAttribute('data-locked', 'true')
    await expectAxeClean(page)
  })
}
