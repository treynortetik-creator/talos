// The question sheet ("<label> wants to send:" / "wants to go full screen") is fixed to the viewport and modal, so nothing
// behind it can slide a button under the owner's finger. These specs play the attacks that used to work against an
// inline chip (a view below resizing, a new reply arriving, a view scrolling itself) and check that Send does not move
// and that a tap at the old spot sends nothing. The page clock is frozen while the sheet is young so "within 600 ms" is
// exact, not a race. Runs on the iphone, pixel and desktop projects.
import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'
import { probeView, relayAcceptsAppRequests } from './probe.ts'

const PIZZA = 'Order 40 pizzas to 12 Elm St'
const frameOf = (page: Page, title: string) => page.frameLocator(`iframe[title="${title}"]`)
const logOf = (page: Page, title: string) => frameOf(page, title).locator('#log')
const requests = (harness: Harness) => harness.appFrames().filter((f) => f.raw.type === 'app.request')
const messages = (harness: Harness) => requests(harness).filter((f) => f.raw.method === 'ui/message')
const tell = (page: Page, title: string, msg: Record<string, unknown>) =>
  page
    .locator(`iframe[title="${title}"]`)
    .evaluate((el, m) => (el as HTMLIFrameElement).contentWindow?.postMessage(m, '*'), msg)
