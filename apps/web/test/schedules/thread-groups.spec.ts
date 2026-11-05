// The Schedules tab grouped by thread (docs/OPTION-C.md "Thread schedules"), on the real shell: iPhone (WebKit), Pixel and
// desktop, in both themes. Each group says who runs its jobs; the approval card for a thread session's proposal reads as
// "<Thread>'s session wants to schedule <job>".
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type CardT, composeScheduleCard, type ScheduleChangeT } from '@talos-app/protocol'
import { expectAxeClean } from '../cards/e2e.ts'
import { NOW_ISO } from './clock.ts'

test.use({ bypassCSP: true })

type States = Record<string, string>
async function open(
  page: Page,
  o: { sessions?: { workers: States; supported?: boolean } | null; route?: string } = {},
) {
  await page.clock.install({ time: new Date(NOW_ISO) })
  await page.goto(
    `/test/schedules/harness/index.html?${new URLSearchParams({ route: o.route ?? '/schedules', variant: 'byThread' })}`,
  )
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  const sessions = o.sessions === undefined ? { workers: { trip: 'live', garden: 'parked' } } : o.sessions
  if (sessions) await page.evaluate((s) => window.__sessions(s as never), sessions)
}
const MAIN = '__main__'
const group = (page: Page, key: string) => page.getByTestId(`thread-group-${key}`)
const runner = (page: Page, key: string) => group(page, key).getByTestId('group-runner')
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme })

    test('groups: Main, then each thread, each saying who runs it', async ({ page }) => {
      await open(page)
      await expect(page.locator('section[data-group] h2')).toHaveText(['Main', 'Trip', 'Garden', 'Rota'])
      await expect(runner(page, MAIN)).toHaveText('run by Main')
      await expect(runner(page, 'trip')).toHaveText('own session · live')
      await expect(runner(page, 'garden')).toHaveText('own session · parked')
      await expect(runner(page, 'shared_one')).toHaveText('run by Main')
      // a job in an archived thread falls to Main, and a row says who runs it
      await expect(group(page, MAIN).getByTestId('schedule-row-gone-thread-job')).toBeVisible()
      await expect(group(page, 'trip').getByTestId('schedule-row-packing-check')).toContainText('Weekdays at 8:00 AM')
      await expect(group(page, 'trip').getByTestId('schedule-row-packing-check').getByTestId('row-runner')).toHaveText(
        "Runs in Trip's own session",
      )
      // a job that is not a session job never reads as "own session", even in a thread with one
      const rr = (id: string) => group(page, 'trip').getByTestId(`schedule-row-${id}`).getByTestId('row-runner')
      await expect(rr('trip-backup')).toHaveText('Runs in the background, no session')
      await expect(rr('trip-both')).toHaveText('Run by Main, with a background backup')
      await expect(group(page, 'garden').getByTestId('schedule-row-water-plants').getByTestId('row-runner')).toHaveText(
        "Runs in Garden's own session",
      )
      await expect(
        group(page, 'shared_one').getByTestId('schedule-row-rota-nudge').getByTestId('row-runner'),
      ).toHaveText('Run by Main')
      await expect(group(page, MAIN).getByTestId('schedule-row-daily-summary').getByTestId('row-runner')).toHaveText(
        'Run by Main',
      )
    })

    test('no sideways scroll, and the group name and runner are one reading for a screen reader', async ({ page }) => {
      await open(page)
      await expect(group(page, 'trip')).toBeVisible()
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      expect(wide).toBe(false)
      await expect(group(page, 'trip')).toHaveAccessibleName('Trip')
      await expect(group(page, 'trip')).toHaveAccessibleDescription('own session · live')
    })

    test("keyboard: Tab lands on the first job (Main's first), and Enter opens it", async ({ page, browserName }) => {
      await open(page)
      await expect(group(page, MAIN)).toBeVisible()
      for (let i = 0; i < 40; i++) {
        // WebKit's Tab skips links unless Option is held (Safari's own setting)
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
        const inList = await page.evaluate(
          () => document.activeElement?.closest('[data-testid^="schedule-row-"]') !== null,
        )
        if (inList) break
      }
      const focused = page.locator(':focus')
      await expect(focused.locator('xpath=ancestor::li[starts-with(@data-testid,"schedule-row-")]')).toHaveAttribute(
        'data-testid',
        /^schedule-row-(daily-summary|gone-thread-job)$/,
      )
      await expect(focused).toBeInViewport()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('location')).toHaveText(/^\/schedules\/(daily-summary|gone-thread-job)$/)
    })

    test('a failed session, an older Mac and no sessions at all: every group reads "run by Main"', async ({ page }) => {
      await open(page, { sessions: { workers: { trip: 'failed', garden: 'stopping' } } })
      await expect(runner(page, 'trip')).toHaveText('run by Main')
      await expect(runner(page, 'garden')).toHaveText('run by Main')
      await open(page, { sessions: { workers: { trip: 'live', garden: 'live' }, supported: false } })
      await expect(runner(page, 'trip')).toHaveText('run by Main')
      await open(page, { sessions: null })
      await expect(page.locator('[data-testid="group-runner"]').first()).toHaveText('run by Main')
      for (const r of await page.getByTestId('group-runner').all()) await expect(r).toHaveText('run by Main')
    })

    test('a worker going live moves its label without a reload', async ({ page }) => {
      await open(page)
      await expect(runner(page, 'garden')).toHaveText('own session · parked')
      await page.evaluate(() => window.__sessions({ workers: { trip: 'live', garden: 'live' } }))
      await expect(runner(page, 'garden')).toHaveText('own session · live')
      await page.evaluate(() => window.__sessions({ workers: { trip: 'live' } })) // garden switched back to shared
      await expect(runner(page, 'garden')).toHaveText('run by Main')
    })

    test('axe is clean', async ({ page }) => {
      await open(page)
      await expect(group(page, 'garden')).toBeVisible()
      await expectAxeClean(page)
    })

    test("the thread session's approval card names the session, where it runs, when and what", async ({ page }) => {
      await open(page, { route: '/cards' })
      const change: ScheduleChangeT = {
        op: 'create',
        draft: {
          id: 'packing-check',
          name: 'Packing check',
          description: '',
          when: { type: 'weekdays', time: '07:40' },
          catchup_min: 180,
          enabled: true,
          runner: 'session',
          permissions: 'full',
          allowed_tools: [],
          model: null,
          notify: 'failure',
          thread_id: 'trip',
          prompt: 'Check the packing list and post what is missing.\n',
        },
      }
      const card = composeScheduleCard(
        change,
        { when_text: 'Weekdays at 7:40 AM', next_runs: ['2026-10-06T07:40:00-04:00'], tz: 'America/New_York' },
        null,
        {
          cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4CC',
          threadId: 'trip',
          now: '2026-10-05T11:45:00.000Z',
          origin: 'chat',
          proposedBy: 'agent',
          agentName: 'Talos',
          expectedEtag: `sha256:${'2'.repeat(64)}`,
          clientRef: null,
          threadName: (id) => (id === 'trip' ? 'Trip' : 'General'),
          base: null,
          sessionName: 'Trip',
        },
      )
      await page.evaluate((c) => {
        window.__talos.store.setState((s) => ({ ...s, cards: [...s.cards, c as never] }))
      }, card as CardT)
      const el = page.locator('[data-card-id="c_01JBF3V7Q8K2M4N6P8R0S2T4CC"]')
      await expect(el).toContainText("Trip's session wants to schedule Packing check")
      await expect(el).toContainText(
        "This thread's own session (wakes it if parked), or Main if that session can't take it",
      )
      await expect(el).toContainText(/SCHEDULE\s*·\s*TRIP/i)
      await expect(el).toContainText('Weekdays at 7:40 AM')
      await expect(el).toContainText('Check the packing list and post what is missing.')
      await expect(el.getByRole('button', { name: 'Approve' })).toBeVisible()
      await expect(el.getByRole('button', { name: 'Not now' })).toBeVisible()
      if (phone(page)) {
        const wide = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        )
        expect(wide).toBe(false)
      }
      if (process.env.SCHED_SHOTS) {
        mkdirSync(process.env.SCHED_SHOTS, { recursive: true })
        await el.scrollIntoViewIfNeeded()
        await el.screenshot({
          path: join(process.env.SCHED_SHOTS, `${test.info().project.name}-${scheme}-session-card.png`),
        })
      }
      await expectAxeClean(page)
    })
  })
}

test.describe('screenshots', () => {
  test.skip(!process.env.SCHED_SHOTS, 'set SCHED_SHOTS to a directory to write them')
  for (const scheme of ['light', 'dark'] as const) {
    test(`grouped list, ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(page)
      await expect(group(page, 'garden')).toBeVisible()
      const dir = process.env.SCHED_SHOTS as string
      mkdirSync(dir, { recursive: true })
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(dir, `${info.project.name}-${scheme}-by-thread.png`) })
    })
  }
})
