// Settings, Account, Devices in a real browser against the production bundle: which row is this device, the whole name is
// always shown, "last used" never claims "never", and the list works at a very narrow phone width, by keyboard, in both
// themes, while loading, empty and failed. The list itself is fed through `page.route`; what the relay writes into it is
// covered by apps/relay/test/auth/device-last-used.test.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { fingerprintWords } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { waitUntil } from '../helpers/util.ts'

const LONG = 'Alex Example iPhone 15 Pro Max (personal, installed to the Home Screen, second profile)'
const SAME = 'Phone'

const device = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  pubkey_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  pinned: true,
  revoked: false,
  created_at: '2026-10-01T00:00:00.000Z',
  last_used_at: null,
  login_proven_at: '2026-10-02T00:00:00.000Z',
  ...extra,
})
const fakeId = (n: number) => `d_${String.fromCharCode(96 + n).repeat(20)}` // base32: a-z and 2-7 only

/** Signs in a seeded device and serves `list(thisId)` for GET /api/devices. Returns this session's device id. */
async function open(
  harness: Harness,
  page: Page,
  context: Parameters<Harness['seedDevice']>[0],
  serve: (thisId: string) => (() => Promise<{ status: number; body?: unknown }>) | { status: number; body?: unknown },
) {
  const { deviceId } = await harness.seedDevice(context, page)
  const answer = serve(deviceId)
  await page.route('**/api/devices', async (route) => {
    const r = typeof answer === 'function' ? await answer() : answer
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) })
  })
  await page.goto('/settings/account')
  await waitUntil(() => harness.relay.appCount > 0, 'app socket')
  return deviceId
}

const rows = (page: Page) => page.getByTestId('device-row')
const rowOf = (page: Page, id: string) => rows(page).filter({ hasText: fingerprintWords(id).join(' ') })

async function listWith(page: Page, harness: Harness, context: Parameters<Harness['seedDevice']>[0]) {
  // The page's clock is frozen at "now", so "3 min ago" is exactly 3 minutes however long the test takes to open the page
  // (computing it from the wall clock before the page loads made it read "4 min ago" about 30 s later).
  const frozen = Date.now()
  await page.clock.setFixedTime(frozen)
  const minutesAgo = new Date(frozen - 3 * 60_000).toISOString()
  const mine = await open(harness, page, context, (me) => ({
    status: 200,
    body: [
      device(fakeId(1), SAME, { last_used_at: minutesAgo }), // same name as this device, a different device
      device(me, SAME, { last_used_at: minutesAgo }), // this device
      device(fakeId(2), 'Old laptop'), // never stamped: unknown
      device(fakeId(3), LONG, { pinned: false, login_proven_at: null }), // long name plus a badge
      device(fakeId(4), 'Retired tablet', { revoked: true }),
    ],
  }))
  await expect(rows(page)).toHaveCount(5)
  return mine
}

test('the row of this session is marked, and a second device with the same name is not', async ({
  page,
  context,
  harness,
}) => {
  const mine = await listWith(page, harness, context)
  await expect(page.getByText('This device', { exact: true })).toHaveCount(1)
  await expect(rowOf(page, mine).getByText('This device', { exact: true })).toBeVisible()
  await expect(rowOf(page, fakeId(1)).getByText('This device', { exact: true })).toHaveCount(0)
})

test('last used reads as unknown, never "never used", and a real time reads as a time', async ({
  page,
  context,
  harness,
}) => {
  await listWith(page, harness, context)
  await expect(page.getByText(/never used/i)).toHaveCount(0)
  await expect(rowOf(page, fakeId(2))).toContainText('last used unknown')
  await expect(rowOf(page, fakeId(1))).toContainText('used 3 min ago')
})

test('at 320 px wide every name is shown whole and the marker is fully inside the screen', async ({
  page,
  context,
  harness,
}) => {
  await page.setViewportSize({ width: 320, height: 700 })
  const mine = await listWith(page, harness, context)
  // No horizontal scrolling anywhere on the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const long = rowOf(page, fakeId(3))
  await expect(long).toContainText(LONG)
  const nameBox = await long.locator('div.font-medium').evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      clipped: el.scrollWidth > el.clientWidth,
      ellipsis: cs.textOverflow === 'ellipsis',
      wraps: el.getClientRects()[0]?.height ?? 0,
    }
  })
  expect(nameBox.clipped, 'name wider than its box').toBe(false)
  expect(nameBox.ellipsis, 'name uses an ellipsis').toBe(false)
  for (const id of [mine, fakeId(3)]) {
    for (const badge of await rowOf(page, id).locator('span.rounded-pill').all()) {
      const b = await badge.boundingBox()
      expect(b, 'badge has a box').not.toBeNull()
      expect((b?.x ?? -1) >= 0 && (b?.x ?? 0) + (b?.width ?? 0) <= 320, 'badge inside the screen').toBe(true)
      expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth), 'badge text not clipped').toBe(true)
    }
  }
  // The name wrapped onto more than one line instead of being cut.
  const lines = await long.locator('div.font-medium').evaluate((el) => {
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight)
    return Math.round(el.getBoundingClientRect().height / lh)
  })
  expect(lines).toBeGreaterThan(1)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the list has no serious accessibility violations (${scheme})`, async ({ page, context, harness }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await listWith(page, harness, context)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
}

test('by keyboard: Tab reaches each Revoke in order, Enter on this device asks first, Escape returns focus', async ({
  page,
  context,
  harness,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons by default (system setting)')
  const mine = await listWith(page, harness, context)
  const revokeMine = rowOf(page, mine).getByRole('button', { name: `Revoke ${SAME}` })
  await page.getByRole('heading', { name: 'Devices' }).click()
  const seen: string[] = []
  for (let i = 0; i < 40 && seen.length < 4; i++) {
    await page.keyboard.press('Tab')
    const name = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
    if (name.startsWith('Revoke ')) seen.push(name)
  }
  // 4 live devices have the button; the revoked one does not.
  expect(seen).toEqual([`Revoke ${SAME}`, `Revoke ${SAME}`, 'Revoke Old laptop', `Revoke ${LONG}`])
  await revokeMine.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('You are on this device right now')
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(revokeMine).toBeFocused()
})

test.describe('states', () => {
  test('loading: says so, shows no rows and no use time yet', async ({ page, context, harness }) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    await open(harness, page, context, (me) => async () => {
      await gate
      return { status: 200, body: [device(me, SAME)] }
    })
    await expect(page.getByText('Loading…')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    await expect(page.getByText(/used/)).toHaveCount(0)
    release()
    await expect(rows(page)).toHaveCount(1)
    await expect(page.getByText('Loading…')).toHaveCount(0)
  })

  test('empty: "No devices yet." and nothing else in the list', async ({ page, context, harness }) => {
    await open(harness, page, context, () => ({ status: 200, body: [] }))
    await expect(page.getByText('No devices yet.')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
  })

  test('failed: an alert says the list could not load, and it is not shown as empty', async ({
    page,
    context,
    harness,
  }) => {
    await open(harness, page, context, () => ({ status: 500, body: { error: 'boom' } }))
    await expect(page.getByRole('alert')).toHaveText("Couldn't load your devices.")
    await expect(page.getByText('No devices yet.')).toHaveCount(0)
    await expect(page.getByText('Loading…')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(0)
  })
})
