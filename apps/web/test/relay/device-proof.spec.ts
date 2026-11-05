// Item 3 in a real browser, against the production bundle and the test harness's own copy of the relay rule (apps/web/test/
// helpers/harness.ts, not the real relay: the real relay is driven by e2e/tests/12-device-proof.spec.ts): sign-in proves the device, and the revoke warning about a shared
// passkey fits a phone, is keyboard reachable and readable in both themes.

import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { createExtractableDeviceKeyForTests } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { openSignedIn, waitUntil } from '../helpers/util.ts'

async function virtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

async function enrollAndPin(harness: Harness, page: Page) {
  const { link } = harness.armEnroll()
  await page.goto(link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitUntil(() => harness.devices.size === 1, 'device registered')
  const [deviceId] = [...harness.devices.keys()]
  if (!deviceId) throw new Error('no device')
  harness.pinDevice(deviceId, true)
  await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible()
  return deviceId
}

test.describe('sign-in proves the device', () => {
  test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'virtual authenticator is Chromium-only'))

  test('the real bundle signs the login challenge, and a proven device cannot sign in without it', async ({
    page,
    context,
    harness,
  }) => {
    await virtualAuthenticator(context, page)
    const deviceId = await enrollAndPin(harness, page)
    const nav = page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' }))

    // First sign-in after enrollment: the page sends a proof the (spec-faithful) relay checks and accepts.
    await context.clearCookies()
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in with passkey' }).click()
    await expect(nav).toBeVisible()
    expect(harness.loginProofs).toEqual([deviceId])
    expect(await page.evaluate(async () => (await (await fetch('/api/me')).json()).device_id)).toBe(deviceId)

    // An attacker holding only the passkey: the same request without the proof is refused, and the page says so.
    await context.clearCookies()
    await page.route('**/api/auth/login/verify', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      delete body.device_proof
      await route.continue({ postData: JSON.stringify(body) })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in with passkey' }).click()
    await expect(page.getByRole('alert')).toContainText("couldn't prove its key")
    await expect(page).toHaveURL(/\/login$/)
    expect(harness.loginProofs).toEqual([deviceId]) // no second proof was accepted
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test(`shared passkey: the revoke warning fits a phone, takes focus, closes by keyboard (${scheme})`, async ({
    page,
    context,
    harness,
  }, info) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    const other = await createExtractableDeviceKeyForTests()
    harness.devices.set(other.deviceId, {
      id: other.deviceId,
      name: 'Old laptop with a very long browser name to test wrapping on a phone',
      pubkey_jwk: other.publicJwk as never,
      binding: 'b',
      pinned: true,
    })
    harness.setSharedPasskey(true)
    await openSignedIn(harness, page, context, '/settings/account')
    const revoke = page.getByRole('button', { name: /^Revoke Old laptop/ })
    await revoke.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('does not remove that passkey')
    // focus moved into the dialog, nothing is clipped sideways, and no serious accessibility problem
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    await dialog.screenshot({ path: info.outputPath(`shared-passkey-${scheme}.png`) })
    // Escape cancels, nothing was revoked, and focus returns to the button that opened it
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(revoke).toBeFocused()
    expect(harness.devices.get(other.deviceId)?.pinned).toBe(true)
  })
}

test('a relay that does not report shared_passkey keeps the one-tap revoke (no dialog)', async ({
  page,
  context,
  harness,
}) => {
  const other = await createExtractableDeviceKeyForTests()
  harness.devices.set(other.deviceId, {
    id: other.deviceId,
    name: 'Old laptop',
    pubkey_jwk: other.publicJwk as never,
    binding: 'b',
    pinned: true,
  })
  await openSignedIn(harness, page, context, '/settings/account')
  await expect(page.getByRole('button', { name: 'Revoke Old laptop' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
