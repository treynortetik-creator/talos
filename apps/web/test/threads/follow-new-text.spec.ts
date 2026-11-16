// New text follows to the newest (owner, 2026-11-15; one switch, FOLLOW_NEW_TEXT in jumpToLatest.ts). Within a screen of the
// bottom a new reply, or a reply growing as it streams, scrolls into view; further up the owner is left reading and the down
// arrow counts what came; his own send always goes to the bottom.
import { expect, type Page, test } from '@playwright/test'

type Talos = { store: { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void } }

const row = (i: number, author: 'agent' | 'owner', text?: string) => ({
  id: `m_seed_${String(i).padStart(4, '0')}`,
  thread_id: 'general',
  seq: 1000 + i,
  author,
  kind: 'text',
  text: text ?? `Sample message ${i}. ${'Long enough to wrap on a phone and fill the thread. '.repeat(2)}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
})

const setRows = (page: Page, rows: unknown[]) =>
  page.evaluate((r) => {
    const t = (window as unknown as { __talos: Talos }).__talos
    t.store.setState((s) => ({ messages: { ...((s.messages as Record<string, unknown[]>) ?? {}), general: r } }))
  }, rows)

async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  const base = Array.from({ length: 40 }, (_, i) => row(i, i % 3 ? 'agent' : 'owner'))
  await setRows(page, base)
  const tl = page.getByTestId('timeline')
  await expect(tl.locator('[data-msg-id]').last()).toHaveAttribute('data-msg-id', 'm_seed_0039')
  await tl.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  return { tl, base }
}

/** Distance from the end, in px. */
const gap = (tl: import('@playwright/test').Locator) =>
  tl.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))

const scrollUp = async (tl: import('@playwright/test').Locator, screens: number) => {
  await tl.evaluate((el, n) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - Math.round(el.clientHeight * n)
    el.dispatchEvent(new Event('scroll'))
  }, screens)
  await expect.poll(() => gap(tl)).toBeGreaterThan(50)
}

test('half a screen up: a new reply scrolls into view', async ({ page }) => {
  const { tl, base } = await open(page)
  await scrollUp(tl, 0.5)
  await setRows(page, [...base, row(40, 'agent')])
  await expect.poll(() => gap(tl)).toBeLessThan(5)
})

test('three screens up: he is left reading, and the down arrow counts the new reply', async ({ page }) => {
  const { tl, base } = await open(page)
  await scrollUp(tl, 3)
  const before = await tl.evaluate((el) => el.scrollTop)
  await setRows(page, [...base, row(40, 'agent')])
  await expect(page.getByTestId('jump-to-latest')).toHaveAccessibleName(/1 new message/)
  expect(await tl.evaluate((el) => el.scrollTop)).toBe(before)
})

test('his own send goes to the bottom even from far up', async ({ page }) => {
  const { tl, base } = await open(page)
  await scrollUp(tl, 3)
  const { seq: _stored, ...mine } = row(40, 'owner', 'my own words') // sent from this screen: no seq until the relay stores it
  await setRows(page, [...base, mine])
  await expect.poll(() => gap(tl)).toBeLessThan(5)
})

test('a reply growing as it streams is followed at the bottom', async ({ page }) => {
  const { tl, base } = await open(page)
  const last = row(40, 'agent', 'Starting.')
  await setRows(page, [...base, last])
  await expect.poll(() => gap(tl)).toBeLessThan(5)
  for (let i = 1; i <= 4; i++) {
    await setRows(page, [
      ...base,
      { ...last, text: `Starting. ${'More words arrive as the reply streams in. '.repeat(i * 6)}` },
    ])
    await expect.poll(() => gap(tl)).toBeLessThan(5)
  }
})

test('after Send the keyboard goes down on a phone (the box lets go of focus); on a computer the box keeps it', async ({
  page,
}) => {
  await open(page)
  const box = page.getByTestId('composer').getByRole('textbox')
  await box.click()
  await box.fill('hello there')
  await page.getByTestId('composer').getByRole('button', { name: 'Send' }).click()
  await expect(box).toHaveValue('')
  const phone = await page.evaluate(
    () => matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 767px)').matches,
  )
  const focused = await box.evaluate((el) => document.activeElement === el)
  expect(focused).toBe(!phone)
})

test('a few lines up while a reply streams: he stays where he is rereading', async ({ page }) => {
  const { tl, base } = await open(page)
  const last = row(40, 'agent', 'Starting.')
  await setRows(page, [...base, last])
  await expect.poll(() => gap(tl)).toBeLessThan(5)
  await tl.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 200
    el.dispatchEvent(new Event('scroll'))
  })
  const top = await tl.evaluate((el) => el.scrollTop)
  for (let i = 1; i <= 3; i++) {
    await setRows(page, [
      ...base,
      { ...last, text: `Starting. ${'More words arrive as the reply streams in. '.repeat(i * 6)}` },
    ])
    await page.waitForTimeout(100)
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top)
  }
})

test('a reply from his other device does not move this screen when he is far up', async ({ page }) => {
  const { tl, base } = await open(page)
  await scrollUp(tl, 3)
  const top = await tl.evaluate((el) => el.scrollTop)
  await setRows(page, [...base, { ...row(40, 'owner', 'sent from my phone'), seq: 1040 }])
  await expect(page.getByTestId('jump-to-latest')).toBeVisible()
  expect(await tl.evaluate((el) => el.scrollTop)).toBe(top)
})