const frameHeight = (page: Page, title: string) =>
  page.locator(`iframe[title="${title}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().height))
type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

/** Stops the page clock where it is: timers (the 600 ms arm) and animation frames wait for `advance`. */
async function freeze(page: Page) {
  // The page clock keeps running under `install`, so on a loaded machine the target can already be behind it by the time
  // pauseAt runs. Read the page's own time and retry with a wider margin until the target is ahead.
  let lastError: unknown
  for (const margin of [50, 200, 800, 3200]) {
    const now = await page.evaluate(() => Date.now())
    try {
      await page.clock.pauseAt(now + margin)
      return
    } catch (e) {
      if (!String(e).includes('Cannot fast-forward to the past')) throw e
      lastError = e
    }
  }
  throw lastError
}
const advance = (page: Page, ms: number) => page.clock.runFor(ms)

async function views(harness: Harness, page: Page, context: Parameters<typeof openSignedIn>[2], labels: string[]) {
  await page.clock.install()
  await relayAcceptsAppRequests(harness)
  const dev = await openSignedIn(harness, page, context)
  const probes = labels.map((label) => probeView(harness, { label, hostile: 1 }))
  for (const p of probes) p.send()
  for (const label of labels)
    await expect(logOf(page, `${label} (app)`)).toContainText('in:ui/notifications/tool-result')
  return { dev, probes }
}

for (const attack of [
  'a view below resizing 600 to 150',
  'a new agent reply while stuck to the bottom',
  'the view scrolling itself',
]) {
  test(`attack: ${attack}; Send does not move and a tap at the old spot within 600 ms sends nothing`, async ({
    page,
    context,
    harness,
  }) => {
    await views(harness, page, context, ['Asker', 'Below'])
    await tell(page, 'Below (app)', { cmd: 'height', h: 600 })
    await advance(page, 100)
    await expect.poll(() => frameHeight(page, 'Below (app)')).toBeGreaterThan(300) // 600 asked; a phone caps it lower
    await page.getByTestId('app-view').last().scrollIntoViewIfNeeded()
    await freeze(page)
    await tell(page, 'Asker (app)', { cmd: 'ask', text: PIZZA })
    const send = page.getByTestId('app-message-send')
    await expect(send).toBeVisible()
    await expect(send).toHaveAttribute('data-armed', 'false')
    await expect(send).toBeInViewport({ ratio: 1 })
    const before = (await send.boundingBox()) as Box

    if (attack.startsWith('a view below')) await tell(page, 'Below (app)', { cmd: 'height', h: 150 })
    else if (attack.startsWith('a new agent'))
      harness.relay.sendToApps(agentReply({ text: 'Another reply from the agent' }))
    else {
      await tell(page, 'Asker (app)', { cmd: 'scrollIntoView', id: 'inp', block: 'end' })
      await tell(page, 'Below (app)', { cmd: 'scrollIntoView', id: 'log', block: 'start' })
    }
    await advance(page, 100)
    if (attack.startsWith('a view below')) await expect.poll(() => frameHeight(page, 'Below (app)')).toBeLessThan(200)
    if (attack.startsWith('a new agent'))
      await expect(page.getByText('Another reply from the agent').first()).toBeVisible()

    const after = (await send.boundingBox()) as Box
    expect({ x: Math.round(after.x), y: Math.round(after.y) }).toEqual({
      x: Math.round(before.x),
      y: Math.round(before.y),
    })
    await page.mouse.click(centre(before).x, centre(before).y) // 100 ms in: the button is still dead
    expect(messages(harness)).toEqual([])
    await expect(page.getByTestId('app-message-chip')).toBeVisible()
    // control: once the wait is over the same spot is Send, and one signed message goes out
    await advance(page, 700)
    await expect(send).toHaveAttribute('data-armed', 'true')
    await page.mouse.click(centre(before).x, centre(before).y)
    await expect.poll(() => messages(harness).length).toBe(1)
    expect(messages(harness)[0]?.raw).toMatchObject({ text: PIZZA, owner_confirmed: true })
  })
}

test('the backdrop takes every tap: nothing reaches the app frame, the other view or the composer', async ({
  page,
  context,
  harness,
}) => {
  await views(harness, page, context, ['Notes', 'Asker'])
  await tell(page, 'Asker (app)', { cmd: 'ask', text: PIZZA })
  const chip = page.getByTestId('app-message-chip')
  await expect(chip).toBeVisible()
  const sheet = (await chip.boundingBox()) as Box
  const composer = page.getByTestId('composer').locator('textarea, input, [contenteditable]').first()
  const targets: Array<[string, Locator]> = [
    ['Notes frame', page.locator('iframe[title="Notes (app)"]')],
    ['Asker frame', page.locator('iframe[title="Asker (app)"]')],
    ['composer', composer],
  ]
  for (const [name, loc] of targets) {
    const b = (await loc.boundingBox()) as Box | null
    if (!b) continue
    // a point of the target that the sheet itself does not cover
    const x = b.x + Math.min(b.width, 20) / 2 + 2
    const y = Math.min(b.y + b.height / 2, sheet.y - 4)
    if (y < b.y) continue
    const hit = await page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px as number, py as number)
        return { tag: el?.tagName, inSheet: !!el?.closest('[data-testid="app-message-chip"]'), id: el?.id ?? '' }
      },
      [x, y],
    )
    expect(['IFRAME', 'TEXTAREA', 'INPUT'], `${name} must not be hit`).not.toContain(hit.tag)
    await page.mouse.click(x, y)
  }
  // the Notes view's own button, aimed at by position
  const callBox = (await frameOf(page, 'Notes (app)').locator('#call').boundingBox()) as Box | null
  if (callBox && centre(callBox).y < sheet.y) await page.mouse.click(centre(callBox).x, centre(callBox).y)
  await page.waitForTimeout(200)
  expect(requests(harness)).toEqual([])
  await expect(composer).not.toBeFocused()
  await expect(chip).toBeVisible()
})

test('keyboard: Enter and Space within 600 ms send nothing; after the wait Enter sends and focus returns to the card', async ({
  page,
  context,
  harness,
}) => {
  await views(harness, page, context, ['Asker'])
  await freeze(page)
  await tell(page, 'Asker (app)', { cmd: 'ask', text: PIZZA })
  await expect(page.getByTestId('app-message-dismiss')).toBeFocused()
  const send = page.getByTestId('app-message-send')
  await send.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await advance(page, 100)
  expect(messages(harness)).toEqual([])
  await expect(page.getByTestId('app-message-chip')).toBeVisible()
  await advance(page, 700)
  await expect(send).toHaveAttribute('data-armed', 'true')
  await page.keyboard.press('Enter')
  await expect.poll(() => messages(harness).length).toBe(1)
  await expect(page.getByTestId('app-message-chip')).toHaveCount(0)
  await advance(page, 50) // the sheet hands focus back on a 0 ms timer, which the frozen clock holds
  await expect(page.getByRole('group', { name: /third-party app/ })).toBeFocused()
})

test('a viewport resize (the iOS keyboard, a pinch) re-arms: a tap right after it sends nothing', async ({
  page,
  context,
  harness,
}) => {
  await views(harness, page, context, ['Asker'])
  await freeze(page)
  await tell(page, 'Asker (app)', { cmd: 'ask', text: PIZZA })
  const send = page.getByTestId('app-message-send')
  // The ask reaches the host by postMessage, and the arm timer is only scheduled when the sheet mounts. Advancing the frozen
  // clock before that moves time past a timer that does not exist yet, so the sheet would never arm. Wait for the sheet.
  await expect(page.getByTestId('app-message-chip')).toBeVisible()
  await advance(page, 700)
  await expect(send).toHaveAttribute('data-armed', 'true')
  const vp = page.viewportSize() as { width: number; height: number }
  await page.setViewportSize({ width: vp.width, height: vp.height - 120 })
  await expect(send).toHaveAttribute('data-armed', 'false')
  await advance(page, 100)
  const b = (await send.boundingBox()) as Box
  await page.mouse.click(centre(b).x, centre(b).y)
  expect(messages(harness)).toEqual([])
  await advance(page, 700)
  await expect(send).toHaveAttribute('data-armed', 'true')
  await page.mouse.click(centre(b).x, centre(b).y)
  await expect.poll(() => messages(harness).length).toBe(1)
})

test('in fullscreen the sheet sits above the overlay and Escape on it says No without leaving fullscreen', async ({
  page,
  context,
  harness,
}) => {
  await views(harness, page, context, ['Asker'])
  const card = page.getByTestId('app-view')
  await card.getByRole('button', { name: /Expand Asker/ }).click()
  await expect(card).toHaveAttribute('data-mode', 'fullscreen')
  await tell(page, 'Asker (app)', { cmd: 'ask', text: PIZZA })
  const send = page.getByTestId('app-message-send')
  await expect(send).toBeInViewport({ ratio: 1 })
  const top = await send.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el
  })
  expect(top).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('app-message-chip')).toHaveCount(0)
  await expect(logOf(page, 'Asker (app)')).toContainText('ask:{"isError":true}')
  await expect(card).toHaveAttribute('data-mode', 'fullscreen')
  expect(messages(harness)).toEqual([])
})

test('screens: the message sheet in both themes', async ({ page, context, harness }, info) => {
  await views(harness, page, context, ['Asker'])
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await tell(page, 'Asker (app)', { cmd: 'ask', text: `${PIZZA}\n(${scheme})` })
    await expect(page.getByTestId('app-message-chip')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${info.project.name}-${scheme}-message-sheet.png`) })
    await page.getByTestId('app-message-dismiss').click()
    await expect(page.getByTestId('app-message-chip')).toHaveCount(0)
  }
})
