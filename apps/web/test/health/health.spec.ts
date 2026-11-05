// WP-V1 web acceptance (docs/V2-FEATURES.md V2.5, V2.6): Settings -> Health in the fake-mode app, with GET /api/status
// answered by the test. Every row state, the bridge-offline case (a relay feature), the test button, the 30 s poll, axe.
import { expect, type Page, test } from '@playwright/test'
import type { HealthStatusT } from '@talos-app/protocol'
import { expectAxeClean } from '../cards/e2e.ts'
import { AT, statusOf } from './status.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

// the PWA's service worker would sit between page.route and the page on a reload
test.use({ serviceWorkers: 'block' })

type Hits = { status: number; tests: Array<Record<string, string>> }

async function open(page: Page, body: () => HealthStatusT, opts: { testStatus?: number; macOffline?: boolean } = {}) {
  const hits: Hits = { status: 0, tests: [] }
  await page.clock.install({ time: new Date(AT) })
  await page.route('**/api/status', (r) => {
    hits.status++
    return r.fulfill({ json: body() })
  })
  await page.route('**/api/health/test', (r) => {
    hits.tests.push(r.request().headers())
    return r.fulfill({ status: opts.testStatus ?? 204 })
  })
  await page.goto('/settings/health')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  if (opts.macOffline)
    await page.evaluate(() => {
      const c = (window as unknown as { __talos: { store: { setState: (f: (s: never) => never) => void } } }).__talos
      c.store.setState(
        (s: never) =>
          ({ ...(s as object), presence: { ...(s as { presence: object }).presence, bridge_online: false } }) as never,
      )
    })
  return hits
}
const row = (page: Page, id: string) => page.getByTestId(`health-row-${id}`)

test('a healthy install: every row is ok and says so in words', async ({ page }) => {
  await open(page, () => statusOf())
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible()
  await expect(row(page, 'relay')).toContainText('up since')
  await expect(row(page, 'relay')).toContainText('v0.4.1')
  await expect(row(page, 'relay')).toHaveAttribute('data-tone', 'ok')
  await expect(row(page, 'bridge')).toContainText('connected')
  await expect(row(page, 'bridge')).toHaveAttribute('data-tone', 'ok')
  await expect(row(page, 'mod')).toContainText('reporting')
  await expect(row(page, 'alerts')).toContainText('push on this device')
  await expect(row(page, 'alerts')).toHaveAttribute('data-tone', 'ok')
  await expect(page.getByTestId('health-note')).toHaveCount(0)
})

test('there is no external-check row (dropped)', async ({ page }) => {
  await open(page, () => statusOf())
  await expect(page.getByText(/external check/i)).toHaveCount(0)
})

test('bridge offline: amber with the time, red after 12 h; the screen still works (a relay feature)', async ({
  page,
}) => {
  let down = '2026-10-29T19:00:00.000Z'
  await open(
    page,
    () =>
      statusOf({
        bridge: { online: false, last_seen: down, down_since: down },
        mac_problems: ['bridge_offline'],
        mod: { state: 'unknown', last_seen: null, expected: true },
      }),
    { macOffline: true },
  )
  await expect(row(page, 'bridge')).toContainText('offline since')
  await expect(row(page, 'bridge')).toHaveAttribute('data-tone', 'warn')
  await expect(row(page, 'relay')).toHaveAttribute('data-tone', 'ok')
  await expect(page.getByText('Needs your Mac')).toHaveCount(0)
  down = '2026-10-29T07:00:00.000Z' // 13 h before the status time
  await page.clock.fastForward(31_000)
  await expect(row(page, 'bridge')).toHaveAttribute('data-tone', 'bad')
})

test('mod rows: reporting, quiet, not installed, unknown while the Mac is offline', async ({ page }) => {
  let s = statusOf()
  await open(page, () => s)
  await expect(row(page, 'mod')).toContainText('reporting')
  s = statusOf({
    mod: { state: 'quiet', last_seen: '2026-10-29T19:40:00.000Z', expected: true },
    mac_problems: ['mod_quiet'],
  })
  await page.clock.fastForward(31_000)
  await expect(row(page, 'mod')).toContainText('quiet')
  await expect(row(page, 'mod')).toHaveAttribute('data-tone', 'warn')
  s = statusOf({ mod: { state: 'absent', last_seen: null, expected: false } })
  await page.clock.fastForward(31_000)
  await expect(row(page, 'mod')).toContainText('Not installed')
  await expect(row(page, 'mod')).toHaveAttribute('data-tone', 'idle')
  s = statusOf({
    bridge: { online: false, last_seen: AT, down_since: AT },
    mod: { state: 'unknown', last_seen: null, expected: true },
  })
  await page.clock.fastForward(31_000)
  await expect(row(page, 'mod')).toContainText(/unknown|offline/i)
})

