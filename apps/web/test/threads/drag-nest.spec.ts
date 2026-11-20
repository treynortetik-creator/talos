// Drag-to-nest in the thread list's edit mode: a thread dropped ONTO another goes under it (the same parent_id patch as the
// Under picker); dropped between two rows it is reordered as before. Only where it may go: never onto a sub-thread or a
// thread that holds sub-threads.
import { expect, type Page, test } from '@playwright/test'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

type Talos = {
  store: {
    getState: () => {
      presence: Record<string, unknown> & { features?: string[] }
      config: { threads: Array<{ id: string; parent_id?: string }> }
    }
    setState: (s: Record<string, unknown>) => void
  }
  patchConfig: (p: unknown) => Promise<void>
}
async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async () => {
    const t = (window as unknown as { __talos: Talos }).__talos
    const st = t.store.getState()
    t.store.setState({ presence: { ...st.presence, features: [...(st.presence.features ?? []), 'subthreads/1'] } })
    const mk = (id: string, name: string, order: number) => ({
      id,
      name,
      kind: 'fixed',
      order,
      notify: 'all',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    })
    const keep = st.config.threads.filter((x) => !['work', 'daily', 'notes'].includes(x.id))
    await t.patchConfig({ threads: [...keep, mk('work', 'Work', 2), mk('daily', 'Daily', 3), mk('notes', 'Notes', 4)] })
  })
  if (isPhoneWidth(page)) await openPhoneMenu(page)
  await page.getByTestId('edit-threads').first().click()
  await expect(page.getByTestId('thread-order').first()).toBeVisible()
}
const parentOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (window as unknown as { __talos: Talos }).__talos.store.getState().config.threads.find((t) => t.id === id)
        ?.parent_id ?? null,
    id,
  )
const orderIds = (page: Page) =>
  page
    .getByTestId('thread-order')
    .first()
    .locator('[data-reorder-row]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-reorder-row')))

/** Drags the handle of `id` so the middle of its row lands at `fraction` of the height of `onto`'s row. */
async function dragOnto(page: Page, id: string, onto: string, fraction: number, during?: () => Promise<void>) {
  const list = page.getByTestId('thread-order').first()
  const h = await list.getByTestId(`reorder-handle-${id}`).boundingBox()
  const row = await list.locator(`[data-reorder-row="${onto}"]`).boundingBox()
  const own = await list.locator(`[data-reorder-row="${id}"]`).boundingBox()
  if (!h || !row || !own) throw new Error('no box')
  const x = h.x + h.width / 2
  const y = h.y + h.height / 2
  // the handle sits at the row's vertical middle: move by the gap between the two rows' middles, plus the fraction
  const dy = row.y + row.height * fraction - (own.y + own.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + (dy * i) / 8)
  await during?.()
  await page.mouse.up()
}

test('a thread dropped onto another goes under it; dropped between two it is reordered', async ({ page }) => {
  test.skip(isPhoneWidth(page), 'a pointer drag on the computer list; touch is the same pointer events')
  await open(page)
  // onto the middle of Work: it says so while held, and Daily goes under Work
  await dragOnto(page, 'daily', 'work', 0.5, async () => {
    await expect(page.getByTestId('nest-label')).toHaveText('Put Daily under this')
  })
  await expect.poll(() => parentOf(page, 'daily')).toBe('work')
  // between rows (Notes to the top quarter of General): a reorder, nothing nested
  const before = await orderIds(page)
  await dragOnto(page, 'notes', 'general', 0.1)
  await expect.poll(() => orderIds(page)).not.toEqual(before)
  expect(await parentOf(page, 'notes')).toBeNull()
  // Work now holds Daily: nothing may be dropped onto Daily (a sub-thread), and Work cannot go under anything
  await dragOnto(page, 'notes', 'daily', 0.5, async () => {
    await expect(page.getByTestId('nest-label')).toHaveCount(0)
  })
  expect(await parentOf(page, 'notes')).toBeNull()
  await dragOnto(page, 'work', 'notes', 0.5, async () => {
    await expect(page.getByTestId('nest-label')).toHaveCount(0)
  })
  expect(await parentOf(page, 'work')).toBeNull()
})
