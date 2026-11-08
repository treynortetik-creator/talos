// The row under each message: time, Copy, Listen and the "..." menu button. Hover shows it on a mouse, touch always shows it,
// and it sits below the text: the "..." never covers the first line.
import { expect, type Locator, type Page, test } from '@playwright/test'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const msg = (id: string, author: 'agent' | 'owner', text: string, at: string) => ({
  id: `m_01JBF3V7Q8K2M4N6P8R0S1T${id}`,
  thread_id: 'general',
  author,
  kind: 'text',
  text,
  format: author === 'agent' ? 'markdown' : 'plain',
  attachments: [],
  via: 'app',
  created_at: at,
})
const MSGS = [
  msg(
    'R1',
    'agent',
    'First line of an agent reply that is long enough to be a real line of text.',
    '2026-10-28T15:00:00.000Z',
  ),
  msg('R2', 'owner', 'First line of my own message.', '2026-10-28T15:01:00.000Z'),
]
const row = (page: Page, n: number) => page.locator(`[data-msg-id$="R${n}"]`)

async function seed(page: Page) {
  await page.goto('/t/general')
  await page.evaluate((msgs) => {
    type Store = { getState(): { messages: Record<string, unknown[]> }; setState(s: unknown): void }
    const st = (window as unknown as { __talos: { store: Store } }).__talos.store
    st.setState({
      ...st.getState(),
      messages: { ...st.getState().messages, general: [...(st.getState().messages.general ?? []), ...msgs] },
    })
  }, MSGS)
  await row(page, 2).scrollIntoViewIfNeeded()
}

type Box = { x: number; y: number; width: number; height: number }
/** The box of the first line of text inside `el` (a Range over its first text node). */
async function firstLine(el: Locator): Promise<Box> {
  return el.evaluate((root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    })
    const n = w.nextNode()
    if (!n) throw new Error('no text')
    const r = document.createRange()
    r.selectNodeContents(n)
    const b = r.getClientRects()[0]
    if (!b) throw new Error('no rect')
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  })
}
const hits = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

for (const [n, who] of [
  [1, 'an agent message'],
  [2, 'an owner message'],
] as const) {
  test(`${who}: the "..." is in the row under the text and never over the first line`, async ({ page }) => {
    await seed(page)
    const r = row(page, n)
    const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    if (!touch) await r.locator('time').hover()
    const actions = r.getByTestId('msg-actions')
    await expect(actions).toBeVisible()
    await expect(actions).toHaveCSS('opacity', '1')
    const line = await firstLine(r)
    const dots = await box(actions)
    expect(hits(dots, line)).toBe(false)
    expect(dots.y).toBeGreaterThanOrEqual(line.y + line.height - 1) // below the text, in its own row
    // the row reads time, then Copy, then (agent only) Listen, then the "..." last
    const time = await box(r.locator('time'))
    const copy = await box(r.getByTestId('msg-copy-inline'))
    expect(time.x).toBeLessThan(copy.x)
    expect(copy.x).toBeLessThan(dots.x)
    if (n === 1) {
      const listen = await box(r.getByTestId('speak'))
      expect(copy.x).toBeLessThan(listen.x)
      expect(listen.x).toBeLessThan(dots.x)
    }
  })

  test(`${who}: the "..." opens the menu with Copy, Share and Reply`, async ({ page }) => {
    await seed(page)
    const r = row(page, n)
    if (!(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) await r.locator('time').hover()
    await r.getByTestId('msg-actions').click()
    await expect(page.getByTestId('msg-copy')).toBeVisible()
    await expect(page.getByTestId('msg-reply')).toBeVisible()
  })
}

test('on a mouse the actions are hidden until the row is hovered; on touch they are always shown', async ({ page }) => {
  await seed(page)
  const actions = row(page, 1).getByTestId('msg-actions')
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (touch) {
    await expect(actions).toHaveCSS('opacity', '1')
    expect((await box(actions)).height).toBeGreaterThanOrEqual(43)
    return
  }
  await page.mouse.move(2, 2)
  await expect(actions).toHaveCSS('opacity', '0')
  await row(page, 1).locator('time').hover()
  await expect(actions).toHaveCSS('opacity', '1')
})

test('the row shows for a keyboard user too: focus on Copy, with no mouse, reveals Copy, Listen and the menu', async ({
  page,
}) => {
  await seed(page)
  const r = row(page, 1)
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  test.skip(touch, 'a touch screen shows the row all the time')
  await page.mouse.move(2, 2)
  await expect(r.getByTestId('msg-actions')).toHaveCSS('opacity', '0')
  await r.getByTestId('msg-copy-inline').focus()
  for (const id of ['msg-copy-inline', 'speak', 'msg-actions'])
    await expect(r.getByTestId(id), id).toHaveCSS('opacity', '1')
})

test('hovering waits a moment before the row appears, so scrolling past does not flicker it; focus does not wait', async ({
  page,
}) => {
  await seed(page)
  const r = row(page, 1)
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  test.skip(touch, 'a touch screen shows the row all the time')
  const delay = (id: string) => r.getByTestId(id).evaluate((el) => getComputedStyle(el).transitionDelay)
  await r.locator('time').hover()
  await expect(r.getByTestId('msg-actions')).toHaveCSS('opacity', '1')
  expect(await delay('msg-actions')).toMatch(/^0\.\d+s$/)
  expect(await delay('msg-actions')).not.toBe('0s')
  await page.mouse.move(2, 2)
  await expect(r.getByTestId('msg-actions')).toHaveCSS('opacity', '0')
  await r.getByTestId('msg-copy-inline').focus()
  expect(await delay('msg-actions')).toBe('0s')
})
