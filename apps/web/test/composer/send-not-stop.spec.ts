// A send can never stop the agent. Stop is not in the message box at all (the owner, 2026-11-20, Option B): the only Stop is
// the one on the working line under the newest message (stop-line.spec.ts). The box keeps + and Send, which stays in its
// place, dimmed with nothing to send. So a second press of Send (a double tap, a touch registered twice, Enter twice) sends one
// message and never a stop. Every project.
import { expect, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block', bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  store: { setState(p: unknown): void; getState(): { statuses: Record<string, unknown> } }
  session: { patch(p: Record<string, unknown>): void }
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const stops = (page: Page) => fake(page, (t) => t.sent.filter((f) => f.action === 'stop').length)
const box = (page: Page) => page.getByLabel('Message', { exact: true })
const send = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })
const messages = (page: Page) => fake(page, (t) => t.sent.filter((f) => f.type === 'message').length)

async function working(page: Page) {
  await page.goto('/t/general')
  await expect(page.getByTestId('composer')).toBeVisible()
  await fake(page, (t) => {
    t.store.setState({
      ...t.store.getState(),
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    })
    t.session.patch({ busy: true, turn_id: 'turn_7' })
  })
  // the working line's Stop is there, and nothing in the composer is a Stop
  await expect(page.getByRole('button', { name: 'Stop your agent', exact: true })).toBeVisible()
  await expect(page.getByTestId('composer').getByRole('button', { name: /stop/i })).toHaveCount(0)
  await expect(page.getByTestId('composer-stop')).toHaveCount(0)
  await box(page).fill('one more thing')
  const b = await send(page).boundingBox()
  if (!b) throw new Error('no Send')
  return [b.x + b.width / 2, b.y + b.height / 2] as const
}
async function pressAt(page: Page, isMobile: boolean, x: number, y: number) {
  if (isMobile) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

for (const gap of [0, 80, 200, 400]) {
  test(`a second press on Send's spot ${gap} ms after a send lands on the dimmed Send: one message, no stop`, async ({
    page,
    isMobile,
  }) => {
    const [x, y] = await working(page)
    await pressAt(page, isMobile, x, y)
    if (gap) await page.waitForTimeout(gap)
    const at = await page.evaluate(
      ([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label'),
      [x, y],
    )
    expect(at).toBe('Send')
    await expect(send(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('composer').getByRole('button', { name: /stop/i })).toHaveCount(0)
    await pressAt(page, isMobile, x, y)
    await page.waitForTimeout(300)
    expect(await stops(page)).toBe(0)
    expect(await messages(page)).toBe(1)
    await expect(box(page)).toHaveValue('')
  })
}

test('Enter or Space twice on Send from the keyboard sends one message and does not stop the agent', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'a phone has no Tab to Send')
  await working(page)
  await send(page).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await page.waitForTimeout(300)
  expect(await stops(page)).toBe(0)
  expect(await messages(page)).toBe(1)
})

test('Enter twice in the box sends one message and never a stop (on a phone Enter is a newline: no message, no stop)', async ({
  page,
  isMobile,
}) => {
  await working(page)
  await box(page).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  expect(await stops(page)).toBe(0)
  expect(await messages(page)).toBe(isMobile ? 0 : 1)
})
