// A send must never stop the agent. While the agent works, Stop sits just left of Send. Send used to go when the box emptied,
// and Stop slid into the spot where Send was, so a second press of one Send (a double tap, a touch registered twice, a quick
// re-tap) could land on Stop and end the turn the owner was adding to (sendGuard.ts guarded it). Since 2026-11-20 Send stays
// in its place, dimmed: a second press lands on it and does nothing. Every project.
import { expect, type Page, test } from '@playwright/test'
import { SEND_GUARD_MS } from '../../src/features/composer/sendGuard.ts'

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
  await expect(page.getByTestId('composer-stop')).toBeVisible()
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
    // Send is still in its spot, dimmed: the second press reaches it, not Stop
    const at = await page.evaluate(
      ([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label'),
      [x, y],
    )
    expect(at).toBe('Send')
    await expect(send(page)).toHaveAttribute('aria-disabled', 'true')
    await pressAt(page, isMobile, x, y)
    await page.waitForTimeout(300)
    expect(await stops(page)).toBe(0)
    expect(await messages(page)).toBe(1)
    await expect(box(page)).toHaveValue('')
  })
}

test('Stop, pressed on its own spot once the moment after the send is over, stops the turn', async ({
  page,
  isMobile,
}) => {
  const [x, y] = await working(page)
  await pressAt(page, isMobile, x, y)
  await page.waitForTimeout(SEND_GUARD_MS + 300)
  const b = await page.getByTestId('composer-stop').boundingBox()
  if (!b) throw new Error('no Stop')
  await pressAt(page, isMobile, b.x + b.width / 2, b.y + b.height / 2)
  await expect.poll(() => stops(page)).toBe(1)
})

test('Enter or Space twice on Send from the keyboard does not stop the agent', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone has no Tab to Send')
  await working(page)
  await send(page).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await page.waitForTimeout(300)
  expect(await stops(page)).toBe(0)
})
