// Option B (owner, 2026-11-20): Stop is a pill on a working line under the newest message, inside the thread's scroll area.
// The message box keeps + and Send. After a stop, a strip above the box says "Stopped <agent>. Your message is kept." with
// Undo for 8 s. Every project (iphone, pixel, desktop), fake mode.
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

test.use({ serviceWorkers: 'block', bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  store: { setState(p: unknown): void; getState(): { statuses: Record<string, unknown> } }
  session: { patch(p: Record<string, unknown>): void }
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const stops = (page: Page) => fake(page, (t) => t.sent.filter((f) => f.action === 'stop').length)
const sentMessages = (page: Page) =>
  fake(page, (t) => t.sent.filter((f) => f.type === 'message').map((f) => ({ text: f.text, thread: f.thread_id })))

const line = (page: Page) => page.getByTestId('stop-line')
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop your agent', exact: true })

async function open(page: Page, rows = 0) {
  await page.goto('/t/general')
  await expect(page.getByTestId('composer')).toBeVisible()
  if (rows > 0) {
    await fake(page, (t) => {
      const st = t.store.getState() as unknown as { messages: Record<string, unknown[]> }
      const n = 30
      const list = Array.from({ length: n }, (_, i) => ({
        id: `m_line_${i}`,
        thread_id: 'general',
        author: i % 2 ? 'owner' : 'agent',
        kind: 'text',
        text: i === n - 1 ? 'finish the report' : `Row number ${i}`,
        format: 'plain',
        attachments: [],
        via: 'app',
        seq: 1000 + i,
        created_at: new Date(Date.now() - (n - i) * 60_000).toISOString(),
      }))
      t.store.setState({ ...st, messages: { ...st.messages, general: list } })
    })
    await expect(page.locator('[data-msg-id="m_line_29"]')).toHaveCount(1)
  }
  // The web fonts land after the first paint and change the rows' heights; the browser then moves scrollTop to keep the reader
  // on the same words (follow-new-text.spec, scroll-end.spec). Every check here compares positions with a reading taken earlier,
  // so the layout must have stopped changing first.
  await page.evaluate(() => document.fonts.ready)
}
const setWorking = (page: Page) =>
  fake(page, (t) => {
    t.store.setState({
      ...t.store.getState(),
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    })
    t.session.patch({ busy: true, turn_id: 'turn_7' })
  })
const setIdle = (page: Page) =>
  fake(page, (t) => {
    t.store.setState({ ...t.store.getState(), statuses: {} })
    t.session.patch({ busy: false, turn_id: undefined })
  })
const gap = (page: Page) =>
  page.getByTestId('timeline').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
/**
 * A message row fully inside the timeline's view, and where it sits: its top edge's distance from the timeline's top. That
 * distance is what the owner sees. scrollTop alone is not: when content above the view changes height (late web fonts, say),
 * the browser moves scrollTop to keep the same words in place (scroll anchoring) and nothing on screen moves.
 */
const pinRow = (page: Page) =>
  page.getByTestId('timeline').evaluate((el) => {
    const box = el.getBoundingClientRect()
    const row = [...el.querySelectorAll<HTMLElement>('[data-msg-id]')].find((n) => {
      const r = n.getBoundingClientRect()
      return r.top >= box.top + 40 && r.bottom <= box.bottom - 40
    })
    if (!row) throw new Error('no message row fully in view')
    return row.dataset.msgId as string
  })
const rowY = (page: Page, id: string) =>
  page
    .getByTestId('timeline')
    .evaluate(
      (el, msgId) =>
        (el.querySelector(`[data-msg-id="${msgId}"]`) as HTMLElement).getBoundingClientRect().top -
        el.getBoundingClientRect().top,
      id,
    )
/**
 * STOPLINE_DIAG=1 (test-only, temporary: FOLLOWUPS, remove by 2026-11-28): log every scroll, resize and DOM change in the
 * timeline from now on, printed when the check after it fails, so a failure on a loaded CI machine explains itself.
 */
const diagStart = async (page: Page) => {
  if (!process.env.STOPLINE_DIAG) return
  await page.getByTestId('timeline').evaluate((el) => {
    const w = window as unknown as { __diag: string[] }
    const log: string[] = []
    w.__diag = log
    const t0 = performance.now()
    const at = () => `${Math.round(performance.now() - t0)}ms`
    let last = el.scrollTop
    log.push(`${at()} start top=${el.scrollTop} h=${el.scrollHeight} ch=${el.clientHeight}`)
    el.addEventListener('scroll', () => {
      log.push(`${at()} scroll ${last}->${el.scrollTop} h=${el.scrollHeight} ch=${el.clientHeight}`)
      last = el.scrollTop
    })
    new ResizeObserver(() => log.push(`${at()} resize ch=${el.clientHeight} top=${el.scrollTop}`)).observe(el)
    new MutationObserver((ms) => {
      for (const m of ms) {
        const t = m.target as HTMLElement
        const d = (n: Node) => (n as HTMLElement).outerHTML?.slice(0, 90) ?? n.textContent?.slice(0, 40)
        log.push(
          `${at()} ${m.type} ${t.getAttribute?.('data-testid') ?? t.tagName} +[${[...m.addedNodes].map(d).join('|')}] -[${[...m.removedNodes].map(d).join('|')}] top=${el.scrollTop} h=${el.scrollHeight}`,
        )
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    })
  })
}
const diagLog = async (page: Page) =>
  process.env.STOPLINE_DIAG
    ? `\n${await page.evaluate(() => (window as unknown as { __diag?: string[] }).__diag?.join('\n') ?? '')}`
    : ''
const box = async (loc: ReturnType<Page['locator']>) => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

test('the line sits under the newest message with Stop, in the thread scroll area', async ({ page }) => {
  await open(page, 30)
  await setWorking(page)
  await expect(line(page)).toBeVisible()
  await expect(line(page)).toContainText('is working…')
  await expect(page.getByTestId('timeline').getByTestId('stop-line')).toHaveCount(1)
  const stop = stopButton(page)
  await expect(stop).toHaveText('Stop')
  await expect(stop).toBeEnabled()
  // it follows the last row, after the end of the thread
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  const last = await box(page.locator('[data-msg-id="m_line_29"]'))
  const l = await box(line(page))
  expect(l.y, 'the line is not below the last message').toBeGreaterThanOrEqual(last.y + last.height - 1)
  // the pill is not red, at least 36 px tall, with a 44 px hit area
  const s = await box(stop)
  expect(s.height).toBeGreaterThanOrEqual(36)
  const hit = await stop.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { w: r.width, h: r.height }
  })
  expect(hit.h).toBeGreaterThanOrEqual(44)
  expect(hit.w).toBeGreaterThanOrEqual(44)
  const colours = await stop.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { border: cs.borderTopColor, text: cs.color }
  })
  const danger = await page.evaluate(() => {
    const p = document.createElement('p')
    p.style.color = 'var(--danger)'
    document.body.append(p)
    const c = getComputedStyle(p).color
    p.remove()
    return c
  })
  expect(colours.border).not.toBe(danger)
  expect(colours.text).not.toBe(danger)
})

