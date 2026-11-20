// Thread sessions are allowed by default (the owner, 2026-11-19: "they can't even go look at it"). On a config that never wrote
// the master switch (the fake Mac's, like every new install's): Settings shows it on, each ordinary thread's settings show its
// own switch, off, with the cost note; General shows none. Turning one thread on writes the switch on, and a thread left
// dedicated from before (shown off) goes back to shared, so only the thread turned on starts. Real browser, every project.
import { expect, type Page, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

type Cfg = { threads: Array<Record<string, unknown>>; dedicated?: { enabled?: boolean } }
type Talos = {
  store: { getState: () => { config: Cfg }; setState: (f: (s: never) => never) => void }
  emit: (type: string, fields: Record<string, unknown>) => void
}

const mk = (id: string, name: string, order: number, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

/** The fake Mac's config with Trip (off) and Garden (left dedicated, never ran), no switch written; a Mac that runs sessions. */
async function setUp(page: Page, path: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(
    ([trip, garden]) => {
      const c = (window as unknown as { __talos: Talos }).__talos
      c.store.setState(((s: { config: Cfg; presence: { features?: string[] } }) => {
        const config = { ...s.config, threads: [...s.config.threads, trip, garden] }
        return {
          config,
          threads: config.threads,
          presence: { ...s.presence, features: [...(s.presence.features ?? []), 'thread-sessions/1'] },
        }
      }) as never)
      c.emit('workers.status', {
        status: {
          supported: true,
          supervisor_online: true,
          threads: [],
          governor: { state: 'ok' },
          at: new Date().toISOString(),
        },
      })
    },
    [mk('trip', 'Trip', 2), mk('garden', 'Garden', 3, { session: 'dedicated' })],
  )
  expect(
    await page.evaluate(() => (window as unknown as { __talos: Talos }).__talos.store.getState().config.dedicated),
  ).toBe(undefined)
}

const scope = (page: Page) =>
  isPhoneWidth(page) ? page.getByRole('main') : page.getByRole('complementary', { name: 'Sidebar' })
const settingsFor = (page: Page, name: string) =>
  scope(page).getByRole('button', { name: `Thread settings for ${name}`, exact: true })
const ownSwitch = (page: Page) => page.getByTestId('own-session-switch')
const config = (page: Page) =>
  page.evaluate(() => (window as unknown as { __talos: Talos }).__talos.store.getState().config)

test('Settings shows thread sessions allowed on a config that never wrote the switch', async ({ page }) => {
  await setUp(page, '/settings/thread-sessions')
  await expect(page.getByRole('switch', { name: 'Allow threads to have their own agent' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
})

test("each ordinary thread offers its own session, off; General doesn't; the first one on writes the switch", async ({
  page,
}) => {
  await setUp(page, isPhoneWidth(page) ? '/threads' : '/')
  // a leftover from before shows off: it never ran
  await settingsFor(page, 'Garden').click()
  await expect(ownSwitch(page)).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await expect(ownSwitch(page)).toHaveCount(0)

  await settingsFor(page, 'General').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('own-session')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await settingsFor(page, 'Trip').click()
  await expect(page.getByTestId('own-session')).toContainText('Uses your plan limits on each start')
  await expect(ownSwitch(page)).toHaveAttribute('aria-checked', 'false')
  await ownSwitch(page).click()
  await expect(ownSwitch(page)).toHaveAttribute('aria-checked', 'true')
  const c = await config(page)
  expect(c.dedicated?.enabled).toBe(true)
  const session = (id: string) => c.threads.find((t) => t.id === id)?.session
  expect(session('trip')).toBe('dedicated')
  expect(session('garden')).toBe('shared')
})
