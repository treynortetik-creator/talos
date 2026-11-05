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
      expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
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
      await expect(r.getByTestId('run-status')).toHaveText(/^Sent to your Mac/)
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

    test('failed: the error and Try again', async ({ page }, info) => {
      await open(page)
      await page.evaluate(() => {
        window.__talos.sendMessage = () => Promise.reject(new Error('no'))
      })
      const r = row(page, 1)
      await r.scrollIntoViewIfNeeded()
      await r.getByTestId('run-button').click()
      await expect(r.getByRole('alert')).toContainText("Couldn't send")
      await expect(r.getByTestId('run-button')).toHaveText('Try again')
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

    test('a long script wraps whole, never scrolls sideways, and asks twice', async ({ page }, info) => {
      await open(page)
      const r = row(page, 4)
      await r.scrollIntoViewIfNeeded()
      const pre = r.locator('pre')
      await expect(pre).toHaveClass(/run-block/)
      await expect(r.getByTestId('run-note')).toContainText('longer than 6 lines')
      const fits = await pre.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)
      expect(fits).toBe(true)
      expect(await noHorizontalScroll(page)).toBe(true)
      const sentBefore = await page.evaluate(() => window.__talos.sent.length)
      await r.getByTestId('run-button').click()
      await expect(r.getByTestId('run-confirm')).toBeVisible()
      expect(await page.evaluate(() => window.__talos.sent.length)).toBe(sentBefore)
      await r.screenshot({ path: info.outputPath(`run-long-${colorScheme}.png`) })
    })

    test('the second confirm puts Cancel where Run was and Yes beside it, never under it', async ({ page }) => {
      await open(page)
      const r = row(page, 2)
      await r.scrollIntoViewIfNeeded()
      const run = (await r.getByTestId('run-button').boundingBox()) as { x: number; width: number }
      await r.getByTestId('run-button').click()
      const yes = (await r.getByTestId('run-confirm').boundingBox()) as { x: number }
      expect(yes.x).toBeGreaterThanOrEqual(run.x + run.width)
    })

    test('accessible', async ({ page }) => {
      await open(page)
      const results = await new AxeBuilder({ page }).include('[data-testid="msg-agent"]').analyze()
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    })
  })
}
