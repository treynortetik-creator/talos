// A Mac app hosts the page: no passkeys, the setup code makes an unpinned session (POST /api/auth/enroll/session), and the
// page talks to the shell through window.webkit.messageHandlers.talos. The shell is faked in the page before it loads.
import { fingerprintWords } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import { waitUntil } from '../helpers/util.ts'

test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'one engine is enough for the fake shell'))

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 TalosDesktop/1.0'

test.describe('desktop shell', () => {
  test.use({ userAgent: DESKTOP_UA })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>
      w.__shellPosts = []
      w.webkit = { messageHandlers: { talos: { postMessage: (m: unknown) => (w.__shellPosts as unknown[]).push(m) } } }
      // WebAuthn must never be reached in a shell.
      const fail = () => {
        ;(w.__shellPosts as unknown[]).push({ webauthn: true })
        return Promise.reject(new Error('no passkeys here'))
      }
      if (navigator.credentials) {
        navigator.credentials.create = fail as never
        navigator.credentials.get = fail as never
      }
    })
  })

  test('/enroll#code signs in with the setup code, never WebAuthn, and tells the shell', async ({ page, harness }) => {
    const { link } = harness.armEnroll()
    await page.goto(link)
    await expect(page.getByRole('heading', { name: 'Set up Talos on this device' })).toBeVisible()
    await expect(page.getByText('Your Mac asks you to confirm this device.')).toBeVisible()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByTestId('fingerprint')).toBeVisible()
    await waitUntil(() => harness.devices.size === 1, 'device registered')
    const [deviceId] = [...harness.devices.keys()]
    if (!deviceId) throw new Error('no device')
    await expect(page.getByTestId('fingerprint')).toHaveText(fingerprintWords(deviceId).join(' '))
    expect(harness.authCalls).toContain('POST /api/auth/enroll/session')
    expect(harness.authCalls.some((c) => c.includes('/enroll/options') || c.includes('/enroll/verify'))).toBe(false)
    const posts = (await page.evaluate(() => (window as unknown as { __shellPosts: unknown[] }).__shellPosts)) as Array<
      Record<string, unknown>
    >
    expect(posts.some((m) => m.webauthn)).toBe(false)
    expect(posts.find((m) => m.type === 'ready')).toMatchObject({ shell_api: 1 })
    // the Mac says y
    harness.pinDevice(deviceId, true)
    await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible()
    expect(harness.failedAuthCalls).toBe(0)
  })

  test('the page exposes talosNative.receive to the shell, and not to an iframe', async ({ page, harness }) => {
    const { link } = harness.armEnroll()
    await page.goto(link)
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { talosNative?: { receive: unknown } }).talosNative?.receive,
      ),
    ).toBe('function')
    const seen = await page.evaluate(() => {
      const f = document.createElement('iframe')
      f.srcdoc = '<p>x</p>'
      document.body.append(f)
      return new Promise<string>((res) => {
        f.onload = () => res(String((f.contentWindow as unknown as { talosNative?: unknown }).talosNative))
      })
    })
    expect(seen).toBe('undefined')
    // A bad message is refused, a valid enroll_code leads to /enroll#code
    expect(
      await page.evaluate(() =>
        (window as unknown as { talosNative: { receive(m: unknown): boolean } }).talosNative.receive({ type: 'eval' }),
      ),
    ).toBe(false)
  })
})

test('a normal browser page that only defines the handler (no UA suffix) stays on the web adapter', async ({
  page,
  harness,
}) => {
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).webkit = { messageHandlers: { talos: { postMessage() {} } } }
  })
  const { link } = harness.armEnroll()
  await page.goto(link)
  await expect(
    page.getByText('You will create a passkey, then your Mac asks you to confirm this device.'),
  ).toBeVisible()
  expect(await page.evaluate(() => 'talosNative' in window)).toBe(false)
})

test.describe('Mac app shell /login', () => {
  test.use({ userAgent: DESKTOP_UA })
  test('offers the setup link, not a passkey button', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as Record<string, unknown>).webkit = { messageHandlers: { talos: { postMessage() {} } } }
    })
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Paste a setup link' })).toBeVisible()
  })
})
