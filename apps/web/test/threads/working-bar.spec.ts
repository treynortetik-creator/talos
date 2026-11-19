// The working indicator in the real app (fake mode), on phones, in both themes: a thin line on the message box that takes
// no layout height at all, Stop in the message box's buttons, and the floating buttons never on the newest message.
import { expect, type Locator, type Page, test } from '@playwright/test'

// The service worker stamps a strict style CSP on precached HTML; the harness may need to inject CSS (see call-error.spec.ts).
test.use({ bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  store: { setState(p: unknown): void; getState(): { statuses: Record<string, unknown> } }
  session: { patch(p: Record<string, unknown>): void }
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>

const tabReachesButtons = (project: string) => project !== 'iphone'

async function open(page: Page) {
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await expect(page.getByTestId('composer')).toBeVisible()
}
async function setWorking(page: Page) {
  await fake(page, (t) => {
    t.store.setState({
      ...t.store.getState(),
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    })
    t.session.patch({ busy: true, turn_id: 'turn_7' })
  })
  await expect(page.getByTestId('composer-stop')).toBeVisible()
}
const box = async (loc: Locator) => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const sizes = [
  { name: 'phone', viewport: null },
  { name: '320px phone', viewport: { width: 320, height: 568 } },
] as const

for (const size of sizes) {
  test.describe(size.name, () => {
    if (size.viewport) test.use({ viewport: size.viewport })
    // 'phone' takes the project's own device: the desktop project renders the desktop layout (no bug button in a thread,
    // the message box a column), which these phone checks do not describe. The 320 px block sets a phone viewport everywhere.
    if (!size.viewport) test.skip(({ isMobile }) => !isMobile, 'phone layout only')

    for (const colorScheme of ['light', 'dark'] as const) {
      test.describe(colorScheme, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme })
        })

        test('the bar takes no height, the timeline does not shrink, and the line sits on the message box edge', async ({
          page,
        }) => {
          await open(page)
          const before = await box(page.getByTestId('timeline'))
          await setWorking(page)
          const row = page.getByTestId('working-row')
          await expect(row).toHaveAttribute('role', 'status')
          expect((await box(row)).height).toBeLessThanOrEqual(0.5)
          const after = await box(page.getByTestId('timeline'))
          expect(after.height, 'the timeline gave up room for the bar').toBeCloseTo(before.height, 0)

          const line = page.getByTestId('working-line')
          await expect(line).toBeVisible()
          const l = await box(line)
          const vp = await page.evaluate(() => window.innerWidth)
          expect(l.x).toBeLessThanOrEqual(0.5)
          expect(l.x + l.width).toBeGreaterThanOrEqual(vp - 0.5)
          expect(l.height).toBeLessThanOrEqual(4)
          const c = await box(page.getByTestId('composer'))
          expect(Math.abs(l.y + l.height - c.y), 'the line is not on the message box edge').toBeLessThanOrEqual(4)
          // it never takes a tap
          expect(await line.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
          // screen readers still hear it
          await expect(row).toContainText('is working')
        })

        test('Stop is in the message box, nothing covers it, and it sends a stop', async ({ page }, info) => {
          await open(page)
          await setWorking(page)
          const stop = page.getByTestId('composer-stop')
          await expect(stop).toBeEnabled()
          await expect(page.getByTestId('composer').getByRole('button', { name: 'Stop' })).toBeVisible()
          const s = await box(stop)
          const c = await box(page.getByTestId('composer'))
          expect(s.y).toBeGreaterThanOrEqual(c.y)
          expect(s.y + s.height).toBeLessThanOrEqual(c.y + c.height + 0.5)
          const top = await stop.evaluate((el) => {
            const b = el.getBoundingClientRect()
            // the icon inside the button counts as the button itself
            const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
            return hit !== null && el.contains(hit)
          })
          expect(top, 'something covers Stop').toBe(true)
          if (tabReachesButtons(info.project.name)) {
            await page.locator('.composer-box').focus()
            let reached = false
            for (let i = 0; i < 12 && !reached; i++) {
              await page.keyboard.press('Tab')
              reached = await stop.evaluate((el) => el === document.activeElement)
            }
            expect(reached, 'Tab never reached Stop').toBe(true)
          }
          await stop.click()
          await expect.poll(() => fake(page, (t) => t.sent.filter((f) => f.action === 'stop').length)).toBe(1)
        })

        test('the bug button (in the message box) and jump-to-latest, when shown, stay off the newest message at the bottom', async ({
          page,
        }) => {
          await open(page)
          await setWorking(page)
          // enough rows that the timeline scrolls and its end is the newest message
          await fake(page, (t) => {
            const st = t.store.getState() as unknown as { messages: Record<string, unknown[]> }
            const list = Array.from({ length: 30 }, (_, i) => ({
              id: `m_bar_${i}`,
              thread_id: 'general',
              author: i % 2 ? 'owner' : 'agent',
              kind: 'text',
              text: `Row number ${i}`,
              format: 'plain',
              attachments: [],
              via: 'app',
              seq: 1000 + i,
              created_at: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
            }))
            t.store.setState({ ...st, messages: { ...st.messages, general: list } })
          })
          const timeline = page.getByTestId('timeline')
          await expect(timeline.locator('[data-msg-id="m_bar_29"]')).toHaveCount(1)
          expect(await timeline.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
          await timeline.evaluate((el) => {
            el.scrollTop = el.scrollHeight
          })
          const last = timeline.locator('[data-msg-id], [data-testid="timeline-card"]').last()
          await expect(last).toBeVisible()
          const bug = page.getByTestId('thread-screen').getByTestId('bug-button')
          await expect(bug).toBeVisible()
          const lastBox = await box(last)
          expect(overlaps(await box(bug), lastBox), 'bug button on the newest message').toBe(false)
          const jump = page.getByTestId('jump-to-latest')
          if (await jump.isVisible()) expect(overlaps(await box(jump), lastBox)).toBe(false)
        })
      })
    }
  })
}

test('with reduced motion the line is still, and full width', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  await setWorking(page)
  const line = page.getByTestId('working-line')
  await expect(line).toBeVisible()
  const running = await line.evaluate((el) => el.getAnimations({ subtree: true }).length)
  expect(running, 'an animation is running under reduced motion').toBe(0)
  const l = await box(line)
  const seg = await box(line.locator('[data-testid="working-line-fill"]'))
  expect(seg.width).toBeGreaterThanOrEqual(l.width - 1)
})

test('with motion allowed the line animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await open(page)
  await setWorking(page)
  const line = page.getByTestId('working-line')
  await expect(line).toBeVisible()
  expect(await line.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
})
