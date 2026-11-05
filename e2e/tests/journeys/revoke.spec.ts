// Journey: the owner revokes a second device from Settings on the first. The Mac must learn it (`talos-app devices` says
// REVOKED), and the revoked device's open socket must die and stay dead. Second run: the Mac is down when it happens.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { enrollDevice, expect, openThread, signedIn, test, waitUntil } from '../../harness/fixtures.ts'
import type { Stack } from '../../harness/stack.ts'

test.setTimeout(150_000)

async function deviceLines(stack: Stack): Promise<string> {
  const cli = stack.cli(['devices'])
  await cli.done()
  return cli.out
}

/** Opens a WebSocket to the relay from the page, with its cookie, and says whether the relay let it open. */
async function socketOpens(page: Page): Promise<boolean> {
  return await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
        ws.onopen = () => {
          ws.close()
          resolve(true)
        }
        ws.onerror = () => resolve(false)
        ws.onclose = () => resolve(false)
      }),
  )
}

// Every second device's browser context, closed after each test whether it passed or not.
const opened: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()))
})

async function twoDevices(stack: Stack, page: Page, context: Parameters<typeof signedIn>[2], browser: Browser) {
  await signedIn(stack, page, context)
  const ctxB = await browser.newContext()
  opened.push(ctxB)
  const pageB = await ctxB.newPage()
  await enrollDevice(stack, pageB, ctxB, { label: 'tablet' })
  await openThread(pageB, 'General')
  // Both browsers register as "Desktop browser"; the tablet is the one that is not the phone's own id.
  const me = (await (await page.request.get(`${stack.origin}/api/me`)).json()) as { device_id: string }
  const list = (await (await page.request.get(`${stack.origin}/api/devices`)).json()) as Array<{ id: string }>
  const tablet = list.find((d) => d.id !== me.device_id)
  if (!tablet || list.length !== 2)
    throw new Error(`expected two devices, got ${JSON.stringify(list.map((d) => d.id))}`)
  await waitUntil(() => stack.appSocketCount() === 2, 'both devices to hold a socket')
  return { ctxB, pageB, tabletId: tablet.id }
}

async function revokeTabletInSettings(stack: Stack, page: Page): Promise<void> {
  await page.goto(`${stack.origin}/settings/account`)
  const row = page.getByTestId('device-row').filter({ hasNotText: 'This device' })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: /^Revoke/ }).click() // step-up: the virtual authenticator answers
  await expect(row.getByText('Revoked', { exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: /^Revoke/ })).toHaveCount(0)
}

test('revoke: the Mac lists the device as REVOKED and the revoked device loses its socket', async ({
  stack,
  page,
  context,
  browser,
}) => {
  const { pageB, tabletId } = await twoDevices(stack, page, context, browser)

  await test.step('revoke the tablet from Settings on the phone', async () => {
    await revokeTabletInSettings(stack, page)
  })

  await test.step('the Mac records it', async () => {
    await waitUntil(
      async () => new RegExp(`${tabletId}\\s+REVOKED`).test(await deviceLines(stack)),
      'REVOKED on the Mac',
    )
    expect(await deviceLines(stack)).toMatch(/d_\w+\s+pinned\s/) // the phone is still trusted
  })

  await test.step('the tablet socket is closed at the relay', async () => {
    await waitUntil(() => stack.appSocketCount() === 1, 'the revoked socket to close', 15_000)
  })

  await test.step('the app on the tablet signs itself out and shows no composer', async () => {
    await expect(pageB).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(pageB.getByLabel('Message', { exact: true })).toHaveCount(0)
  })

  await test.step('the relay refuses the tablet: no session, and a new socket never opens', async () => {
    expect((await pageB.request.get(`${stack.origin}/api/me`)).status()).toBe(401)
    expect((await pageB.request.get(`${stack.origin}/api/devices`)).status()).toBe(401)
    expect(await socketOpens(pageB)).toBe(false)
    // The control: the same probe from the phone, which is still trusted, does open.
    expect(await socketOpens(page)).toBe(true)
  })
})

test('revoke (Mac down): the Mac learns of the revoke when it comes back, and the tablet is cut off meanwhile', async ({
  stack,
  page,
  context,
  browser,
}) => {
  const { pageB, tabletId } = await twoDevices(stack, page, context, browser)

  await test.step('the Mac goes away, the tablet is revoked', async () => {
    await stack.crashBridge()
    await revokeTabletInSettings(stack, page)
  })

  await test.step('the tablet is cut off at the relay even though the Mac has not heard', async () => {
    await waitUntil(() => stack.appSocketCount() === 1, 'the revoked socket to close', 15_000)
    expect((await pageB.request.get(`${stack.origin}/api/me`)).status()).toBe(401)
    expect(stack.pendingForBridge()).toBeGreaterThanOrEqual(1) // the revoke notice waits for the Mac
  })

  await test.step('the Mac comes back and records REVOKED', async () => {
    await stack.startBridge()
    await waitUntil(
      async () => new RegExp(`${tabletId}\\s+REVOKED`).test(await deviceLines(stack)),
      'REVOKED on the Mac after it returned',
      60_000,
    )
    await waitUntil(() => stack.pendingForBridge() === 0, 'the revoke notice to be consumed')
  })
})
