// Package C review round, driven in real browsers (iPhone WebKit, Pixel Chromium, desktop): where the message menu opens,
// that it survives a real finger lifting, that Reply leaves the cursor in the box, that the hover button is reachable and
// not clipped, that Edit does not eat a draft, and that retrying a failed "Send as a text file" leaves a way out.
import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, frameOfType, openSignedIn, waitUntil } from '../helpers/util.ts'

const box = (page: Page) => page.getByLabel('Message', { exact: true })
const menuBox = (page: Page) => page.getByTestId('msg-copy').boundingBox()

async function seedRows(harness: Parameters<typeof frameOfType>[0], n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = agentReply({ text: `row ${i} ${'filler '.repeat(20)}`, format: 'plain' })
    ids.push(r.message.id)
    harness.relay.sendToApps(r)
  }
  return ids
}

/** A touch press-and-hold on a row by synthetic pointer events (works in WebKit too, where there is no raw touch API). */
async function holdPointer(row: Locator, ms: number, moveBy = 0) {
  await row.locator('.group').evaluate(
    async (el, a) => {
      const r = el.getBoundingClientRect()
      const x = r.left + 30
      const y = r.top + r.height / 2
      const init = { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: x, clientY: y }))
      if (a.moveBy) el.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + a.moveBy, clientY: y }))
      await new Promise((res) => setTimeout(res, a.ms))
    },
    { ms, moveBy },
  )
}

test('a long-press opens the menu at the message, not in the corner of the screen', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  await seedRows(harness, 14)
  const rows = page.getByTestId('msg-agent')
  await expect(rows).toHaveCount(14)
  for (const idx of [3, 12]) {
    const row = rows.nth(idx)
    await row.scrollIntoViewIfNeeded()
    await holdPointer(row, 700)
    await expect(page.getByTestId('msg-copy')).toBeVisible()
    const rowBox = (await row.boundingBox()) as { x: number; y: number; width: number; height: number }
    const m = (await menuBox(page)) as { x: number; y: number; width: number; height: number }
    // beside or just above/below the row, never parked at the top-left of the screen
    const gap = m.y >= rowBox.y + rowBox.height ? m.y - (rowBox.y + rowBox.height) : rowBox.y - (m.y + m.height * 2 + 8)
    expect(Math.abs(gap) < 120 || (m.y > rowBox.y && m.y < rowBox.y + rowBox.height)).toBe(true)
    expect(m.x).toBeGreaterThan(8)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('msg-copy')).toHaveCount(0)
  }
})

test('a few pixels of finger jitter does not cancel the long-press; a real drag does', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  await seedRows(harness, 3)
  const row = page.getByTestId('msg-agent').nth(1)
  await holdPointer(row, 700, 3)
  await expect(page.getByTestId('msg-copy')).toBeVisible()
  await page.keyboard.press('Escape')
  await holdPointer(row, 700, 40)
  await expect(page.getByTestId('msg-copy')).toHaveCount(0)
})

test('a long-press menu stays open when the finger lifts (real touch)', async ({ page, context, harness }, info) => {
  test.skip(info.project.name !== 'pixel', 'needs raw touch input (Chromium DevTools protocol)')
  await openSignedIn(harness, page, context)
  await seedRows(harness, 3)
  const row = page.getByTestId('msg-agent').nth(1)
  const b = (await row.boundingBox()) as { x: number; y: number; height: number }
  const cdp = await context.newCDPSession(page)
  const pt = { x: b.x + 40, y: b.y + b.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
  await page.waitForTimeout(800)
  await expect(page.getByTestId('msg-copy')).toBeVisible()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(700)
  await expect(page.getByTestId('msg-copy')).toBeVisible()
  // a tap elsewhere still closes it
  await page.getByLabel('Message', { exact: true }).click()
  await expect(page.getByTestId('msg-copy')).toHaveCount(0)
  // and a 1px wobble before the hold still opens it
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pt.x + 1, y: pt.y }] })
  await page.waitForTimeout(800)
  await expect(page.getByTestId('msg-copy')).toBeVisible()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
})

test('Reply leaves the cursor in the message box', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  await seedRows(harness, 2)
  const row = page.getByTestId('msg-agent').first()
  await row.getByText('row 0').click({ button: 'right' })
  await page.getByTestId('msg-reply').click()
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Message')
  // typing lands in the box, and Enter does not reopen the menu
  await page.keyboard.type('hello')
  await expect(box(page)).toHaveValue('hello')
  await expect(page.getByTestId('msg-copy')).toHaveCount(0)
})

test('right-click on selected text leaves the browser menu alone; without a selection it opens ours', async ({
  page,
  context,
  harness,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse selection')
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'alpha bravo charlie delta', format: 'plain' }))
  const word = page.getByTestId('msg-agent').getByText('alpha bravo charlie delta')
  await expect(word).toBeVisible()
  await word.dblclick({ position: { x: 5, y: 8 } }) // selects "alpha"
  expect(await page.evaluate(() => String(window.getSelection()).trim())).toBe('alpha')
  // what the page did with the next contextmenu event: did it take it over (preventDefault), or leave the browser's menu?
  await page.evaluate(() => {
    const w = window as unknown as { __ctx: boolean[] }
    w.__ctx = []
    document.addEventListener('contextmenu', (e) => w.__ctx.push(e.defaultPrevented))
  })
  await word.click({ button: 'right', position: { x: 5, y: 8 } }) // right-click on the selected word
  expect(await page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx)).toEqual([false])
  await expect(page.getByTestId('msg-copy')).toHaveCount(0)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await word.click({ button: 'right' })
  await expect(page.getByTestId('msg-copy')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx)).toEqual([false, true])
})

