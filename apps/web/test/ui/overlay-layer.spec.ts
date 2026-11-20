// One overlay layer (ui/layers.ts): a sheet, dialog or popover is above the page's own floating controls. On a desktop the
// usage chip sits in the thread header's top-right corner (z-10), and a right-hand sheet used to open under it: the chip
// covered the sheet's top corner, where its close button is. Two different sheets, at desktop width.
import { expect, type Page, test } from '@playwright/test'

test.use({ bypassCSP: true, serviceWorkers: 'block' })
test.beforeEach(({ isMobile }) => test.skip(isMobile, 'right-hand sheets open on a desktop'))

/** The usage chip is up (it waits for the session's first usage reading): what a sheet's corner must not be under. */
async function chipShowing(page: Page) {
  await expect(page.getByTestId('session-trigger')).toBeVisible()
  await expect(page.getByTestId('session-trigger')).toContainText('used')
}

/**
 * The sheet is stacked above the usage chip. (A hit test cannot see it: while a modal sheet is open the page behind it takes
 * no pointer events, so elementFromPoint skips the chip even where the chip is drawn over the sheet's corner.) Both are
 * positioned in the root stacking context, so their z-index decides which is drawn on top.
 */
async function cornerIsTheSheet(page: Page, sheetTestId: string) {
  const sheet = page.locator(
    `[role="dialog"]:has([data-testid="${sheetTestId}"]), [role="dialog"][data-testid="${sheetTestId}"]`,
  )
  await expect(sheet).toBeVisible()
  const z = async (l: ReturnType<Page['locator']>) =>
    l.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10))
  const sheetZ = await z(sheet)
  const chipZ = await z(page.getByTestId('session-trigger'))
  expect(Number.isFinite(sheetZ), `${sheetTestId} has a z-index of its own`).toBe(true)
  expect(sheetZ, `${sheetTestId} above the usage chip`).toBeGreaterThan(chipZ)
}

test('the thread settings sheet: nothing in the page covers its top corner', async ({ page }) => {
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-settings-trigger')).toBeVisible()
  await chipShowing(page)
  await page.getByTestId('thread-settings-trigger').click()
  await page.getByTestId('thread-settings-open').click()
  await cornerIsTheSheet(page, 'thread-settings')
})

test('the thread session sheet: nothing in the page covers its top corner', async ({ page }) => {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async () => {
    type Talos = {
      store: { getState: () => { config: { threads: unknown[] } }; setState: (f: (s: never) => never) => void }
      patchConfig: (p: Record<string, unknown>) => Promise<void>
      emit: (type: string, fields: Record<string, unknown>) => void
    }
    const c = (window as unknown as { __talos: Talos }).__talos
    await c.patchConfig({
      threads: [
        ...c.store.getState().config.threads,
        {
          id: 'work',
          name: 'Work',
          kind: 'fixed',
          order: 2,
          notify: 'all',
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
        threads: [{ thread_id: 'work', state: 'busy', turn_started_at: new Date(Date.now() - 300_000).toISOString() }],
        governor: { state: 'ok' },
        at: new Date().toISOString(),
      },
    })
    history.pushState(null, '', '/t/work')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await chipShowing(page)
  await page.getByTestId('phone-session-pill').click()
  await cornerIsTheSheet(page, 'session-sheet')
})

test('a popover menu is on the same layer: above the usage chip', async ({ page }) => {
  await page.goto('/t/general')
  await chipShowing(page)
  await page.getByTestId('thread-settings-trigger').click()
  const menu = page.locator('[data-radix-popper-content-wrapper]').first()
  await expect(menu).toBeVisible()
  const z = await menu.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10))
  expect(z).toBeGreaterThan(10)
})