test('on a 320 px screen the line fits with no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await open(page, 30)
  await setWorking(page)
  await expect(stopButton(page)).toBeVisible()
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(over).toBeLessThanOrEqual(0)
  const tl = await page.getByTestId('timeline').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(tl).toBeLessThanOrEqual(0)
  const l = await box(line(page))
  const s = await box(stopButton(page))
  expect(l.x).toBeGreaterThanOrEqual(-0.5)
  expect(s.x + s.width).toBeLessThanOrEqual(320.5)
})

test('axe is clean in light and dark, with the line and with the strip', async ({ page }) => {
  await open(page, 30)
  await setWorking(page)
  await expect(stopButton(page)).toBeVisible()
  await expectAxeClean(page, ['[data-testid="stop-line"]'])
  await stopButton(page).click()
  await expect(page.getByTestId('stopped-strip')).toBeVisible()
  await expectAxeClean(page, ['[data-testid="stopped-strip"]', '[data-testid="stop-line"]'])
})

test('there is no Stop in the composer, and Send is still there', async ({ page }) => {
  await open(page, 30)
  await setWorking(page)
  await expect(stopButton(page)).toBeVisible()
  const composer = page.getByTestId('composer')
  await expect(composer.getByRole('button', { name: /stop/i })).toHaveCount(0)
  await expect(page.getByTestId('composer-stop')).toHaveCount(0)
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(composer.getByRole('button', { name: 'Attach', exact: true })).toBeVisible()
})

test('a tap on Stop sends one stop control', async ({ page }) => {
  await open(page, 30)
  await setWorking(page)
  await stopButton(page).click()
  await expect.poll(() => stops(page)).toBe(1)
  await page.waitForTimeout(300)
  expect(await stops(page)).toBe(1)
})

