// The iPhone shell (apps/mobile, WP-W1): a Capacitor web view reports an iPhone user agent and no display-mode
// standalone, so without the shell adapter the enroll page says "add to Home Screen first" and can never pair. With a
// fake `window.Capacitor` the page must reach the setup step, sign in with the setup code (no passkey), and show the
// same four words as the Mac.
import { fingerprintWords } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import { waitUntil } from '../helpers/util.ts'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
test.use({ userAgent: IPHONE_UA })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<[string, string, unknown]> = []
    const plugin = (name: string) =>
      new Proxy({}, { get: (_t, method: string) => async (o: unknown) => void calls.push([name, method, o]) })
    ;(window as unknown as Record<string, unknown>).__nativeCalls = calls
    ;(window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: { Haptics: plugin('Haptics'), TalosAudio: plugin('TalosAudio') },
    }
  })
})

test('shell: /enroll#code reaches the setup step (not ios-install), signs in with the code, no passkey call', async ({
  page,
  harness,
}) => {
  const { link } = harness.armEnroll()
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Set up Talos on this device' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Home Screen/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByTestId('fingerprint')).toBeVisible()
  await waitUntil(() => harness.devices.size === 1, 'device registered')
  const [deviceId] = [...harness.devices.keys()]
  if (!deviceId) throw new Error('no device')
  await expect(page.getByTestId('fingerprint')).toHaveText(fingerprintWords(deviceId).join(' '))
  expect(harness.authCalls.some((c) => c.includes('/api/auth/enroll/session'))).toBe(true)
  expect(harness.authCalls.some((c) => c.includes('/api/auth/enroll/options'))).toBe(false)
  harness.pinDevice(deviceId, true)
  await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible()
})
