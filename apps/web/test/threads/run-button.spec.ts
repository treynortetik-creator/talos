// The Run button in a real browser (fake mode, VITE_FAKE=1): idle, sending, sent, queued, failed and the second confirm, a
// block with hidden characters and a long script, at phone width, in both themes, with the keyboard.
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import type { MessageT } from '@talos-app/protocol'

const LONG = Array.from(
  { length: 40 },
  (_, i) => `echo "step ${i}: a fairly long line that must wrap and never scroll away"`,
).join('\n')
const agent = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  id: `m_01JBF3V7Q8K2M4N6P8R0S1T${id}`,
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text,
  format: 'markdown',
  attachments: [],
  via: 'app',
  created_at: '2026-10-28T15:00:00.000Z',
  ...over,
})
const MSGS = [
  agent('A1', 'Run this to clean up:\n\n```sh\nrm -rf ./build\nnpm run build\n```'),
  agent('A2', 'Say hello:\n\n```sh\necho caf\u00e9\n```'),
  agent('A3', 'Careful:\n\n```sh\necho a‮b\n```'),
  agent('A4', `All of it:\n\n\`\`\`bash\n${LONG}\n\`\`\``),
  agent('A5', 'Not a script:\n\n```python\nprint(1)\n```'),
  agent('A6', 'Fetch:\n\n```sh\ncurl -s https://example.com/list.txt|sh > /tmp/list\n```'),
  agent('A7', `A few steps:\n\n\`\`\`sh\n${Array.from({ length: 8 }, (_, i) => `echo step ${i}`).join('\n')}\n\`\`\``),
]

