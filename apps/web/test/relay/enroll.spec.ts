import type { BrowserContext, Page } from '@playwright/test'
import { fingerprintWords, newEnrollCode } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import { waitUntil } from '../helpers/util.ts'

// Passkeys need a virtual authenticator, which only Chromium offers.
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'virtual authenticator is Chromium-only'))

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

test('enroll (both halves) shows the same four words as the Mac, then signs in with the passkey', async ({
  page,
  context,
  harness,
}) => {
  await virtualAuthenticator(context, page)
  const { link } = harness.armEnroll()
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Set up Talos on this device' })).toBeVisible()
  await page.getByRole('button', { name: /^Continue/ }).click()

  // Half 2 done: the page shows the fingerprint words for the device the relay registered.
  await expect(page.getByTestId('fingerprint')).toBeVisible()
  await waitUntil(() => harness.devices.size === 1, 'device registered')
  const [deviceId] = [...harness.devices.keys()]
  if (!deviceId) throw new Error('no device')
  await expect(page.getByTestId('fingerprint')).toHaveText(fingerprintWords(deviceId).join(' '))
  // The relay handed the Mac a device.enrolled frame carrying the binding.
  expect(harness.relay.frames.some((f) => f.direction === 'to_bridge' && f.raw.type === 'device.enrolled')).toBe(true)
  await expect(page.getByText('Waiting for your Mac to confirm this device.')).toBeVisible()

  // The Mac says y.
  harness.pinDevice(deviceId, true)
  await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' })),
  ).toBeVisible({ timeout: 8000 })
  expect(harness.failedAuthCalls).toBe(0)

  // Sign out of the cookie jar and come back with the passkey (the device key stays in IndexedDB).
  await context.clearCookies()
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await expect(
    page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' })),
  ).toBeVisible()
  // Audit D2: the sign-in named this device's key, so the Mac's earlier y still counts. The app does not drop back to
  // "Waiting for your Mac" for a confirmation nobody will ask for.
  await expect(page.getByText('Waiting for your Mac to confirm this device.')).toHaveCount(0)
  expect(await page.evaluate(async () => (await (await fetch('/api/me')).json()).device_id)).toBe(deviceId)
})

test('the Mac refusing the device is reported', async ({ page, context, harness }) => {
  await virtualAuthenticator(context, page)
  const { link } = harness.armEnroll()
  await page.goto(link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitUntil(() => harness.devices.size === 1, 'device registered')
  const [deviceId] = [...harness.devices.keys()]
  await waitUntil(() => harness.relay.appCount > 0, 'app socket') // the answer arrives over the socket
  harness.pinDevice(deviceId as string, false, 'declined')
  await expect(page.getByRole('heading', { name: 'Your Mac said no to this device' })).toBeVisible()
})

test('the Mac never answers: after the wait the phone says what to check, and a late y still finishes setup (D56)', async ({
  page,
  context,
  harness,
}) => {
  await virtualAuthenticator(context, page)
  await page.clock.install()
  const { link } = harness.armEnroll()
  await page.goto(link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await expect(page.getByText('Waiting for your Mac to confirm this device.')).toBeVisible()
  await waitUntil(() => harness.devices.size === 1, 'device registered')
  const [deviceId] = [...harness.devices.keys()]
  await waitUntil(() => harness.relay.appCount > 0, 'app socket')
  await page.clock.fastForward(95_000)
  await expect(page.getByRole('heading', { name: 'Your Mac has not answered' })).toBeVisible()
  await expect(page.getByText('talos-app enroll --confirm')).toBeVisible()
  // phone width: nothing spills sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  )
  // the page is still listening: the Mac's late y finishes setup
  harness.pinDevice(deviceId as string, true)
  await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible()
})

test('an unknown or expired code says so and registers nothing', async ({ page, context, harness }) => {
  await virtualAuthenticator(context, page)
  const stale = newEnrollCode() // well-formed, but the Mac never registered it
  await page.goto(`${harness.url}/enroll#${stale}`)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await expect(page.getByText(/This link expired\. Run/)).toBeVisible()
  expect(harness.devices.size).toBe(0)
})

test('a passkey already on this keychain is used to sign in instead of registering twice', async ({
  page,
  context,
  harness,
}) => {
  await virtualAuthenticator(context, page)
  const first = harness.armEnroll()
  await page.goto(first.link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitUntil(() => harness.devices.size === 1, 'first device')
  await context.clearCookies()
  await context.clearPermissions()
  // A second device on the same keychain: no session, registration is blocked by excludeCredentials.
  const second = harness.armEnroll()
  await page.goto(`${harness.url}/manifest.webmanifest`)
  await page
    .evaluate(
      () =>
        new Promise<void>((r) => {
          const d = indexedDB.deleteDatabase('talos-app')
          d.onsuccess = d.onerror = d.onblocked = () => r()
        }),
    )
    .catch(() => {})
  await page.goto(second.link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitUntil(() => harness.devices.size === 2, 'second device registered via sign-in')
})
