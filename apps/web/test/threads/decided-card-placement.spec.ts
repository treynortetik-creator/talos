import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

// A card the owner acted on sits where the action happened, in the right day group, never under newer messages. A card
// that still needs the owner stays at the bottom and can be reached from the keyboard. Runs at phone width (iphone,
// pixel) and on the desktop project.
type Win = { __talos: { store: { getState: () => any; setState: (s: any) => void } } }

async function seed(page: Page, o: { waitingYesterday?: boolean } = {}) {
  // The fake-mode app's own seed holds one pending card that expires on 2026-10-29; pin "now" inside its life.
  await page.clock.install({ time: new Date('2026-10-28T16:00:00.000Z') })
  await page.goto('/threads')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate((waitingYesterday) => {
    const store = (window as unknown as Win).__talos.store
    const s = store.getState()
    const now = Date.now()
    const yesterday = (h: number, m: number) => {
      const d = new Date(now)
      d.setDate(d.getDate() - 1)
      d.setHours(h, m, 0, 0)
      return d.toISOString()
    }
    const msg = (id: string, seq: number, text: string, at: string) => ({
      id,
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'app',
      seq,
      created_at: at,
    })
    const waiting = s.cards.find((c: any) => c.state === 'pending' && c.thread_id === 'general')
    const base = waiting
    const clone = (id: string, title: string, over: object) => ({ ...base, id, title, ...over })
    const res = (action: string, at: string) => ({ action, at, edited: false, payload_hash: 'sha256:x' })
    const cards = [
      // the owner's report: revised yesterday evening, never closed by the Mac
      clone('c_01JBF3V7Q8K2M4N6P8R0S90001', 'Upload a TestFlight build', {
        state: 'resolved',
        created_at: yesterday(19, 0),
        resolution: res('revise', yesterday(19, 27)),
      }),
      clone('c_01JBF3V7Q8K2M4N6P8R0S90002', 'Delete the old branch', {
        state: 'resolved',
        created_at: yesterday(20, 0),
        resolution: res('kill', yesterday(20, 15)),
      }),
      clone('c_01JBF3V7Q8K2M4N6P8R0S90003', 'Publish the notes', {
        state: 'resolved',
        created_at: yesterday(20, 30),
        resolution: res('primary', yesterday(20, 40)),
      }),
      // the seeded card that really needs the owner (created_at is not part of what the hash covers)
      waitingYesterday ? { ...waiting, created_at: yesterday(11, 0) } : waiting,
    ]
    store.setState({
      ...s,
      cards,
      messages: {
        ...s.messages,
        general: [
          msg('m_a', 1, 'Message from yesterday morning', yesterday(10, 0)),
          msg('m_b', 2, 'Message from yesterday late', yesterday(21, 0)),
          msg('m_c', 3, 'Newest message today', new Date(now - 60_000).toISOString()),
        ],
      },
    })
  }, o.waitingYesterday ?? false)
  await page.getByTestId('thread-row-general').click()
  await expect(page.getByTestId('thread-screen').locator('p', { hasText: /^Newest message today$/ })).toBeVisible()
}

const top = async (page: Page, locator: ReturnType<Page['locator']>) => (await locator.boundingBox())?.y ?? Number.NaN