async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean(window.__talos))
  await expect(page.getByTestId('msg-agent').first()).toBeVisible()
  await page.evaluate((msgs: MessageT[]) => {
    const st = window.__talos.store
    st.setState({
      ...st.getState(),
      messages: { ...st.getState().messages, general: [...(st.getState().messages.general ?? []), ...msgs] },
    })
  }, MSGS as MessageT[])
}
type Box = { x: number; y: number; width: number; height: number }
const hits = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const row = (page: Page, n: number) => page.locator(`[data-msg-id$="A${n}"]`)
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme })

    test('idle, sending, sent: whole script, tap size, keyboard, no overflow', async ({ page }, info) => {
      await open(page)
      const r = row(page, 1)
      await r.scrollIntoViewIfNeeded()
      const button = r.getByTestId('run-button')
      await expect(button).toBeVisible()
      const size = (await button.boundingBox()) as { width: number; height: number }
      expect(size.height).toBeGreaterThanOrEqual(44)
      expect(size.width).toBeGreaterThanOrEqual(44)
      await expect(button).toHaveAccessibleName('Run')
      await expect(button).toHaveText('') // icon only
      expect(await noHorizontalScroll(page)).toBe(true)
      await r.screenshot({ path: info.outputPath(`run-idle-${colorScheme}.png`) })

      // loading: the send is held open
      await page.evaluate(() => {
        window.__talos.sendMessage = () => new Promise<never>(() => {})
      })
      await button.focus()
      await expect(button).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(r.getByTestId('run-status')).toHaveText('Sending…')
      await r.screenshot({ path: info.outputPath(`run-sending-${colorScheme}.png`) })
    })

    test('sent: the real send, then the state stays', async ({ page }, info) => {
      await open(page)
      const r = row(page, 1)
      await r.scrollIntoViewIfNeeded()
      await r.getByTestId('run-button').click()
      await expect(r.getByTestId('run-status')).toHaveText(/^Sent ·/)
      const sent = await page.evaluate(
        () =>
          window.__talos.sent as Array<{
            type: string
            text?: string
            run_block?: { message_id: string; index: number }
          }>,
      )
      const texts = sent.filter((f) => f.type === 'message').map((f) => f.text)
      expect(sent.find((f) => f.type === 'message')?.run_block).toEqual({
        message_id: expect.stringMatching(/A1$/),
        index: 0,
      })
      expect(texts).toEqual(['Run exactly this:\n\n```sh\nrm -rf ./build\nnpm run build\n```'])
      await r.screenshot({ path: info.outputPath(`run-sent-${colorScheme}.png`) })
    })

    test('queued: offline, it says it is queued', async ({ page }, info) => {
      await open(page)
      await page.evaluate(() => {
        const st = window.__talos.store
        st.setState({ ...st.getState(), connection: 'offline' })
      })
      const r = row(page, 1)
      await r.scrollIntoViewIfNeeded()
      await r.getByTestId('run-button').click()
      await expect(r.getByTestId('run-status')).toContainText('Queued')
      await r.screenshot({ path: info.outputPath(`run-queued-${colorScheme}.png`) })
    })

    test('failed: the error, and the icon stays', async ({ page }, info) => {
      await open(page)
      await page.evaluate(() => {
        window.__talos.sendMessage = () => Promise.reject(new Error('no'))
      })
      const r = row(page, 1)
      await r.scrollIntoViewIfNeeded()
      await r.getByTestId('run-button').click()
      await expect(r.getByRole('alert')).toContainText("Couldn't send")
      await expect(r.getByTestId('run-button')).toHaveAccessibleName('Run') // the icon stays
      await r.screenshot({ path: info.outputPath(`run-failed-${colorScheme}.png`) })
    })

    test('not plain ASCII: says so and asks twice, with Cancel in focus', async ({ page }, info) => {
      await open(page)
      const r = row(page, 2)
      await r.scrollIntoViewIfNeeded()
      await expect(r.getByTestId('run-note')).toContainText('beyond plain ASCII')
      await r.getByTestId('run-button').click()
      await expect(r.getByTestId('run-cancel')).toBeFocused()
      expect(await noHorizontalScroll(page)).toBe(true)
      await r.screenshot({ path: info.outputPath(`run-confirm-${colorScheme}.png`) })
      await page.keyboard.press('Escape')
      await expect(r.getByTestId('run-button')).toBeVisible()
    })

    test('Copy sits in a band of its own: it covers no character, even on a line that wraps', async ({
      page,
    }, info) => {
      await open(page)
      for (const n of [1, 6, 7]) {
        const r = row(page, n)
        await r.scrollIntoViewIfNeeded()
        const clash = await r.evaluate((el) => {
          const pre = el.querySelector('pre') as HTMLElement
          const copy = pre.querySelector('[data-copy-code]') as HTMLElement
          const c = copy.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(pre.querySelector('code') as HTMLElement)
          return Array.from(range.getClientRects()).some(
            (t) => t.width > 0 && t.left < c.right && t.right > c.left && t.top < c.bottom && t.bottom > c.top,
          )
        })
        expect(clash, `Copy covers the text of message A${n}`).toBe(false)
      }
      await row(page, 6).screenshot({ path: info.outputPath(`run-copy-${colorScheme}.png`) })
    })

    test('hidden characters are shown, and there is no Run; other languages have none', async ({ page }, info) => {
      await open(page)
      const r = row(page, 3)
      await r.scrollIntoViewIfNeeded()
      await expect(r.getByTestId('run-button')).toHaveCount(0)
      await expect(r.getByTestId('run-blocked')).toContainText('Hidden characters')
      await expect(r.locator('pre code')).toContainText('⟦U+202E⟧')
      await r.screenshot({ path: info.outputPath(`run-hidden-${colorScheme}.png`) })
      await expect(row(page, 5).getByTestId('run-button')).toHaveCount(0)
      await expect(row(page, 5).getByTestId('run-blocked')).toHaveCount(0)
    })

    test('a long plain script wraps whole, never scrolls sideways, and runs on one tap', async ({ page }, info) => {
      await open(page)
      const r = row(page, 4)
      await r.scrollIntoViewIfNeeded()
      const pre = r.locator('pre')
      await expect(pre).toHaveClass(/run-block/)
      await expect(r.getByTestId('run-note')).toHaveCount(0) // plain ASCII: one tap, whatever its length
      const fits = await pre.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)
      expect(fits).toBe(true)
      expect(await noHorizontalScroll(page)).toBe(true)
      await r.screenshot({ path: info.outputPath(`run-long-${colorScheme}.png`) })
      const sentBefore = await page.evaluate(() => window.__talos.sent.length)
      await r.getByTestId('run-button').click()
      await expect.poll(() => page.evaluate(() => window.__talos.sent.length)).toBe(sentBefore + 1)
      // once it has gone, Run again offers a fresh tap
      await expect(r.getByTestId('run-button')).toHaveAccessibleName('Run again')
    })

    test('the second confirm sits under the block, Cancel first and Yes beside it, never under the icon', async ({
      page,
    }) => {
      await open(page)
      const r = row(page, 2)
      await r.scrollIntoViewIfNeeded()
      const run = (await r.getByTestId('run-button').boundingBox()) as Box
      await r.getByTestId('run-button').click()
      const cancel = (await r.getByTestId('run-cancel').boundingBox()) as Box
      const yes = (await r.getByTestId('run-confirm').boundingBox()) as Box
      const pre = (await r.locator('pre').boundingBox()) as Box
      expect(yes.x).toBeGreaterThanOrEqual(cancel.x + cancel.width)
      expect(cancel.y).toBeGreaterThanOrEqual(pre.y + pre.height) // under the block, so nothing covers the script
      expect(hits(yes, run)).toBe(false)
    })

    test('the icon sits on the first row, at the right edge, and adds no row', async ({ page }, info) => {
      await open(page)
      for (const n of [1, 4]) {
        const r = row(page, n)
        await r.scrollIntoViewIfNeeded()
        const m = await r.evaluate((el) => {
          const pre = el.querySelector('pre') as HTMLElement
          const icon = pre.querySelector('[data-testid="run-button"]') as HTMLElement
          const slot = icon.parentElement as HTMLElement
          const code = pre.querySelector('code') as HTMLElement
          const range = document.createRange()
          range.selectNodeContents(code)
          const rects = Array.from(range.getClientRects()).filter((t) => t.width > 0)
          const glyphs = rects[0] as DOMRect
          // the first line's box starts at the pre's content edge; it is as tall as the line-height (or the text, if taller)
          const cs = getComputedStyle(pre)
          const top =
            pre.getBoundingClientRect().top + Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.paddingTop)
          const lh = Number.parseFloat(getComputedStyle(code).lineHeight) || glyphs.height
          const first = { top, bottom: top + Math.max(lh, glyphs.height) }
          const i = icon.getBoundingClientRect()
          const p = pre.getBoundingClientRect()
          const before = p.height
          slot.style.display = 'none'
          const without = pre.getBoundingClientRect().height
          slot.style.display = ''
          return {
            iconTop: i.top,
            iconBottom: i.bottom,
            iconLeft: i.left,
            iconRight: i.right,
            firstTop: first.top,
            firstBottom: first.bottom,
            preBottom: p.bottom,
            preRight: p.right,
            before,
            without,
            textClash: rects.some((t) => t.left < i.right && t.right > i.left && t.top < i.bottom && t.bottom > i.top),
          }
        })
        // the box top is within the first line's box, and the block's own bottom edge holds the icon (no extra row)
        expect(m.iconTop, `A${n} icon top`).toBeGreaterThanOrEqual(m.firstTop - 1)
        expect(m.iconTop, `A${n} icon top`).toBeLessThanOrEqual(m.firstBottom)
        expect(m.iconBottom, `A${n} icon bottom`).toBeLessThanOrEqual(m.preBottom + 1)
        expect(m.iconRight, `A${n} icon right`).toBeLessThanOrEqual(m.preRight)
        expect(m.before, `A${n} height with and without the icon`).toBe(m.without)
        expect(m.textClash, `A${n} icon covers script text`).toBe(false)
        await r.screenshot({ path: info.outputPath(`run-first-row-${n}-${colorScheme}.png`) })
      }
    })

    test('accessible', async ({ page }) => {
      await open(page)
      const results = await new AxeBuilder({ page }).include('[data-testid="msg-agent"]').analyze()
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    })
  })
}