for (const width of [1440, 500]) {
  test(`the hover button stays inside the timeline and the timeline does not scroll sideways (${width}px)`, async ({
    page,
    context,
    harness,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'the button is hidden on touch devices')
    await page.setViewportSize({ width, height: 900 })
    await openSignedIn(harness, page, context)
    harness.relay.sendToApps(agentReply({ text: 'agent row here', format: 'plain' }))
    await box(page).fill('owner row here')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    for (const id of ['msg-agent', 'msg-owner']) {
      const row = page.getByTestId(id).first()
      await row.locator('.group').hover()
      const btn = row.getByTestId('msg-actions')
      await expect(btn).toHaveCSS('opacity', '1')
      const r = await page.evaluate((rowId) => {
        const b = document.querySelector(`[data-testid="${rowId}"] [data-testid="msg-actions"]`) as HTMLElement
        const br = b.getBoundingClientRect()
        let el: HTMLElement | null = b.parentElement
        let clip: DOMRect | null = null
        let overflow = 0
        while (el && el !== document.body) {
          const cs = getComputedStyle(el)
          if (cs.overflowX !== 'visible') {
            clip = el.getBoundingClientRect()
            overflow = el.scrollWidth - el.clientWidth
            break
          }
          el = el.parentElement
        }
        return {
          left: br.left,
          right: br.right,
          clipLeft: clip?.left ?? 0,
          clipRight: clip?.right ?? innerWidth,
          overflow,
        }
      }, id)
      expect(r.left).toBeGreaterThanOrEqual(r.clipLeft)
      expect(r.right).toBeLessThanOrEqual(r.clipRight)
      expect(r.overflow).toBeLessThanOrEqual(0)
    }
  })
}

test('a slow mouse can reach the hover button (no dead gap)', async ({ page, context, harness }, info) => {
  test.skip(info.project.name !== 'desktop', 'the button is hidden on touch devices')
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'agent row here', format: 'plain' }))
  await box(page).fill('owner row here')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  for (const id of ['msg-owner', 'msg-agent']) {
    const row = page.getByTestId(id).first()
    await row.locator('.group').hover()
    const btn = row.getByTestId('msg-actions')
    await expect(btn).toHaveCSS('opacity', '1')
    const bb = (await btn.boundingBox()) as { x: number; y: number; width: number; height: number }
    const rb = (await row.locator('.group').boundingBox()) as { x: number; y: number; width: number; height: number }
    const target = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
    const start = { x: rb.x + rb.width / 2, y: target.y }
    // park the mouse in the middle of the message, then creep 1px per step to the button
    await page.mouse.move(start.x, start.y)
    const dx = Math.sign(target.x - start.x)
    for (let x = start.x; Math.abs(x - target.x) > 0.5; x += dx) await page.mouse.move(x, target.y, { steps: 1 })
    await page.mouse.move(target.x, target.y)
    await expect(btn).toHaveCSS('opacity', '1')
    await expect(btn).toHaveCSS('pointer-events', 'auto')
    expect(await btn.evaluate((el) => el.matches(':hover'))).toBe(true)
    await page.mouse.move(5, 5)
  }
})

test('Edit on a failed message keeps what was already typed', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context, '/t/general', { pinned: false })
  await box(page).fill('doomed words')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'doomed words' })).toBeVisible()
  const ids = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('talos-app')
        open.onsuccess = () => {
          const req = open.result.transaction('outbox').objectStore('outbox').getAll()
          req.onsuccess = () => resolve((req.result as Array<{ id: string }>).map((e) => e.id))
        }
      }),
  )
  harness.relay.sendToApps({ type: 'error', ref: ids[0], code: 'internal', message: 'nope' })
  await box(page).fill('a long new draft I was typing')
  await page.getByTestId('send-failed-edit').click()
  await expect(box(page)).toHaveValue(/doomed words/)
  expect(await box(page).inputValue()).toContain('a long new draft I was typing')
  await page.waitForTimeout(700)
  await page.reload()
  await page.getByTestId('thread-screen').waitFor()
  await expect.poll(() => box(page).inputValue()).toContain('a long new draft I was typing')
})

test('after a failed "Send as a text file", Retry on the chip sends the text file and clears the box', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  await box(page).fill('z'.repeat(50_000))
  let first = true
  await page.route('**/api/media', (route) => {
    if (first && route.request().method() === 'POST') {
      first = false
      return route.fulfill({ status: 500, body: 'boom' })
    }
    return route.fallback()
  })
  await page.getByTestId('send-as-file').click()
  await expect(page.getByTestId('chip')).toHaveAttribute('data-state', 'error')
  expect(await box(page).inputValue()).toHaveLength(50_000) // the text stays while the upload has not arrived
  await page.getByTestId('chip-retry').click()
  await expect(page.getByTestId('chip')).toHaveAttribute('data-state', 'ready')
  expect(await box(page).inputValue()).toBe('') // one copy of the text now, as the file
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'message with the text file')
  const m = frameOfType(harness, 'message')[0]?.raw as { text?: string; attachments: Array<{ name: string }> }
  expect(m.attachments[0]?.name).toBe('message.txt')
  expect((m.text ?? '').length).toBe(0)
})
