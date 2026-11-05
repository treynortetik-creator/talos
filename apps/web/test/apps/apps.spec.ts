// MCP Apps in a real browser: the production web build, the testkit relay, a probe view served with the spec's headers
// (sandbox + CSP). Runs on desktop Chromium, an iPhone (WebKit) and a Pixel (Chromium). Everything the view sees or
// does is read from OUTSIDE the frame, because the frame is an opaque origin.
import AxeBuilder from '@axe-core/playwright'
import type { Frame, Page } from '@playwright/test'
import { AppRequestFrame, newUlid } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { openSignedIn, sigOk } from '../helpers/util.ts'
import { type Probe, probeView, relayAcceptsAppRequests } from './probe.ts'

const frameOf = (page: Page, title = 'Notes (app)') => page.frameLocator(`iframe[title="${title}"]`)
const logOf = (page: Page, title?: string) => frameOf(page, title).locator('#log')
const requests = (harness: Harness) => harness.appFrames().filter((f) => f.raw.type === 'app.request')

async function show(
  harness: Harness,
  page: Page,
  context: Parameters<typeof openSignedIn>[2],
  over?: Parameters<typeof probeView>[1],
) {
  await relayAcceptsAppRequests(harness)
  const dev = await openSignedIn(harness, page, context)
  const probe = probeView(harness, over)
  probe.send()
  await expect(page.getByTestId('app-view').first()).toBeVisible()
  return { dev, probe }
}
const answer = (harness: Harness, probe: Probe, state: string, extra: Record<string, unknown> = {}) => {
  const last = requests(harness).at(-1)?.raw
  harness.relay.sendToApps({
    type: 'app.response',
    view_id: probe.view.view_id,
    request_id: last?.request_id,
    state,
    ...extra,
  })
}