test('nobody can be alerted: red, with the words', async ({ page }) => {
  await open(page, () =>
    statusOf({
      relay_ok: false,
      relay_problems: ['no_alert_path'],
      push: { subscriptions: 0, last_ok_at: null, last_error_at: null },
    }),
  )
  await expect(row(page, 'alerts')).toContainText('Nobody can be alerted')
  await expect(row(page, 'alerts')).toHaveAttribute('data-tone', 'bad')
})

test('ntfy on with no push subscription is fine', async ({ page }) => {
  await open(page, () => statusOf({ ntfy: true, push: { subscriptions: 0, last_ok_at: null, last_error_at: null } }))
  await expect(row(page, 'alerts')).toContainText('ntfy on')
  await expect(row(page, 'alerts')).toHaveAttribute('data-tone', 'ok')
})

test('a failing push shows as a warning', async ({ page }) => {
  await open(page, () =>
    statusOf({
      push: { subscriptions: 1, last_ok_at: '2026-10-29T10:00:00.000Z', last_error_at: '2026-10-29T19:30:00.000Z' },
    }),
  )
  await expect(row(page, 'alerts')).toHaveAttribute('data-tone', 'warn')
  await expect(row(page, 'alerts')).toContainText(/last push failed/i)
})

test('storage nearly full is a red relay row', async ({ page }) => {
  await open(page, () => statusOf({ relay_ok: false, relay_problems: ['storage_full'] }))
  await expect(row(page, 'relay')).toHaveAttribute('data-tone', 'bad')
  await expect(row(page, 'relay')).toContainText('storage is nearly full')
})

test('notes: no TTS command, no FTS5', async ({ page }) => {
  await open(page, () =>
    statusOf({
      beat: { mod: { state: 'alive', last_seen: AT, expected: true }, tts: false, stt: true, sqlite: { fts5: false } },
    }),
  )
  await expect(
    page.getByTestId('health-note').filter({ hasText: 'Voice replies need a TTS command on your Mac' }),
  ).toBeVisible()
  await expect(
    page.getByTestId('health-note').filter({ hasText: "Search is off: this Mac's SQLite has no FTS5" }),
  ).toBeVisible()
})

test('scheduler row shows the cached schedule health when schedules are on', async ({ page }) => {
  await open(page, () => statusOf())
  await expect(row(page, 'scheduler')).toBeVisible()
  await expect(row(page, 'scheduler')).toContainText(/ok|not checked yet|paused|stuck/i)
})

test('Send test alert posts once with the CSRF header and says it went', async ({ page }) => {
  const hits = await open(page, () => statusOf())
  await page.getByRole('button', { name: 'Send test alert' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Test alert sent' })).toBeVisible()
  expect(hits.tests).toHaveLength(1)
  expect(hits.tests[0]?.['x-talos-csrf']).toBe('1')
})

test('Send test alert failing says so', async ({ page }) => {
  await open(page, () => statusOf(), { testStatus: 500 })
  await page.getByRole('button', { name: 'Send test alert' }).click()
  await expect(page.getByRole('alert').filter({ hasText: /couldn't send/i })).toBeVisible()
})

test('polls /api/status every 30 s while visible', async ({ page }) => {
  const hits = await open(page, () => statusOf())
  await expect(row(page, 'relay')).toBeVisible()
  const first = hits.status
  expect(first).toBeGreaterThanOrEqual(1)
  await page.clock.fastForward(31_000)
  await expect.poll(() => hits.status).toBeGreaterThan(first)
})

test('a status that cannot be fetched says so and offers Retry', async ({ page }) => {
  await page.clock.install({ time: new Date(AT) })
  await page.route('**/api/status', (r) => r.fulfill({ status: 500, body: 'x' }))
  await page.goto('/settings/health')
  await expect(page.getByRole('alert').filter({ hasText: /couldn't load/i })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
})

test('axe: Health is clean in light and dark, healthy and broken', async ({ page }) => {
  let s = statusOf()
  await open(page, () => s)
  await expect(row(page, 'relay')).toBeVisible()
  await expectAxeClean(page)
  s = statusOf({
    relay_ok: false,
    relay_problems: ['no_alert_path'],
    bridge: { online: false, last_seen: AT, down_since: '2026-10-29T07:00:00.000Z' },
    mod: { state: 'unknown', last_seen: null, expected: true },
    push: { subscriptions: 0, last_ok_at: null, last_error_at: null },
    beat: { mod: { state: 'quiet', last_seen: null, expected: true }, tts: false, stt: false, sqlite: { fts5: false } },
  })
  await page.reload()
  await expect(row(page, 'alerts')).toHaveAttribute('data-tone', 'bad')
  await expectAxeClean(page)
})