test('decided cards sit by the time of the owner action, a waiting card stays last and is reachable by keyboard', async ({
  page,
}) => {
  await seed(page)
  const card = (n: number) =>
    page.locator(n === 4 ? '#card-c_01JBF3V7Q8K2M4N6P8R0S2T403' : `#card-c_01JBF3V7Q8K2M4N6P8R0S9000${n}`)
  // the sr-only live region repeats the newest message, so match the visible paragraph only
  const msg = (t: string) => page.getByTestId('thread-screen').locator('p', { hasText: new RegExp(`^${t}$`) })
  await expect(card(1)).toContainText('↻ Asked Talos to change it')
  await expect(card(2)).toContainText('✕ Killed')
  // the bug: the revised card sat under the newest message, below the composer's reach
  expect(await top(page, card(1))).toBeLessThan(await top(page, msg('Newest message today')))
  expect(await top(page, card(1))).toBeGreaterThan(await top(page, msg('Message from yesterday morning')))
  // order by the action time: revise 19:27 < kill 20:25 < approve 20:40 < message 21:00
  const ys = [
    await top(page, card(1)),
    await top(page, card(2)),
    await top(page, card(3)),
    await top(page, msg('Message from yesterday late')),
  ]
  expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  // the approved card waiting for its result is placed, not pinned, and says what it is doing
  await expect(card(3)).toContainText(/Working on it|No result reported yet/)
  // the day dividers: Yesterday sits above the revised card (its group is the day of the tap), Today above the newest message
  const divider = (label: RegExp) => page.getByTestId('thread-screen').getByText(label)
  const yesterday = await top(page, divider(/^yesterday$/i))
  const today = await top(page, divider(/^today$/i))
  expect(yesterday).toBeLessThan(await top(page, card(1)))
  expect(today).toBeGreaterThan(await top(page, msg('Message from yesterday late')))
  expect(today).toBeLessThan(await top(page, msg('Newest message today')))
  // the card that truly needs the owner is last, still has its buttons, and Tab reaches them
  const waiting = card(4)
  expect(await top(page, waiting)).toBeGreaterThan(await top(page, msg('Newest message today')))
  const send = waiting.getByRole('button', { name: /^Publish/ })
  await expect(send).toBeVisible()
  // WebKit's default skips buttons on a plain Tab (Safari's setting); Option+Tab is its keyboard route to them
  const nextKey = test.info().project.name === 'iphone' ? 'Alt+Tab' : 'Tab'
  let reached = false
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press(nextKey)
    reached = await send.evaluate((el) => el === document.activeElement)
  }
  expect(reached, 'Tab reaches the waiting card’s Send button').toBe(true)
  await page.screenshot({
    path: process.env.CARD_SHOT ? `${process.env.CARD_SHOT}-${test.info().project.name}.png` : undefined,
  })
})

test('the thread with decided cards is clean in light and dark', async ({ page }) => {
  await seed(page)
  await expectAxeClean(page)
})

test('a catch-up that replays the same cards moves nothing', async ({ page }) => {
  await seed(page)
  const before = await page.locator('[data-testid="timeline-card"]').evaluateAll((els) => els.map((e) => e.id))
  await page.evaluate(() => {
    const store = (window as unknown as Win).__talos.store
    // a catch-up replays the same cards: nothing may move
    store.setState({ ...store.getState(), cards: [...store.getState().cards] })
  })
  const after = await page.locator('[data-testid="timeline-card"]').evaluateAll((els) => els.map((e) => e.id))
  expect(after).toEqual(before)
  expect(before).toEqual([
    'card-c_01JBF3V7Q8K2M4N6P8R0S90001',
    'card-c_01JBF3V7Q8K2M4N6P8R0S90002',
    'card-c_01JBF3V7Q8K2M4N6P8R0S90003',
    'card-c_01JBF3V7Q8K2M4N6P8R0S2T403',
  ])
})

test('a waiting card created yesterday prints no Yesterday heading below Today', async ({ page }) => {
  await seed(page, { waitingYesterday: true })
  const divider = (label: RegExp) => page.getByTestId('thread-screen').getByText(label)
  await expect(divider(/^today$/i)).toHaveCount(1)
  await expect(divider(/^yesterday$/i)).toHaveCount(1)
  expect(await top(page, divider(/^yesterday$/i))).toBeLessThan(await top(page, divider(/^today$/i)))
  // and the waiting card is still the last thing in the thread
  const waiting = page.locator('#card-c_01JBF3V7Q8K2M4N6P8R0S2T403')
  expect(await top(page, waiting)).toBeGreaterThan(await top(page, divider(/^today$/i)))
})

test('a waiting card that expires while the thread is open moves up out of the bottom', async ({ page }) => {
  await seed(page)
  const waiting = page.locator('#card-c_01JBF3V7Q8K2M4N6P8R0S2T403')
  const newest = page.getByTestId('thread-screen').locator('p', { hasText: /^Newest message today$/ })
  expect(await top(page, waiting)).toBeGreaterThan(await top(page, newest))
  // the card's own expiry passes with the screen open: no frame arrives, only the clock moves
  await page.clock.fastForward('26:00:00')
  await expect(waiting).toContainText(/Expired/)
  expect(await top(page, waiting)).toBeLessThan(await top(page, newest))
})
