// Pending wake_me timers in the Session panel, in a real browser (fake mode; iphone, pixel, desktop): a dedicated thread lists
// its own session's, any other thread main's; each has its time, note and a Cancel that sends `cancel_wake` for that id. A
// refusal is said in words, a success hides the row and leaves focus on the list's heading, nothing scrolls sideways, light
// and dark pass axe, and with none pending the section is not there at all. (A row the app cannot read is dropped by the
// protocol parse: packages/protocol/test/wake-me.test.ts.)
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { openSessionPanel } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

type Talos = {
  store: {
    getState: () => { config: { threads: Array<Record<string, unknown>> } }
    setState: (f: (s: never) => never) => void
  }
  patchConfig: (p: Record<string, unknown>) => Promise<void>
  emit: (type: string, fields: Record<string, unknown>) => void
  sent: Array<Record<string, unknown>>
}

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
const WAKES = [
  { id: 'talos-wake-aaaaaaaaaaaa', at: inMin(45), note: 'Check the build and post the result in this thread.' },
  {
    id: 'talos-wake-bbbbbbbbbbbb',
    at: inMin(180),
    note: 'Ferry prices again: a long note that has to wrap on a phone rather than push the page sideways.',
  },
]

/** A dedicated thread "Work"; `item` is its workers.status row, `main` the main session's own wakes. */
async function setUp(page: Page, o: { item?: Record<string, unknown>; main?: unknown[]; mainTotal?: number }) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async (a) => {
    const c = (window as unknown as { __talos: Talos }).__talos
    const cur = c.store.getState().config.threads
    await c.patchConfig({
      threads: [
        ...cur,
        {
          id: 'work',
          name: 'Work',
          kind: 'fixed',
          order: 2,
          notify: 'all',
          voice_context: 'recent',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })
    c.store.setState(((s: { presence: { features?: string[] } }) => ({
      presence: { ...s.presence, features: [...(s.presence.features ?? []), 'thread-sessions/1'] },
    })) as never)
    c.emit('workers.status', {
      status: {
        supported: true,
        supervisor_online: true,
        threads: [{ thread_id: 'work', state: 'parked', ...(a.item ?? {}) }],
        governor: { state: 'ok' },
        at: new Date().toISOString(),
        ...(a.main ? { main_wakes: a.main, main_wakes_total: a.mainTotal ?? a.main.length } : {}),
      },
    })
  }, o)
}

const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)

async function openPanel(page: Page, thread: string) {
  await go(page, `/t/${thread}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  return openSessionPanel(page)
}

/** Waits for the cancel the app sent, and answers it as the Mac would. */
async function answerCancel(page: Page, ok: boolean, text: string) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __talos: Talos }).__talos.sent.filter((f) => f.type === 'thread.session.control')
            .length,
      ),
    )
    .toBe(1)
  const f = await page.evaluate(() =>
    (window as unknown as { __talos: Talos }).__talos.sent.find((x) => x.type === 'thread.session.control'),
  )
  expect(f).toMatchObject({ action: 'cancel_wake', wake_id: WAKES[0]?.id, thread_id: 'work' })
  await page.evaluate(
    (a) =>
      (window as unknown as { __talos: Talos }).__talos.emit('session.control.result', {
        control_id: a.id,
        ok: a.ok,
        text: a.text,
        at: new Date().toISOString(),
      }),
    { id: f?.control_id as string, ok, text },
  )
}

for (const theme of ['light', 'dark'] as const) {
  test(`a thread session's wakes: time, note, Cancel by keyboard; focus lands on the heading (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme })
    await setUp(page, { item: { wakes: WAKES, wakes_total: 3 } })
    const panel = await openPanel(page, 'work')
    const list = panel.getByTestId('pending-wakes')
    await expect(list).toContainText('Wake-ups for this session')
    await expect(list.getByTestId('pending-wake')).toHaveCount(2)
    await expect(list).toContainText('Check the build and post the result in this thread.')
    await expect(list).toContainText('And 1 more later.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    // the list itself (the rest of the panel, a parked session's dimmed last reading, is covered by its own specs)
    await expectAxeClean(page, ['[data-testid="pending-wakes"]'])
    const cancel = list.getByRole('button', { name: /^Cancel the wake-up at / }).first()
    await cancel.focus()
    await page.keyboard.press('Enter')
    await expect(cancel).toHaveText('Cancelling…')
    await answerCancel(page, true, 'Cancelled wake talos-wake-aaaaaaaaaaaa.')
    await expect(list.getByTestId('pending-wake')).toHaveCount(1)
    await expect(list).not.toContainText('Check the build')
    await expect(list.getByRole('heading', { name: 'Wake-ups for this session' })).toBeFocused()
  })
}

test('a refused cancel keeps the row and says why', async ({ page }) => {
  await setUp(page, { item: { wakes: WAKES } })
  const panel = await openPanel(page, 'work')
  await panel
    .getByRole('button', { name: /^Cancel the wake-up at / })
    .first()
    .click()
  await answerCancel(page, false, 'Wake talos-wake-aaaaaaaaaaaa has already fired.')
  await expect(panel.getByRole('alert')).toHaveText('Wake talos-wake-aaaaaaaaaaaa has already fired.')
  await expect(panel.getByTestId('pending-wake')).toHaveCount(2)
})

test("a thread main answers lists main's wakes; none pending shows nothing", async ({ page }) => {
  await setUp(page, { main: [WAKES[1]] })
  const panel = await openPanel(page, 'general')
  await expect(panel.getByTestId('pending-wakes')).toContainText('Wake-ups for the main session')
  await expect(panel.getByTestId('pending-wake')).toHaveCount(1)
  // the dedicated thread with none of its own: no section, not an empty list
  if (await page.getByTestId('session-sheet').isVisible()) await page.keyboard.press('Escape')
  const work = await openPanel(page, 'work')
  await expect(work.getByTestId('pending-wakes')).toHaveCount(0)
})
