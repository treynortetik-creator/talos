// The Copy button in every message's meta line, in a real browser (fake mode, VITE_FAKE=1): visible with no hover and no
// long-press, 44 by 44 on touch, copies the text, and never sits over the text, a link, the Run button or Listen. The pixel
// 375px shots are committed in test/threads/shots; other projects write shots only when $SHOT_DIR is set (as settings-home.spec.ts).
import { expect, type Page, test } from '@playwright/test'

const SHOT_DIR = process.env.SHOT_DIR
/** Where a shot goes: the committed folder for pixel, $SHOT_DIR for anyone else, otherwise nowhere (no file). */
const shotPath = (project: string, name: string) =>
  project === 'pixel' ? `test/threads/shots/pixel-${name}.png` : SHOT_DIR ? `${SHOT_DIR}/${project}-${name}.png` : null

const LONG = Array.from({ length: 8 }, (_, i) => `echo "step ${i}"`).join('\n')
const agent = (id: string, text: string) => ({
  id: `m_01JBF3V7Q8K2M4N6P8R0S1T${id}`,
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text,
  format: 'markdown',
  attachments: [],
  via: 'app',
  created_at: '2026-10-28T15:00:00.000Z',
})
const MSGS = [
  agent('C1', 'Plain words first.\n\n[link to the docs](https://example.com/docs)'),
  agent('C2', `Run this:\n\n\`\`\`sh\n${LONG}\n\`\`\``),
]
const row = (page: Page, n: number) => page.locator(`[data-msg-id$="C${n}"]`)
async function seed(page: Page) {
  await page.evaluate((msgs) => {
    type Store = { getState(): { messages: Record<string, unknown[]> }; setState(s: unknown): void }
    const st = (window as unknown as { __talos: { store: Store } }).__talos.store
    st.setState({
      ...st.getState(),
      messages: { ...st.getState().messages, general: [...(st.getState().messages.general ?? []), ...msgs] },
    })
  }, MSGS)
}
const SHORT = ['Ok.', 'Sure thing.', 'Next one?', 'Yes, go.', 'Done.', 'Thanks.', 'Later.', 'Got it.']
const short = (i: number) => ({
  ...agent(`D${i}`, SHORT[i] ?? 'Ok.'),
  author: i % 2 === 0 ? 'owner' : 'agent',
  // seeded after the stock messages, one minute apart
  created_at: `2026-10-28T16:0${i}:00.000Z`,
})
type Box = { x: number; y: number; width: number; height: number }
const hits = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const box = async (l: import('@playwright/test').Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

async function open(page: Page) {
  await page.addInitScript(() => {
    ;(window as unknown as { __copied: string[] }).__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => (window as unknown as { __copied: string[] }).__copied.push(t) },
    })
  })
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('msg-agent').first()).toBeVisible()
}

test('Copy is visible without hover on an agent message, copies its text, and says Copied', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page)
  const row = page.getByTestId('msg-agent').first()
  const btn = row.getByRole('button', { name: 'Copy message' })
  await expect(btn).toBeVisible()
  await btn.click()
  await expect(row.getByTestId('msg-copy-note')).toHaveText('Copied')
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
  expect(copied).toHaveLength(1)
  expect(copied[0]?.length).toBeGreaterThan(0)
  const head = (copied[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
  expect(head.length).toBeGreaterThan(0)
  expect(((await row.textContent()) ?? '').replace(/\s+/g, ' ')).toContain(head)
})

