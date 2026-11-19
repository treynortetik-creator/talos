import { mkFrame } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import { clickRetryIfShown, openSignedIn } from '../helpers/util.ts'

test('network-offline banner shows and clears', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  await context.setOffline(true)
  await expect(page.getByText("You're offline. Messages will send when you're back.")).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText("You're offline.")).toHaveCount(0)
})

test('the offline banner offers Retry, and Retry reconnects', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  await context.setOffline(true)
  await expect(page.getByText("You're offline. Messages will send when you're back.")).toBeVisible()
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText("You're offline.")).toHaveCount(0)
})

test('Mac-offline banner follows the presence frames', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  // FakeRelay has no bridge connected, so no host feature: the agent's computer is not known yet (lib/hostWords.ts)
  await expect(page.getByText(/Your computer is offline/)).toBeVisible()
  harness.relay.sendToApps(
    mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 }),
  )
  await expect(page.getByText(/Your computer is offline/)).toHaveCount(0)
  // a Mac bridge says so in its features: from then on the banner names the Mac
  harness.relay.sendToApps(
    mkFrame('presence', {
      bridge_online: false,
      last_seen: new Date().toISOString(),
      queue_depth: 2,
      features: ['host/mac'],
    }),
  )
  await expect(page.getByText(/Your Mac is offline \(last seen/)).toBeVisible()
})

test('a superseded bridge says so, two bridges on one key get a notice, and both fit the screen', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  harness.relay.sendToApps(
    mkFrame('presence', {
      bridge_online: false,
      last_seen: new Date().toISOString(),
      queue_depth: 1,
      superseded: true,
    }),
  )
  await expect(page.getByTestId('mac-banner')).toContainText(/Bridge superseded/)
  expect(await fits()).toBeLessThanOrEqual(0)
  harness.relay.sendToApps(
    mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0, superseded: true }),
  )
  await expect(page.getByTestId('mac-banner')).toHaveCount(0)
  await expect(page.getByTestId('bridge-notice')).toContainText(/Another bridge connected/)
  expect(await fits()).toBeLessThanOrEqual(0)
  harness.relay.sendToApps(
    mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 }),
  )
  await expect(page.getByTestId('bridge-notice')).toHaveCount(0)
})

test('relay unreachable shows the retry banner with Retry now', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  harness.blockWs(true)
  harness.dropAppSockets()
  await expect(page.getByText(/Can't reach your server/)).toBeVisible()
  // the countdown is part of the full text, one tap behind More
  await expect(page.getByText(/Retrying in \d+ s/)).toBeHidden()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByText(/Retrying in \d+ s/)).toBeVisible()
  harness.blockWs(false)
  await clickRetryIfShown(page)
  await expect(page.getByText(/Can't reach your server/)).toHaveCount(0)
})

test('the signature-failure notice is a system row', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(mkFrame('error', { code: 'sig_invalid', message: 'signature check failed' }))
  await expect(page.getByText('A message failed its security check and was dropped.')).toBeVisible()
})

test('an expired session sends the owner to sign in instead of retrying forever', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  harness.expireSessions()
  harness.dropAppSockets()
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 })
})
