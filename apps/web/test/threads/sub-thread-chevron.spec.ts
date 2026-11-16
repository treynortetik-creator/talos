// A parent thread's sub-thread chevron sits at the RIGHT end of its own row, next to its "...", in the desktop sidebar and the
// phone's menu (owner ask, 2026-11-11: the left chevron column squashed every row). Rows without sub-threads keep their place,
// the touch stays 44 x 44 px without moving the row, and the sub-threads still open indented under their parent.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

/** Adds Work and Notes; with `nested`, Daily under Work too. */
async function seed(page: Page, nested: boolean) {
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async (nested) => {
    const c = (
      window as unknown as {
        __talos: {
          store: { getState: () => { config: { threads: Array<{ id: string }> } } }
          patchConfig: (p: unknown) => Promise<void>
        }
      }
    ).__talos
    const mk = (id: string, name: string, order: number, parent_id?: string) => ({
      id,
      name,
      kind: 'fixed',
      order,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
      ...(parent_id ? { parent_id } : {}),
    })
    const keep = c.store.getState().config.threads.filter((t) => !['work', 'notes', 'daily'].includes(t.id))
    await c.patchConfig({
      threads: [
        ...keep,
        mk('work', 'Work', 2),
        mk('notes', 'Notes', 4),
        ...(nested ? [mk('daily', 'Daily', 3, 'work')] : []),
      ],
    })
  }, nested)
}

/** The thread list: the sidebar on a wide screen, the menu (opened) on a phone. */
async function list(page: Page): Promise<Locator> {
  if (!isPhoneWidth(page)) return page.getByRole('complementary', { name: 'Sidebar' })
  const menu = page.getByTestId('phone-menu')
  if (!(await menu.isVisible())) await page.getByTestId('phone-menu-button').click()
  await expect(menu).toBeVisible()
  // the menu slides in: measure once it has stopped
  let last = Number.NaN
  await expect
    .poll(async () => {
      const x = (await menu.boundingBox())?.x ?? Number.NaN
      const still = x === last && x >= 0
      last = x
      return still
    })
    .toBe(true)
  return menu
}

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const row = (l: Locator, name: string) => l.getByRole('link', { name: new RegExp(`^${name}`) })
/** Where each row's icon starts: rows that line up have the same x. */
const iconX = async (l: Locator, name: string) => (await box(row(l, name).locator('span').first())).x

test('the sub-thread chevron is at the right of its parent row; other rows do not move', async ({ page }, info) => {
  await page.goto('/t/general')
  await seed(page, false)
  let l = await list(page)
  await expect(row(l, 'Notes')).toBeVisible()
  const before = { general: await iconX(l, 'General'), work: await iconX(l, 'Work'), notes: await iconX(l, 'Notes') }
  await expect(l.locator('[data-testid^="subthreads-toggle-"]')).toHaveCount(0)

  await seed(page, true)
  l = await list(page)
  const toggle = l.getByTestId('subthreads-toggle-work')
  await expect(toggle).toBeVisible()
  // only the parent has one, and no row moved for it: the old left column pushed every row 44 px right
  await expect(l.locator('[data-testid^="subthreads-toggle-"]')).toHaveCount(1)
  expect({
    general: await iconX(l, 'General'),
    work: await iconX(l, 'Work'),
    notes: await iconX(l, 'Notes'),
  }).toEqual(before)

  // right end of the Work row, just left of its "...", the touch 44 x 44 px inside the row's height
  const t = await box(toggle)
  const link = await box(row(l, 'Work'))
  const more = await box(l.getByTestId('thread-more-work'))
  const name = await box(row(l, 'Work').getByText('Work', { exact: true }))
  expect(t.width).toBeGreaterThanOrEqual(44)
  expect(t.height).toBeGreaterThanOrEqual(44)
  expect(t.x).toBeGreaterThan(link.x + link.width / 2)
  expect(t.x + t.width).toBeLessThanOrEqual(more.x + 1)
  expect(t.x + t.width).toBeLessThanOrEqual(link.x + link.width + 1)
  expect(name.x + name.width).toBeLessThanOrEqual(t.x + 1) // the name is never under it
  expect(Math.abs(t.y + t.height / 2 - (link.y + link.height / 2))).toBeLessThanOrEqual(1)

  // it opens and closes the sub-threads, which draw indented under the parent
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(row(l, 'Daily')).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(row(l, 'Daily')).toBeVisible()
  expect(await iconX(l, 'Daily')).toBeGreaterThan(before.work + 8)
  expect((await box(row(l, 'Daily'))).y).toBeGreaterThan(link.y)
  expect(await iconX(l, 'Notes')).toBe(before.notes)
  // the picture of it, once the chevron has turned and the pointer is off it
  await page.mouse.move(1, 1)
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.screenshot({ path: info.outputPath('work-daily.png') })
  await toggle.click()
  await expect(row(l, 'Daily')).toHaveCount(0)
  // pressing the chevron did not follow the parent's link
  await expect(page).toHaveURL(/\/t\/general$/)
})
