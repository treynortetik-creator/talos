// The Schedules tab on the REAL socket client, against the testkit FakeRelay with a FakeBridge answering from a
// FakeScheduler (docs/SCHEDULES.md S9 WP-S3 acceptance). Merge gate: re-run these with the WP-S1 captures as the bridge's
// responses (see the PR description: "blocked: captures").
import { FakeBridge, FakeScheduler } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { frameOfType, sigOk, waitUntil } from '../helpers/util.ts'

async function startMac(harness: Harness, opts: { scheduler?: boolean } = {}) {
  const scheduler = new FakeScheduler({ tz: 'America/New_York', now: Date.now() })
  await scheduler.seed({
    id: 'daily-digest',
    name: 'Daily Digest',
    description: 'Example job',
    when: { type: 'weekdays', time: '07:30' },
    catchup_min: 180,
    enabled: true,
    runner: 'session',
    permissions: 'full',
    allowed_tools: [],
    model: null,
    notify: 'failure',
    prompt: 'Summarise yesterday and post it.\n',
  })
  const bridge = new FakeBridge({
    relayWs: harness.relay.wsBase,
    key: harness.relay.bridgeKey,
    ...(opts.scheduler === false ? {} : { scheduler }),
  })
  await bridge.connect()
  return { scheduler, bridge }
}

async function openTab(
  harness: Harness,
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
  bridge: FakeBridge | null,
  path = '/schedules',
) {
  const dev = await harness.seedDevice(context, page)
  bridge?.pin(dev)
  await page.goto(path)
  await waitUntil(() => harness.relay.appCount > 0, 'app socket')
  return dev
}

test('list over the socket; pause is a signed schedule.control that verifies on the raw JSON; the status moves the row', async ({
  page,
  context,
  harness,
}) => {
  const { bridge } = await startMac(harness)
  const dev = await openTab(harness, page, context, bridge)
  const row = page.getByTestId('schedule-row-daily-digest')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Weekdays at 7:30 AM')
  const list = frameOfType(harness, 'schedules.list')[0]
  expect(list).toBeDefined()
  expect(await sigOk((list as { raw: Record<string, unknown> }).raw, dev.publicJwk)).toBe(true)

  const listsBefore = frameOfType(harness, 'schedules.list').length
  await page.getByRole('switch', { name: 'Daily Digest runs on schedule' }).click()
  await waitUntil(() => frameOfType(harness, 'schedule.control').length === 1, 'schedule.control')
  const ctl = frameOfType(harness, 'schedule.control')[0] as { raw: Record<string, unknown>; text: string }
  expect(ctl.raw).toMatchObject({ action: 'pause', schedule_id: 'daily-digest' })
  expect(await sigOk(ctl.raw, dev.publicJwk)).toBe(true)
  expect(await sigOk({ ...ctl.raw, schedule_id: 'other-job' }, dev.publicJwk)).toBe(false)
  await expect(row).toContainText('Paused')
  // the bridge's schedule.status moved state_rev: exactly one re-fetch, no storm
  await page.waitForTimeout(500)
  expect(frameOfType(harness, 'schedules.list').length).toBe(listsBefore + 1)
  await bridge.close()
})

test('a change on the Mac pushes one schedule.status, one re-fetch, and the row updates', async ({
  page,
  context,
  harness,
}) => {
  const { bridge, scheduler } = await startMac(harness)
  await openTab(harness, page, context, bridge)
  await expect(page.getByTestId('schedule-row-daily-digest')).toBeVisible()
  const before = frameOfType(harness, 'schedules.list').length
  await scheduler.setPaused({ id: 'daily-digest' }, true)
  await bridge.emitScheduleStatus()
  await expect(page.getByTestId('schedule-row-daily-digest')).toContainText('Paused')
  await page.waitForTimeout(500)
  expect(frameOfType(harness, 'schedules.list').length).toBe(before + 1)
  await bridge.close()
})

test('edit sends only the touched fields; the card arrives over the socket, is approved, and the list shows the change', async ({
  page,
  context,
  harness,
}) => {
  const { bridge } = await startMac(harness)
  const dev = await openTab(harness, page, context, bridge, '/schedules/daily-digest')
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Name').fill('Morning Digest')
  await page.getByRole('button', { name: 'Review change' }).click()
  await waitUntil(() => frameOfType(harness, 'schedule.patch').length === 1, 'schedule.patch')
  const patch = frameOfType(harness, 'schedule.patch')[0] as unknown as {
    raw: { change: { set: unknown; op: string }; id: string }
  }
  expect(patch.raw.change.op).toBe('update')
  expect(patch.raw.change.set).toEqual({ name: 'Morning Digest' })
  expect(await sigOk(patch.raw as never, dev.publicJwk)).toBe(true)
  const card = page.locator('[data-card-state="pending"]')
  await expect(card).toContainText('Change scheduled job: Morning Digest')
  await expect(card).toContainText('your form')
  await card.getByRole('button', { name: 'Save change' }).click()
  await waitUntil(() => frameOfType(harness, 'card.resolve').length === 1, 'card.resolve')
  // the bridge applies it and sends card.update + schedule.status; the card collapses to "Saved"
  await expect(page.locator('[data-card-state="done"]')).toContainText('Saved', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Done' }).click()
  // the page's h1 on a phone, the right-hand panel's title on desktop
  await expect(page.getByRole('heading', { name: 'Morning Digest' })).toBeVisible({ timeout: 10_000 })
  await bridge.close()
})

test('a bridge without a scheduler: "Update Talos on your Mac"', async ({ page, context, harness }) => {
  const { bridge } = await startMac(harness, { scheduler: false })
  await openTab(harness, page, context, bridge)
  await expect(page.getByTestId('empty-update_mac')).toContainText('Update Talos on your Mac to use Schedules.')
  expect(frameOfType(harness, 'schedules.list')).toHaveLength(0)
  await bridge.close()
})

test('the Mac away: the tab says so instead of an endless spinner', async ({ page, context, harness }) => {
  await openTab(harness, page, context, null)
  await expect(page.getByTestId('empty-mac_offline')).toContainText('Your Mac is offline.')
  await expect(page.getByTestId('offline-banner')).toBeVisible()
})