test('a view row from the relay: chrome outside the frame, handshake, input and result, sandboxed', async ({
  page,
  context,
  harness,
}) => {
  await show(harness, page, context)
  await expect(page.getByTestId('app-label')).toHaveText('Notes')
  await expect(page.getByTestId('app-source')).toHaveText('probe-notes · show_note')
  await expect(page.getByTestId('app-badge')).toHaveText('Third-party app')
  const iframe = page.locator('iframe[title="Notes (app)"]')
  expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts')
  expect(await iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(await iframe.getAttribute('allow')).toBeNull()
  await expect(logOf(page)).toContainText('init:talos-app')
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-input {"arguments":{"id":"n1"}}')
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  await expect(logOf(page)).toContainText('Buy milk')
  await expect(page.getByTestId('app-loading')).toHaveCount(0)
  await expect(page.getByText('Open in new tab')).toHaveCount(0)
  // opaque origin: no parent, no storage, no cookies, no network the CSP did not approve
  await expect(logOf(page)).toContainText('parent:SecurityError')
  await expect(logOf(page)).toContainText('storage:SecurityError')
  await expect(logOf(page)).toContainText('fetch:blocked')
  await expect(logOf(page)).not.toContainText('parent:reachable')
  expect(await page.locator('iframe[title="Notes (app)"]').evaluate((el) => (el as HTMLIFrameElement).src)).toMatch(
    /\/media\/md_[0-9A-Z]{26}\/app$/,
  )
})

test('a click in the view becomes a signed app.request with user_gesture; the answer reaches the view', async ({
  page,
  context,
  harness,
}) => {
  const { dev, probe } = await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  await frameOf(page).locator('#call').click()
  await expect.poll(() => requests(harness).length).toBe(1)
  const raw = requests(harness)[0]?.raw as Record<string, unknown>
  expect(await sigOk(raw, dev.publicJwk)).toBe(true)
  expect(AppRequestFrame.safeParse(raw).success).toBe(true)
  expect(raw).toMatchObject({
    method: 'tools/call',
    tool_name: 'read_note',
    arguments: { id: 'n1' },
    user_gesture: true,
    view_id: probe.view.view_id,
  })
  await expect(page.getByTestId('app-status')).toHaveText('Waiting for Talos…')
  answer(harness, probe, 'pending_card', { card_id: `c_${newUlid()}` })
  await expect(page.getByTestId('app-status')).toHaveText('Waiting for your approval')
  answer(harness, probe, 'done', { result: { content: [{ type: 'text', text: 'Buy milk' }] } })
  await expect(logOf(page)).toContainText(
    'call:{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Buy milk"}]}}',
  )
  await expect(page.getByTestId('app-status')).toHaveCount(0)
})

test('one tap in the view pays for one request; the next tap pays for the next; Talos chrome pays for nothing', async ({
  page,
  context,
  harness,
}) => {
  await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  await frameOf(page).locator('#twice').click()
  await expect.poll(() => requests(harness).length).toBe(2)
  const gestures = () => requests(harness).map((r) => r.raw.user_gesture)
  expect(gestures()).toEqual([true, false])
  await frameOf(page).locator('#call').click()
  await expect.poll(() => requests(harness).length).toBe(3)
  expect(gestures()).toEqual([true, false, true])
  // a tap on Talos chrome, then the view acts on its own: no gesture for it
  await page.getByTestId('app-label').click()
  await frameOf(page)
    .locator('body')
    .evaluate(() => {
      void (window as unknown as { req(m: string, p: unknown): Promise<unknown> }).req('tools/call', {
        name: 'late',
        arguments: {},
      })
    })
  await expect.poll(() => requests(harness).length).toBe(4)
  expect(gestures().at(-1)).toBe(false)
})

test('a failed answer is -32000 with data.talos; ui/message failure is isError', async ({ page, context, harness }) => {
  const { probe } = await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  await frameOf(page).locator('#call').click()
  await expect.poll(() => requests(harness).length).toBe(1)
  answer(harness, probe, 'failed', { error: { code: 'agent_declined', message: 'Talos declined this one.' } })
  await expect(logOf(page)).toContainText('"code":-32000')
  await expect(logOf(page)).toContainText('"talos":"agent_declined"')
  await frameOf(page).locator('#say').click()
  // a message waits for the owner's tap on Talos's chip; the view's own tap does not send it
  await expect(page.getByTestId('app-message-text')).toHaveText('remind me tomorrow')
  expect(requests(harness)).toHaveLength(1)
  await expect(page.getByTestId('app-message-send')).toHaveAttribute('data-armed', 'true')
  await page.getByTestId('app-message-send').click()
  await expect.poll(() => requests(harness).length).toBe(2)
  expect(requests(harness)[1]?.raw).toMatchObject({
    method: 'ui/message',
    text: 'remind me tomorrow',
    owner_confirmed: true,
  })
  answer(harness, probe, 'failed', { error: { code: 'mac_offline', message: 'Your Mac is offline.' } })
  await expect(logOf(page)).toContainText('say:{"jsonrpc":"2.0","id":3,"result":{"isError":true}}')
})

test('open-link asks first and shows the whole URL; Cancel opens nothing', async ({ page, context, harness }) => {
  await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  await page.evaluate(() => {
    ;(window as unknown as { __opened: string[] }).__opened = []
    window.open = ((u: string) => {
      ;(window as unknown as { __opened: string[] }).__opened.push(String(u))
      return null
    }) as typeof window.open
  })
  await frameOf(page).locator('#link').click()
  const dialog = page.getByRole('dialog', { name: /Open a link from Notes\?/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('open-link-url')).toHaveText('https://example.com/docs?x=1')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(logOf(page)).toContainText('link:{"jsonrpc":"2.0","id":2,"result":{"isError":true}}')
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([])
})

test('fullscreen waits for a tap on the Talos chip, then keeps the same frame (no reload) and the bar; No is refused', async ({
  page,
  context,
  harness,
}) => {
  await show(harness, page, context, { autofs: true })
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  const boot = (await logOf(page).locator('li', { hasText: 'init:' }).textContent()) ?? ''
  expect(boot).toMatch(/boot=\w+/)
  // the probe asks for fullscreen on a timer, 6 s after the result, with no tap at all: a chip, never a switch
  await expect(page.getByTestId('app-fullscreen-chip')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-mode', 'inline') // the sheet is a dialog; the card is not fullscreen
  await page.getByTestId('app-fullscreen-no').click()
  await expect(logOf(page)).toContainText('autofs:inline')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await frameOf(page).locator('#fs').click() // a real tap in the view is still only a request
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-mode', 'inline')
  await expect(page.getByTestId('app-fullscreen-allow')).toHaveAttribute('data-armed', 'true')
  await page.getByTestId('app-fullscreen-allow').click()
  await expect(page.getByRole('dialog', { name: /Notes/ })).toBeVisible()
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-mode', 'fullscreen')
  await expect(page.getByTestId('app-badge')).toBeVisible()
  await expect(logOf(page)).toContainText('"displayMode":"fullscreen"')
  await expect(logOf(page)).toContainText('"containerDimensions":{"width":')
  // the frame was not reloaded: the log from before is still there and the boot id is the one it started with
  expect(await logOf(page).textContent()).toContain(boot)
  await expect(page.locator('iframe[title="Notes (app)"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(logOf(page)).toContainText('"displayMode":"inline"')
})

test('a view that navigates itself is stopped with a plain notice', async ({ page, context, harness }) => {
  await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  await frameOf(page).locator('#leave').click()
  await expect(page.getByTestId('app-poster')).toContainText('tried to leave its frame')
  await expect(page.locator('iframe[title="Notes (app)"]')).toHaveCount(0)
})

test('app.update shows a poster live and after a reload', async ({ page, context, harness }) => {
  const { probe } = await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  harness.relay.sendToApps({
    type: 'app.update',
    view_id: probe.view.view_id,
    thread_id: 'general',
    state: 'superseded',
  })
  await expect(page.getByTestId('app-poster')).toContainText('Replaced by a newer view')
  await expect(page.locator('iframe[title="Notes (app)"]')).toHaveCount(0)
  await page.waitForTimeout(1200) // the cache saves after 250 ms
  await page.reload()
  await expect(page.getByTestId('app-poster')).toContainText('Replaced by a newer view')
  await expect(page.locator('iframe[title="Notes (app)"]')).toHaveCount(0)
})

test('four views: three live frames, the oldest is a poster that can be loaded', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  const names = ['One', 'Two', 'Three', 'Four']
  for (const label of names) {
    probeView(harness, { label }).send()
    await expect(page.getByTestId('app-label').filter({ hasText: label })).toBeVisible()
  }
  await expect(page.locator('iframe[title$="(app)"]')).toHaveCount(3)
  await expect(page.getByTestId('app-view').first()).toHaveAttribute('data-state', 'poster')
  await page.getByRole('button', { name: 'Load app' }).click()
  await expect(page.locator('iframe[title="One (app)"]')).toBeVisible()
  await expect(page.locator('iframe[title$="(app)"]')).toHaveCount(3)
})

test('growing, theming and a view that never starts', async ({ page, context, harness }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const { probe } = await show(harness, page, context)
  await expect(logOf(page)).toContainText('theme=dark')
  await frameOf(page).locator('#grow').click()
  await expect
    .poll(async () => (await page.locator('iframe[title="Notes (app)"]').boundingBox())?.height)
    .toBeGreaterThan(400)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(logOf(page)).toContainText('"theme":"light"')
  // a view that never says ui/initialize
  const silent = probeView(harness, { label: 'Silent', html: '<!doctype html><body>nothing happens</body>' })
  silent.send()
  await expect(page.getByTestId('app-failed')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-failed')).toContainText("didn't start")
  expect(probe.view.view_id).not.toBe(silent.view.view_id)
})

test('axe: an app card, light and dark', async ({ page, context, harness }) => {
  const { probe } = await show(harness, page, context)
  await expect(logOf(page)).toContainText('in:ui/notifications/tool-result')
  expect(probe).toBeTruthy()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(300)
    const results = await new AxeBuilder({ page })
      .include('[data-testid="app-view"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(
      bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      scheme,
    ).toEqual([])
  }
})

test('screens: inline, fullscreen, poster, failed, sheet, in both themes', async ({ page, context, harness }, info) => {
  await openSignedIn(harness, page, context)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const p = probeView(harness, { label: `Notes ${scheme}` })
    p.send()
    await expect(logOf(page, `Notes ${scheme} (app)`)).toContainText('in:ui/notifications/tool-result')
    await page.screenshot({ path: info.outputPath(`${info.project.name}-${scheme}-inline.png`) })
    await frameOf(page, `Notes ${scheme} (app)`).locator('#link').click()
    await expect(page.getByRole('dialog', { name: /Open a link/ })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${info.project.name}-${scheme}-sheet.png`) })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await frameOf(page, `Notes ${scheme} (app)`).locator('#fs').click()
    await expect(page.getByTestId('app-fullscreen-chip')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${info.project.name}-${scheme}-chip.png`) })
    await expect(page.getByTestId('app-fullscreen-allow')).toHaveAttribute('data-armed', 'true')
    await page.getByTestId('app-fullscreen-allow').click()
    await expect(page.getByRole('dialog', { name: /Notes/ })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${info.project.name}-${scheme}-fullscreen.png`) })
    await page.keyboard.press('Escape')
    harness.relay.sendToApps({ type: 'app.update', view_id: p.view.view_id, thread_id: 'general', state: 'closed' })
    await expect(page.getByTestId('app-poster').last()).toContainText('Closed')
    await page.screenshot({ path: info.outputPath(`${info.project.name}-${scheme}-poster.png`) })
  }
})

test('an older Talos build in the same thread: plain rows are untouched', async ({ page, context, harness }) => {
  await show(harness, page, context)
  harness.relay.sendToApps({
    type: 'reply',
    message: {
      id: `m_${newUlid()}`,
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: 'plain reply',
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: new Date().toISOString(),
    },
  })
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'plain reply' })).toBeVisible()
  await expect(page.getByTestId('app-view')).toHaveCount(1)
})

export type { Frame }