test('after a stop the strip shows, and Undo sends the last owner message again, once', async ({ page }) => {
  await open(page, 30)
  await setWorking(page)
  await stopButton(page).click()
  const strip = page.getByTestId('stopped-strip')
  await expect(strip).toBeVisible()
  // no live role of its own (it appears already filled, which a screen reader skips): the announcer says it
  await expect(strip).not.toHaveAttribute('role', 'status')
  await expect(strip).toContainText('Your message is kept.')
  // above the message box, inside 320 px
  const sb = await box(strip)
  const cb = await box(page.getByTestId('composer'))
  expect(sb.y + sb.height).toBeLessThanOrEqual(cb.y + 1)
  const undo = strip.getByRole('button', { name: 'Undo' })
  await undo.click()
  await expect.poll(async () => (await sentMessages(page)).length).toBe(1)
  expect((await sentMessages(page))[0]).toEqual({ text: 'finish the report', thread: 'general' })
  await expect(strip).toHaveCount(0)
  await page.waitForTimeout(300)
  expect((await sentMessages(page)).length).toBe(1)
})

test('with the keyboard: Enter on Stop moves focus to Undo, and to the message box when the strip goes', async ({
  page,
}) => {
  await open(page, 30)
  await setWorking(page)
  await stopButton(page).focus()
  await page.keyboard.press('Enter')
  const undo = page.getByTestId('stopped-strip').getByRole('button', { name: 'Undo' })
  await expect(undo).toBeFocused()
  await expect(page.getByTestId('stopped-strip')).toHaveCount(0, { timeout: 12_000 })
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
})

test('an old owner message is not offered for Undo', async ({ page }) => {
  await open(page, 30)
  await fake(page, (t) => {
    const st = t.store.getState() as unknown as { messages: Record<string, Array<Record<string, unknown>>> }
    const list = (st.messages.general ?? []).map((m) =>
      m.id === 'm_line_29' ? { ...m, created_at: new Date(Date.now() - 600_000).toISOString() } : m,
    )
    t.store.setState({ ...st, messages: { ...st.messages, general: list } })
  })
  await setWorking(page)
  await stopButton(page).click()
  const strip = page.getByTestId('stopped-strip')
  await expect(strip).toHaveText(/^Stopped .*\.$/)
  await expect(strip).not.toContainText('Your message is kept')
  await expect(strip.getByRole('button', { name: 'Undo' })).toHaveCount(0)
})

test('the strip fits 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await open(page, 30)
  await setWorking(page)
  await stopButton(page).click()
  const strip = page.getByTestId('stopped-strip')
  await expect(strip).toBeVisible()
  const b = await box(strip)
  expect(b.x).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(320.5)
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(over).toBeLessThanOrEqual(0)
})

test('at the end of the thread the view stays at the end when the line appears and goes', async ({ page }) => {
  await open(page, 30)
  const tl = page.getByTestId('timeline')
  await tl.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await setWorking(page)
  await expect(line(page)).toBeVisible()
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await expect(line(page)).toBeInViewport()
  await setIdle(page)
  await expect(line(page)).toHaveCount(0)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
})

test('scrolled up, the line appearing and going does not move the view', async ({ page }) => {
  await open(page, 30)
  const tl = page.getByTestId('timeline')
  await tl.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 600)
  })
  await expect(page.getByTestId('jump-to-latest')).toBeVisible()
  const top = await tl.evaluate((el) => el.scrollTop)
  expect(top).toBeGreaterThan(0)
  // What must not move is what the owner sees: a row in view stays at the same place on screen (1 px). scrollTop is printed
  // with a failure, not checked: the browser may change it to keep the view still (CI under a load of ~50, 22 px, 2026-11-21).
  const pin = await pinRow(page)
  const y0 = await rowY(page, pin)
  const still = async (when: string) => {
    const y = await rowY(page, pin)
    const dTop = (await tl.evaluate((el) => el.scrollTop)) - top
    expect(
      Math.abs(y - y0),
      `${when}: row ${pin} moved from ${y0} to ${y} px on screen (scrollTop ${dTop >= 0 ? '+' : ''}${dTop})${await diagLog(page)}`,
    ).toBeLessThanOrEqual(1)
  }
  await diagStart(page)
  await setWorking(page)
  await expect(line(page)).toHaveCount(1)
  // The line and the live region after it are never the browser's scroll anchor: under load on macOS 26 WebKit the line's
  // coming moved this view 22 px with no script write (CI on db37abb6). Rows keep their anchoring.
  const anchors = await tl.evaluate((el) =>
    [el.querySelector('[data-testid="stop-line"]'), el.querySelector('[role="log"]')].map((n) =>
      n ? getComputedStyle(n).overflowAnchor : 'missing',
    ),
  )
  expect(anchors).toEqual(['none', 'none'])
  await page.waitForTimeout(400)
  await still('after the line came')
  await setIdle(page)
  await expect(line(page)).toHaveCount(0)
  await page.waitForTimeout(400)
  await still('after the line went')
})