test('Copy is visible on an owner message too, and has no horizontal scroll', async ({ page }) => {
  await open(page)
  const owners = page.getByTestId('msg-owner')
  if ((await owners.count()) > 0) {
    await expect(owners.first().getByRole('button', { name: 'Copy message' })).toBeVisible()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('on touch the hit area is 44 by 44 and overlaps no neighbour', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'touch only')
  await open(page)
  await seed(page)
  for (const n of [1, 2]) {
    const r = row(page, n)
    await r.scrollIntoViewIfNeeded()
    const b = await box(r.getByRole('button', { name: 'Copy message' }))
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
    // nothing above the time line: not the text, not the Run control, not a link
    const above = r.locator('time').first().locator('xpath=ancestor::div[1]/preceding-sibling::*')
    for (let i = 0; i < (await above.count()); i++) {
      const o = await above.nth(i).boundingBox()
      if (o) expect(hits(b, o), `Copy hits block ${i} of row C${n}`).toBe(false)
    }
    for (const sel of ['run-button', 'run-control']) {
      const o = (await r.getByTestId(sel).count()) > 0 ? await r.getByTestId(sel).first().boundingBox() : null
      if (o) expect(hits(b, o), `Copy hits ${sel}`).toBe(false)
    }
    const listen = await box(r.getByTestId('speak'))
    expect(hits(b, listen), 'Copy hits Listen').toBe(false)
  }
})

test('eight short alternating messages stay dense on a phone (the Copy box does not inflate rows)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'touch only')
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page)
  await page.evaluate(
    (msgs) => {
      type Store = { getState(): { messages: Record<string, unknown[]> }; setState(s: unknown): void }
      const st = (window as unknown as { __talos: { store: Store } }).__talos.store
      st.setState({ ...st.getState(), messages: { ...st.getState().messages, general: msgs } })
    },
    Array.from({ length: 8 }, (_, i) => short(i)),
  )
  const rows = page.locator('[data-msg-id*="D"]')
  await expect(rows).toHaveCount(8)
  await rows.first().scrollIntoViewIfNeeded()
  const first = await box(rows.first())
  const last = await box(rows.last())
  const span = last.y + last.height - first.y
  // Before the fix this span was 896 px (each row 28 px taller than its text needs); a row without a 44 px Copy box was 672.
  // 740 is that 672 plus 10%.
  expect(span, `eight rows span ${span} px`).toBeLessThanOrEqual(740)
  // and the Copy box is still 44 by 44, beside Listen on agent rows
  for (let i = 0; i < 8; i++) {
    const r = rows.nth(i)
    const c = await box(r.getByRole('button', { name: 'Copy message' }))
    expect(c.width).toBeGreaterThanOrEqual(44)
    expect(c.height).toBeGreaterThanOrEqual(44)
    if (i % 2 === 1) {
      const l = await box(r.getByTestId('speak'))
      expect(hits(c, l), `Copy hits Listen in row ${i}`).toBe(false)
      expect(Math.abs(c.y - l.y), 'Copy and Listen share one row').toBeLessThanOrEqual(2)
    }
  }
  console.log(`ROWS_SPAN ${info.project.name} ${span}`)
})

test('touch tap on the lower-right of Run (and of Yes) runs it and does not copy', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'touch only')
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page)
  await seed(page)
  const r = row(page, 2)
  await r.scrollIntoViewIfNeeded()
  const run = await box(r.getByTestId('run-button'))
  await page.touchscreen.tap(run.x + run.width - 8, run.y + run.height - 8)
  await expect(r.getByTestId('run-confirm')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([])
  const p = shotPath(info.project.name, 'copy-run-375')
  if (p) await page.screenshot({ path: p })
  const yes = await box(r.getByTestId('run-confirm'))
  await page.touchscreen.tap(yes.x + yes.width - 8, yes.y + yes.height - 8)
  await expect(r.getByTestId('run-status')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([])
})

test('touch tap on the last text line link follows it and does not copy', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'touch only')
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page)
  await seed(page)
  await page.evaluate(() => {
    ;(window as unknown as { __clicked: string[] }).__clicked = []
    document.addEventListener(
      'click',
      (e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (a) {
          ;(window as unknown as { __clicked: string[] }).__clicked.push(a.href)
          e.preventDefault()
        }
      },
      true,
    )
  })
  const r = row(page, 1)
  await r.scrollIntoViewIfNeeded()
  // the lower edge of the link's last line, at x 80 (above Copy's old box: x 58-102), where the old upward hit area sat (a wrapped link has one rect per line)
  const last = await r.getByRole('link', { name: 'link to the docs' }).evaluate((a) => {
    const rects = a.getClientRects()
    const q = rects[rects.length - 1] as DOMRect
    return { x: Math.min(80, q.right - 6), y: q.bottom - 3 }
  })
  await page.touchscreen.tap(last.x, last.y)
  expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)).toEqual([
    'https://example.com/docs',
  ])
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([])
})

test('a held finger on Copy or Listen opens no menu', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page)
  const r = page.getByTestId('msg-agent').first()
  for (const target of [r.getByRole('button', { name: 'Copy message' }), r.getByTestId('speak')]) {
    await target.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true })
    await page.waitForTimeout(800)
    await expect(page.getByTestId('msg-copy')).toHaveCount(0)
    await target.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true })
  }
  // control: the same hold on the text itself does open it
  await r.locator('time').first().dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await expect(page.getByTestId('msg-copy')).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`idle icon, ${colorScheme}`, () => {
    test.use({ colorScheme })
    test('375px shot', async ({ page }, info) => {
      await page.setViewportSize({ width: 375, height: 812 })
      await open(page)
      const p = shotPath(info.project.name, `copy-idle-${colorScheme}-375`)
      if (p) await page.screenshot({ path: p })
    })
  })
}
