// The Schedules tab (docs/SCHEDULES.md S5) on the fake client, in the real shell: iPhone (WebKit), Pixel and desktop.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { JwkP256T } from '@talos-app/protocol'
import { verifyOwnerFrame } from '@talos-app/protocol'
import { expectAxeClean } from '../cards/e2e.ts'
import { NOW_ISO } from './clock.ts'
import { expandGroups } from './groups.ts'
import type { VariantName } from './variants.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

async function open(page: Page, route = '/schedules', o: { variant?: VariantName | null; offline?: boolean } = {}) {
  await page.clock.install({ time: new Date(NOW_ISO) })
  const q = new URLSearchParams({ route })
  const variant = o.variant === undefined ? 'healthy' : o.variant
  if (variant) q.set('variant', variant)
  if (o.offline) q.set('offline', '1')
  await page.goto(`/test/schedules/harness/index.html?${q}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  // groups start shut on the organized page; these specs read the rows
  if (route === '/schedules' && variant && !o.offline) await expandGroups(page)
}
const sent = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__talos.sent)))
const jwk = (page: Page): Promise<JwkP256T> => page.evaluate(() => window.__talos.publicJwk())
const lists = (page: Page): Promise<number> => page.evaluate(() => window.__talos.schedules.sentCount.list)
/** The job's name as the detail shows it: the page's h1 on a phone, the right-hand panel's title on desktop. */
const detailTitle = (page: Page, name: string) =>
  phone(page) ? page.getByRole('heading', { level: 1, name }) : page.getByRole('complementary', { name })
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768

test.describe('navigation', () => {
  test('the tab (phone) or the sidebar item (desktop) reaches /schedules', async ({ page }) => {
    await open(page, '/')
    await page.getByRole('link', { name: 'Schedules' }).click()
    await expect(page.getByTestId('location')).toHaveText('/schedules')
    await expect(page.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Schedules' })).toHaveAttribute('aria-current', 'page')
  })

  test('the tab sits between Needs you and Settings on a phone; below Inbox on desktop', async ({ page }) => {
    await open(page, '/')
    const nav = page.getByRole('navigation', { name: phone(page) ? 'Main' : 'Primary' })
    const names = (await nav.getByRole('link').allInnerTexts()).map((t) => t.replace(/^\d+\s+/, '').trim())
    if (phone(page)) expect(names).toEqual(['Threads', 'Needs you', 'Schedules', 'Settings'])
    else expect(names.at(-1)).toBe('Schedules')
  })

  test('a stuck scheduler puts a dot on the tab', async ({ page }) => {
    await open(page, '/', { variant: 'stuck' })
    await expect(page.getByTestId('schedules-dot').first()).toBeAttached()
    await page.evaluate(() => window.__variant('empty'))
    await expect(page.getByTestId('schedules-dot')).toHaveCount(0)
  })
})

test.describe('list', () => {
  test('groups and status words follow the data', async ({ page }) => {
    await open(page)
    // jobs are grouped by the thread they run in (test/schedules/thread-groups.spec.ts): none here has a thread, so one Main group
    await expect(page.getByTestId('group-name')).toHaveText(['Main', 'One-off'])
    await expect(page.getByTestId('group-runner')).toHaveText('run by Main')
    const order = await page
      .locator('li[data-testid^="schedule-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    // today's jobs first, then the ones that are off; the one-off job sits in its own group, last
    expect(order.indexOf('schedule-row-daily-summary')).toBeLessThan(order.indexOf('schedule-row-pdf-digest'))
    expect(order.indexOf('schedule-row-pdf-digest')).toBeLessThan(order.indexOf('schedule-row-remind-me'))
    await expect(page.getByTestId('thread-group-oneoff').getByTestId('schedule-row-remind-me')).toBeVisible()
    const row = (id: string) => page.getByTestId(`schedule-row-${id}`)
    await expect(row('daily-summary')).toContainText('Ran')
    await expect(row('daily-summary')).toContainText('7:31 AM')
    await expect(row('daily-summary')).toContainText('Weekdays at 7:30 AM')
    await expect(row('weekly-review')).toContainText('Waiting for the agent')
    await expect(row('nightly-sync')).toContainText('Background run stuck')
    await expect(row('remind-me')).toContainText('Pending')
    await expect(row('remind-me')).toContainText('Once on Thu Nov 12 at 3:00 PM')
    await expect(row('pdf-digest')).toContainText('On events · read-only')
  })

  test('the pause switch sends a signed schedule.control that verifies on the raw JSON', async ({ page }) => {
    await open(page)
    const sw = page.getByRole('switch', { name: 'Daily summary runs on schedule' })
    await expect(sw).toBeChecked()
    await sw.click()
    await expect(page.getByTestId('schedule-row-daily-summary')).toContainText('Paused')
    const frame = (await sent(page)).filter((f) => f.type === 'schedule.control').at(-1) as Record<string, unknown>
    expect(frame).toMatchObject({ action: 'pause', schedule_id: 'daily-summary' })
    expect(await verifyOwnerFrame(frame, await jwk(page))).toBe(true)
    expect(await verifyOwnerFrame({ ...frame, schedule_id: 'weekly-review' }, await jwk(page))).toBe(false)
    await page.getByRole('switch', { name: 'Daily summary runs on schedule' }).click()
    await expect(page.getByTestId('schedule-row-daily-summary')).toContainText('Ran')
  })

  test('a schedule.status with a new state_rev triggers exactly one re-fetch and the row flips to Ran', async ({
    page,
  }) => {
    await open(page)
    await expect(page.getByTestId('schedule-row-weekly-review')).toContainText('Waiting for the agent')
    const before = await lists(page)
    await page.evaluate(() => window.__push('healthyRan'))
    await expect(page.getByTestId('schedule-row-weekly-review')).toContainText('Ran')
    await page.waitForTimeout(300)
    expect(await lists(page)).toBe(before + 1)
    // the same status again changes nothing: no further fetch
    await page.evaluate(() => window.__push('healthyRan'))
    await page.waitForTimeout(300)
    expect(await lists(page)).toBe(before + 1)
  })

  test('a row opens its detail', async ({ page }) => {
    await open(page)
    await page.getByTestId('schedule-row-weekly-review').getByRole('link').click()
    await expect(page.getByTestId('location')).toHaveText('/schedules/weekly-review')
    await expect(detailTitle(page, 'Weekly review')).toBeVisible()
    if (!phone(page)) await expect(page.getByTestId('schedule-row-weekly-review')).toBeVisible() // the list stays
  })
})

test.describe('review fixes', () => {
  test('the approval card says Next in plain words in the agent zone, and As follows the runner', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name').fill('Morning summary')
    await page.getByRole('button', { name: 'Review change' }).click()
    const card = page.locator('[data-card-state="pending"]')
    await expect(card).toContainText(/Tue Oct 6, 7:30 AM( EDT)?/)
    await expect(card).not.toContainText('2026-10-06T07:30')
    await expect(card).toContainText('As your live session (its permissions)')
    await expect(card).not.toContainText('Full permissions, nobody watching')
  })

  test('a headless full-permission job still says nobody is watching', async ({ page }) => {
    await open(page, '/schedules/nightly-sync')
    await expect(page.getByTestId('schedule-detail')).toContainText('Full permissions, nobody watching')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name').fill('Nightly sync 2')
    await page.getByRole('button', { name: 'Review change' }).click()
    await expect(page.locator('[data-card-state="pending"]')).toContainText('Full permissions, nobody watching')
  })

  test('a session job reads "As your live session" in the detail', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await expect(page.getByTestId('schedule-detail')).toContainText('As your live session (its permissions)')
  })

  test('the Off row has a switch in the off position and "On events" is printed once', async ({ page }) => {
    await open(page)
    const row = page.getByTestId('schedule-row-pdf-digest')
    const sw = row.getByRole('switch', { name: 'Turn on PDF digest' })
    await expect(sw).not.toBeChecked()
    const text = ((await row.textContent()) ?? '').replace(/\s+/g, ' ')
    expect(text.match(/On events/g)).toHaveLength(1)
    await sw.click()
    await expect(page.getByTestId('proposal-sheet')).toBeVisible()
    const patch = (await sent(page)).filter((f) => f.type === 'schedule.patch').at(-1) as {
      change: Record<string, unknown>
    }
    expect(patch.change).toMatchObject({ op: 'update', id: 'pdf-digest', set: { enabled: true } })
  })

  test('a disabled job turns on through its switch and a card', async ({ page }) => {
    await open(page, '/schedules', { variant: 'held' })
    await page.getByRole('switch', { name: 'Turn on Old report' }).click()
    await expect(page.getByTestId('proposal-sheet').locator('[data-card-state="pending"]')).toBeVisible()
  })

  test('on a phone a row is one line and the last row clears the tab bar', async ({ page }) => {
    test.skip(!phone(page), 'phone layout')
    await open(page)
    expect((await page.getByTestId('schedule-row-weekly-review').boundingBox())?.height).toBeLessThan(64)
    const region = page.getByRole('region', { name: 'Scheduled jobs' })
    await region.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    const last = await page.getByTestId('schedule-row-pdf-digest').boundingBox()
    const bar = await page.getByRole('navigation', { name: 'Main' }).boundingBox()
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) - 8)
  })

  test('on desktop the job opens in the right-hand detail panel, not a full page', async ({ page }) => {
    test.skip(phone(page) || (page.viewportSize()?.width ?? 0) < 1024, 'desktop layout')
    await open(page)
    await page.getByTestId('schedule-row-weekly-review').getByRole('link').click()
    const panel = page.getByRole('complementary', { name: 'Weekly review' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Run now' })).toBeVisible()
    await expect(page.getByTestId('schedule-row-daily-summary')).toBeVisible()
    await page.getByRole('link', { name: 'Schedules' }).click()
    await page.getByTestId('schedule-row-daily-summary').getByRole('link').click()
    await expect(page.getByRole('complementary', { name: 'Daily summary' })).toBeVisible()
  })
})

test.describe('detail', () => {
  test('when, how it runs, what it does, recent runs, and the action bar', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    const d = page.getByTestId('schedule-detail')
    await expect(d.getByText('Weekdays at 7:30 AM')).toBeVisible()
    await expect(d.getByText('Still runs if your agent is back within 3 h.')).toBeVisible()
    await expect(d.getByText('In your live session (a sub-agent does the work)')).toBeVisible()
    await expect(d.getByText('As your live session (its permissions)')).toBeVisible()
    await expect(d.getByTestId('prompt')).toContainText('Summarise yesterday')
    await expect(d.getByRole('list', { name: 'Recent runs' })).toContainText('Session')
    for (const b of ['Run now', 'Pause', 'Edit', 'Ask Talos'])
      await expect(d.getByRole('button', { name: b })).toBeVisible()
  })

  test('a recent run opens its report', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: /Ran/ }).first().click()
    await expect(page.getByTestId('report-sheet')).toContainText('Fake report')
    const get = (await sent(page)).filter((f) => f.type === 'schedule.get').at(-1)
    expect(get).toMatchObject({ report_run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA' })
  })

  test('Run now confirms: full permissions, "already ran today", then sends run_now with again:true', async ({
    page,
  }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Run now' }).click()
    const sheet = page.getByTestId('run-now-sheet')
    await expect(sheet).toContainText('Run Daily summary now? It runs with full permissions.')
    await expect(sheet).toContainText('It already ran today at 7:31 AM. Run again?')
    await sheet.getByRole('button', { name: 'Run again' }).click()
    const f = (await sent(page)).filter((x) => x.type === 'schedule.run_now').at(-1)
    expect(f).toMatchObject({ schedule_id: 'daily-summary', again: true, where: 'default' })
    expect(await verifyOwnerFrame(f as Record<string, unknown>, await jwk(page))).toBe(true)
  })

  test('Run now refused shows the bridge words', async ({ page }) => {
    await open(page, '/schedules/held-job', { variant: 'held' })
    await expect(page.getByRole('button', { name: 'Run now' })).toBeDisabled()
    await expect(page.getByTestId('hold-banner')).toContainText(
      "changed outside the app. It won't run until you review the change.",
    )
  })

  test('a hold offers Review change, which draws the Adopt card', async ({ page }) => {
    await open(page, '/schedules/held-job', { variant: 'held' })
    await page.getByRole('button', { name: 'Review change' }).click()
    const sheet = page.getByTestId('proposal-sheet')
    await expect(sheet.locator('[data-card-state="pending"]')).toBeVisible()
    await expect(sheet).toContainText('Review outside change')
    const f = (await sent(page)).filter((x) => x.type === 'schedule.patch').at(-1) as {
      change: Record<string, unknown>
    }
    expect(f.change).toMatchObject({ op: 'adopt', id: 'held-job' })
  })

  test('Ask the agent opens the default thread with the composer prefilled', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Ask Talos' }).click()
    await expect(page.getByTestId('location')).toHaveText('/t/general')
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('About the scheduled job "Daily summary": ')
  })

  test('a job the app cannot edit says why', async ({ page }) => {
    await open(page, '/schedules/pdf-digest')
    await expect(page.getByTestId('read-only-reason')).toContainText('Edit it at the Mac')
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  })
})

test.describe('create and edit', () => {
  test('+ New offers Tell the agent (prefills the composer) or a form', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'New' }).click()
    await page.getByRole('button', { name: 'Tell Talos' }).click()
    await expect(page.getByTestId('location')).toHaveText('/t/general')
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Set up a scheduled job: ')
  })

  test('Edit sends only the touched fields; Review change shows the card bound to the revision', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name').fill('Morning summary')
    await page.getByRole('button', { name: 'Review change' }).click()
    const patch = (await sent(page)).filter((f) => f.type === 'schedule.patch').at(-1) as {
      change: { op: string; id: string; base_etag: string; set: Record<string, unknown> }
    }
    expect(patch.change.set).toEqual({ name: 'Morning summary' })
    expect(patch.change.op).toBe('update')
    const etag = await page.evaluate(
      () => window.__talos.store.getState().schedules.snapshot?.schedules.find((s) => s.id === 'daily-summary')?.etag,
    )
    expect(patch.change.base_etag).toBe(etag)
    const card = page.locator('[data-card-state="pending"]')
    await expect(card).toContainText('Change scheduled job: Morning summary')
    await expect(card).toContainText('Proposed by')
    await expect(card).toContainText('your form')
    await expect(card.getByRole('button', { name: 'Save change' })).toBeVisible()
    // the hash the card carries binds exactly what is on screen
    const bound = await page.evaluate(() => {
      const c = window.__talos.store.getState().cards.at(-1)
      return { kind: c?.kind, hash: c?.payload_hash }
    })
    await expect(card).toHaveAttribute('data-payload-hash', bound.hash as string)
    expect(bound.kind).toBe('schedule')
  })

  test('nothing changed is not sent', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Review change' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Nothing changed.' })).toBeVisible()
    expect((await sent(page)).filter((f) => f.type === 'schedule.patch')).toHaveLength(0)
  })

  test('a high-risk approval asks for step-up and then resolves the card', async ({ page }) => {
    await open(page, '/schedules/weekly-cleanup')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    // widen it: read-only -> full is what makes a card high-risk
    await page.getByLabel('Full permissions').check()
    await page.getByRole('button', { name: 'Review change' }).click()
    const card = page.locator('[data-card-state="pending"]')
    await expect(card).toBeVisible()
    const risk = await page.evaluate(() => window.__talos.store.getState().cards.at(-1)?.risk)
    expect(risk).toBe('high')
    await card.getByRole('button', { name: /Save change/ }).click()
    await expect(
      page.locator('[data-card-state="sending"], [data-card-state="done"], [data-card-state="resolved"]').first(),
    ).toBeVisible()
    const resolve = (await sent(page)).filter((f) => f.type === 'card.resolve').at(-1)
    expect(resolve).toMatchObject({ action: 'primary' })
  })

  test('a relay-altered card shows "altered" and offers no buttons', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name').fill('Morning summary')
    await page.getByRole('button', { name: 'Review change' }).click()
    await expect(page.locator('[data-card-state="pending"]')).toBeVisible()
    await page.evaluate(() => {
      const c = window.__talos
      const s = c.store.getState()
      c.store.setState({
        ...s,
        cards: s.cards.map((x, i) => (i === s.cards.length - 1 ? { ...x, body: `${x.body}\nAlso: rm -rf` } : x)),
      })
    })
    await expect(page.getByText('This card was altered in transit')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save change' })).toHaveCount(0)
  })

  test('a conflict is a collapsed warning with Review again', async ({ page }) => {
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name').fill('Morning summary')
    await page.getByRole('button', { name: 'Review change' }).click()
    await expect(page.locator('[data-card-state="pending"]')).toBeVisible()
    await page.evaluate(() => {
      const c = window.__talos
      const s = c.store.getState()
      const at = new Date().toISOString()
      c.store.setState({
        ...s,
        cards: s.cards.map((x, i) =>
          i === s.cards.length - 1
            ? {
                ...x,
                state: 'failed' as const,
                result: {
                  ok: false,
                  text: 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.',
                  at,
                },
              }
            : x,
        ),
      })
    })
    await expect(page.getByTestId('card-conflict')).toContainText(
      'The job changed on your Mac before you approved. Nothing was saved.',
    )
    await page.getByRole('button', { name: 'Review again' }).click()
    await expect(page.getByLabel('Name')).toHaveValue('Morning summary')
  })

  test('the create form sends a strict draft and counts bytes against 16 KiB', async ({ page }) => {
    await open(page, '/schedules/new')
    await page.getByLabel('Name').fill('Friday wrap')
    await page.getByRole('radio', { name: 'Some days' }).check({ force: true })
    await page.getByRole('button', { name: 'Fri' }).click()
    await page.getByLabel('Time').fill('16:30')
    await page.getByLabel('What to do').fill('Wrap up the week.')
    await expect(page.getByTestId('byte-counter')).toHaveText('17 / 16,384 bytes')
    await page.getByRole('radio', { name: 'In the background (no session needed)' }).check()
    await expect(page.getByTestId('background-note')).toContainText(
      'macOS can block background runs after Claude Code updates.',
    )
    await page.getByRole('button', { name: 'Review change' }).click()
    const patch = (await sent(page)).filter((f) => f.type === 'schedule.patch').at(-1) as {
      change: { op: string; draft: Record<string, unknown> }
    }
    expect(patch.change.op).toBe('create')
    expect(patch.change.draft).toMatchObject({
      id: 'friday-wrap',
      name: 'Friday wrap',
      when: { type: 'days', days: ['fri'], time: '16:30' },
      runner: 'headless',
      permissions: 'full',
      enabled: true,
      prompt: 'Wrap up the week.',
    })
    await expect(page.locator('[data-card-state="pending"]')).toContainText('New scheduled job: Friday wrap')
  })

  test('a missing name or prompt is shown under its field', async ({ page }) => {
    await open(page, '/schedules/new')
    await page.getByRole('button', { name: 'Review change' }).click()
    await expect(page.getByText('Give the job a name.')).toBeVisible()
    await expect(page.getByText('Say what the job should do.')).toBeVisible()
    expect((await sent(page)).filter((f) => f.type === 'schedule.patch')).toHaveLength(0)
  })
})

test.describe('offline', () => {
  test('the cached list stays, every action is disabled, and a row past its next run is waiting', async ({ page }) => {
    await open(page, '/schedules', { variant: 'cachedPast' })
    await expect(page.getByTestId('schedule-row-standup-prep')).toBeVisible()
    await expect(page.getByTestId('schedule-row-standup-prep')).toContainText('Pending')
    // the cache is written on the next tick; wait until IndexedDB has it
    await page.waitForFunction(
      () =>
        new Promise<boolean>((resolve) => {
          const o = indexedDB.open('talos-app')
          o.onsuccess = () => {
            const r = o.result.transaction('schedules').objectStore('schedules').get('snapshot')
            r.onsuccess = () => resolve(Boolean(r.result))
            r.onerror = () => resolve(false)
          }
          o.onerror = () => resolve(false)
        }),
    )
    await page.evaluate(() => window.__talos.setMacOnline(false))
    await expect(page.getByTestId('offline-banner')).toContainText('Your Mac is offline. This list is from 7:45 AM.')
    await expect(page.getByTestId('offline-banner')).toContainText('Changes and Run now need your Mac.')
    await expect(page.getByTestId('schedule-row-standup-prep')).toContainText("Waiting: agent session isn't running")
    await expect(page.getByRole('button', { name: 'New' })).toBeDisabled()
    await expect(page.getByRole('switch', { name: 'Daily summary runs on schedule' })).toHaveCount(0)
    await page.getByTestId('schedule-row-daily-summary').getByRole('link').click()
    for (const b of ['Run now', 'Pause', 'Edit'])
      await expect(page.getByRole('button', { name: b, exact: true })).toBeDisabled()
  })

  test('a cold start with the Mac away shows the cached list', async ({ page }) => {
    await open(page, '/schedules', { variant: 'cachedPast' })
    await expect(page.getByTestId('schedule-row-standup-prep')).toBeVisible()
    await page.waitForFunction(
      () =>
        new Promise<boolean>((resolve) => {
          const o = indexedDB.open('talos-app')
          o.onsuccess = () => {
            const r = o.result.transaction('schedules').objectStore('schedules').get('snapshot')
            r.onsuccess = () => resolve(Boolean(r.result))
          }
          o.onerror = () => resolve(false)
        }),
    )
    await page.clock.install({ time: new Date(NOW_ISO) })
    await page.goto(`/test/schedules/harness/index.html?route=/schedules&offline=1`)
    await expandGroups(page)
    await expect(page.getByTestId('schedule-row-standup-prep')).toContainText("Waiting: agent session isn't running")
    await expect(page.getByTestId('offline-banner')).toBeVisible()
  })
})

test.describe('health banner and fix sheets', () => {
  test('session_runner_conflict opens its fix sheet with the numbered steps', async ({ page }) => {
    await open(page, '/schedules', { variant: 'stuck' })
    const b = page.getByTestId('health-banner')
    await expect(b).toHaveAttribute('role', 'status')
    await expect(b).toContainText("Chronos's own session timers are still on")
    await b.getByRole('button', { name: 'How to fix' }).click()
    await expect(page.getByTestId('fix-sheet')).toContainText('talos-app schedules adopt')
  })

  test('tcc_suspected shows its steps in order', async ({ page }) => {
    await open(page, '/schedules', { variant: 'tcc' })
    await page.getByTestId('health-banner').getByRole('button', { name: 'How to fix' }).click()
    await expect(page.getByTestId('fix-sheet').getByRole('listitem')).toHaveCount(3)
    await expect(page.getByTestId('fix-sheet')).toContainText('Full Disk Access')
  })

  test('headless_blocked: Retry confirms, then sends retry_headless with schedule_id null', async ({ page }) => {
    await open(page, '/schedules', { variant: 'headlessBlocked' })
    await page.getByTestId('health-banner').getByRole('button', { name: 'How to fix' }).click()
    await page.getByRole('button', { name: 'Retry background runs' }).click()
    await expect(page.getByTestId('fix-sheet')).toContainText('starts one tiny Claude run in the background to test it')
    expect((await sent(page)).filter((f) => f.type === 'schedule.control')).toHaveLength(0)
    await page.getByRole('button', { name: 'Start the test' }).click()
    await expect
      .poll(async () => (await sent(page)).filter((x) => x.type === 'schedule.control').at(-1))
      .toMatchObject({ action: 'retry_headless', schedule_id: null })
    await expect(page.getByTestId('fix-sheet').getByRole('status')).toContainText('testing background runs')
  })

  test('paused_all offers Resume', async ({ page }) => {
    await open(page, '/schedules', { variant: 'pausedAll' })
    await expect(page.getByTestId('health-banner')).toContainText('Scheduler paused. Nothing runs on its own.')
    await page.getByTestId('health-banner').getByRole('button', { name: 'Resume' }).click()
    const f = (await sent(page)).filter((x) => x.type === 'schedule.control').at(-1)
    expect(f).toMatchObject({ action: 'resume_all', schedule_id: null })
    await expect(page.getByTestId('health-banner')).toHaveCount(0)
  })

  test('waiting with no session says so and counts the jobs', async ({ page }) => {
    await open(page, '/schedules', { variant: 'nosession' })
    await expect(page.getByTestId('health-banner')).toContainText("Your agent session isn't running. 1 job is waiting.")
    await expect(page.getByTestId('schedule-row-weekly-review')).toContainText("Waiting: agent session isn't running")
  })

  test('held jobs: Review opens the first held job', async ({ page }) => {
    await open(page, '/schedules', { variant: 'held' })
    await page.getByTestId('health-banner').getByRole('button', { name: 'Review' }).click()
    await expect(page.getByTestId('location')).toHaveText('/schedules/held-job')
  })

  test('a scheduler in another zone labels its times', async ({ page }) => {
    await open(page, '/schedules', { variant: 'otherZone' })
    // 07:31 -04:00 is 12:31 where the scheduler is
    await expect(page.getByTestId('schedule-row-daily-summary')).toContainText(/12:31 PM GMT\+1|12:31 PM BST/)
  })
})

test.describe('empty and error states', () => {
  const cases: Array<[VariantName, string, string]> = [
    [
      'notInstalled',
      'empty-not_installed',
      'No scheduler on your Mac yet. Talos uses Chronos to run jobs on a schedule.',
    ],
    ['oldChronos', 'empty-old_chronos', 'Chronos 0.2.1 is installed. Schedules need 0.3 or newer.'],
    ['off', 'empty-off', 'Schedules are turned off on your Mac (TALOS_APP_SCHEDULER=off).'],
    ['empty', 'empty-no_jobs', 'No scheduled jobs yet. Tell Talos what to do and when.'],
    ['unreadable', 'empty-unreadable', "Your scheduler's job file can't be read: not valid JSON"],
  ]
  for (const [variant, id, text] of cases)
    test(`${variant}`, async ({ page }) => {
      await open(page, '/schedules', { variant })
      await expect(page.getByTestId(id)).toContainText(text)
    })

  test('no scheduler shows the install line with Copy, then the adopt step', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await open(page, '/schedules', { variant: 'notInstalled' })
    await expect(page.getByTestId('install-cmd')).toContainText('git clone https://github.com/')
    await expect(page.getByTestId('install-cmd')).toContainText('~/chronos/install.sh')
    await expect(page.getByTestId('empty-not_installed')).toContainText(
      'Then run talos-app schedules adopt and restart your session.',
    )
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
  })

  test('an empty list offers Tell the agent', async ({ page }) => {
    await open(page, '/schedules', { variant: 'empty' })
    await page.getByTestId('empty-no_jobs').getByRole('button', { name: 'Tell Talos' }).click()
    await expect(page.getByTestId('location')).toHaveText('/t/general')
  })

  test('an unknown protocol says "Update the app"; an unadvertised feature says "Update Talos on your Mac"', async ({
    page,
  }) => {
    await open(page, '/schedules', { variant: null })
    await page.evaluate(() => {
      const c = window.__talos
      const s = c.store.getState()
      c.store.setState({ ...s, schedules: { ...s.schedules, snapshot: null, status: 'error', error: 'update_app' } })
    })
    await expect(page.getByTestId('empty-update_app')).toContainText('Update the app')
    await page.evaluate(() => {
      const c = window.__talos
      const s = c.store.getState()
      c.store.setState({ ...s, schedules: { ...s.schedules, snapshot: null, status: 'error', error: 'update_mac' } })
    })
    await expect(page.getByTestId('empty-update_mac')).toContainText('Update Talos on your Mac to use Schedules.')
  })

  test('no answer in 20 s offers Try again', async ({ page }) => {
    await open(page, '/schedules', { variant: null })
    await page.evaluate(() => {
      const c = window.__talos
      const s = c.store.getState()
      c.store.setState({ ...s, schedules: { ...s.schedules, snapshot: null, status: 'error', error: 'no_answer' } })
    })
    await expect(page.getByTestId('empty-no_answer')).toContainText("Your Mac didn't answer. Try again.")
    await page.getByRole('button', { name: 'Try again' }).click()
    await expandGroups(page)
    await expect(page.getByTestId('schedule-row-daily-digest')).toBeVisible()
  })
})

test.describe('accessibility', () => {
  test('axe: the list and the detail are clean in light and dark', async ({ page }) => {
    await open(page)
    await expect(page.getByTestId('schedule-row-daily-summary')).toBeVisible()
    await expectAxeClean(page)
    await open(page, '/schedules/daily-summary')
    await expect(detailTitle(page, 'Daily summary')).toBeVisible()
    await expectAxeClean(page)
  })
  test('axe: the banner, the empty state and the form', async ({ page }) => {
    await open(page, '/schedules', { variant: 'stuck' })
    await expect(page.getByTestId('health-banner')).toBeVisible()
    await expectAxeClean(page)
    await open(page, '/schedules', { variant: 'notInstalled' })
    await expect(page.getByTestId('empty-not_installed')).toBeVisible()
    await expectAxeClean(page)
    await open(page, '/schedules/new')
    await expect(page.getByTestId('schedule-form')).toBeVisible()
    await expectAxeClean(page)
  })
})

// The real bridge's frames (WP-S1 captures) driving the same UI: statuses, banners, fix text and cards as it words them.
test.describe('with the real-bridge captures', () => {
  const load = async (page: Page, scenario: string, index: number, route = '/schedules') => {
    await open(page, route, { variant: null })
    await page.evaluate(([s, i]) => window.__captured(s as string, i as number), [scenario, index])
    if (route === '/schedules') await expandGroups(page)
  }
  test('02: the three jobs the real bridge listed', async ({ page }) => {
    await load(page, '02-list-three-jobs', 0)
    await expect(page.locator('li[data-testid^="schedule-row-"]')).toHaveCount(3)
    await expect(page.getByTestId('schedule-row-daily-digest')).toContainText('Every day at 7:30 AM')
    await expect(page.getByTestId('schedule-row-daily-digest')).toContainText('Pending')
  })
  test('13: offered, agent_busy, no_session, running, failed and missed read right', async ({ page }) => {
    const row = page.getByTestId('schedule-row-daily-digest')
    await load(page, '13-states-and-health', 0)
    await expect(row).toContainText('Waiting for the agent')
    await page.evaluate(() => window.__captured('13-states-and-health', 2))
    await expect(row).toContainText("Waiting: agent session isn't running")
    await expect(page.getByTestId('schedule-row-missed-job')).toContainText('Missed')
    await page.evaluate(() => window.__captured('13-states-and-health', 3))
    await expect(row).toContainText('Running')
    await page.evaluate(() => window.__captured('13-states-and-health', 4))
    await expect(row).toContainText('Failed')
  })
  test('15: tcc_suspected shows its lead-in, four numbered steps and Retry background runs', async ({ page }) => {
    await load(page, '15-background-stalled', 0)
    await expect(page.getByTestId('schedule-row-bg-job')).toContainText('Background run stuck')
    await page.getByTestId('health-banner').getByRole('button', { name: 'How to fix' }).click()
    const sheet = page.getByTestId('fix-sheet')
    await expect(sheet).toContainText('macOS is probably waiting for permission.')
    await expect(sheet.getByRole('listitem')).toHaveCount(4)
    await expect(sheet.getByRole('listitem').first()).toContainText(
      'look for a dialog saying Claude Code would like to access a folder',
    )
  })
  test('10: a hold, Review opens the job, Review change draws the real Adopt card', async ({ page }) => {
    await load(page, '10-hold-and-adopt', 0)
    await expect(page.getByTestId('health-banner')).toContainText('on hold: daily-digest')
    await page.getByTestId('health-banner').getByRole('button', { name: 'Review' }).click()
    await expect(page.getByTestId('hold-banner')).toBeVisible()
  })
  test('the real update, high-risk update and conflict cards render and behave', async ({ page }) => {
    await load(page, '02-list-three-jobs', 0, '/cards')
    await page.evaluate(() => {
      window.__captureCard('05-patch-update', 0)
      window.__captureCard('05-patch-update', 1)
    })
    const mine = page.locator('[data-card-state="pending"]', { hasText: 'Change scheduled job' })
    const low = mine.first()
    await expect(mine).toHaveCount(2)
    await expect(low).toContainText('Proposed by')
    await expect(low).toContainText('Save change')
    await expect(page.getByText('altered in transit')).toHaveCount(0)
    await expect(mine.nth(1).getByText('asks you to confirm with Face ID')).toBeAttached()
    // the conflict the real bridge reports
    await page.evaluate(() => {
      const c = window.__talos
      const id = window.__captureCard('16-apply-conflict', 0)
      c.store.setState((s) => ({
        ...s,
        cards: s.cards.map((x) =>
          x.id === id
            ? {
                ...x,
                state: 'failed' as const,
                result: {
                  ok: false,
                  text: 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.',
                  at: new Date().toISOString(),
                },
              }
            : x,
        ),
      }))
    })
    await expect(
      page
        .getByTestId('collapse-line')
        .filter({ hasText: 'The job changed on your Mac before you approved. Nothing was saved.' }),
    ).toBeVisible()
  })
  test('axe: a captured banner list and the fix sheet', async ({ page }) => {
    await load(page, '15-background-stalled', 0)
    await expect(page.getByTestId('health-banner')).toBeVisible()
    await expectAxeClean(page)
  })
})

// Screenshots for the PR: SCHED_SHOTS=<dir> pnpm exec playwright test schedules-shots
test.describe('screenshots', () => {
  test.skip(!process.env.SCHED_SHOTS, 'set SCHED_SHOTS to a directory to write them')
  test('tab, detail, banner, empty state, approval card', async ({ page }, info) => {
    const dir = process.env.SCHED_SHOTS as string
    mkdirSync(dir, { recursive: true })
    const shot = async (name: string) => {
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(dir, `${info.project.name}-${name}.png`) })
    }
    await open(page)
    await expect(page.getByTestId('schedule-row-daily-summary')).toBeVisible()
    await shot('tab')
    await open(page, '/schedules/weekly-review')
    await expect(detailTitle(page, 'Weekly review')).toBeVisible()
    await shot('detail')
    await open(page, '/schedules', { variant: 'stuck' })
    await expect(page.getByTestId('health-banner')).toBeVisible()
    await shot('banner')
    await open(page, '/schedules', { variant: 'notInstalled' })
    await expect(page.getByTestId('empty-not_installed')).toBeVisible()
    await shot('empty')
    await open(page, '/schedules/daily-summary')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name').fill('Morning summary')
    await page.getByRole('button', { name: 'Review change' }).click()
    await expect(page.locator('[data-card-state="pending"]')).toBeVisible()
    await shot('approval-card')
  })
})
