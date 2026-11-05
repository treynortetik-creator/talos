// Spec 9 WP4 acceptance, browser half: Chromium with a fake microphone (see the `chromium-media` project), the relay
// route stubbed, and a scripted data channel. The page under test is ./harness.
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

const SESSION = 'v_01JBF3V7Q8K2M4N6P8R0S2T426'

async function open(page: Page) {
  const requests: string[] = []
  await page.route('**/api/voice/session', async (route) => {
    requests.push('create')
    await route.fulfill({
      json: { voice_session_id: SESSION, sdp_answer: 'v=0\r\na=answer\r\n', max_minutes: 30 },
    })
  })
  await page.route('**/api/voice/session/*/close', async (route) => {
    requests.push('close')
    await route.fulfill({ status: 204 })
  })
  await page.goto('/test/voice/harness/index.html')
  return requests
}

async function startCall(page: Page) {
  // The real data channel cannot deliver anything before the answer is applied, so the script waits for the answer too.
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/voice/session'))
  await page.getByRole('button', { name: 'Start a live call' }).click()
  await answered
  await expect(page.getByText('Connecting…').first()).toBeVisible()
  await page.evaluate(() => window.__voice.emit({ type: 'session.started' }))
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled()
}

test('the call button is hidden once the composer has text', async ({ page }) => {
  await open(page)
  const button = page.getByRole('button', { name: 'Start a live call' })
  await expect(button).toBeVisible()
  await page.getByLabel('Message').fill('hello')
  await expect(button).toHaveCount(0)
  await page.getByLabel('Message').fill('')
  await expect(button).toBeVisible()
})

test('tapping the button shows the call bar with Mute, a waveform area and End', async ({ page }) => {
  await open(page)
  await startCall(page)
  await expect(page.getByRole('region', { name: 'Call in progress' })).toBeVisible()
  await expect(page.getByRole('toolbar', { name: 'Call controls' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'End call' })).toBeVisible()
  const bar = await page.getByRole('toolbar', { name: 'Call controls' }).boundingBox()
  expect(bar?.height).toBe(72)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
})

test('mute toggles the microphone track and tells the model', async ({ page }) => {
  await open(page)
  await startCall(page)
  expect(await page.evaluate(() => window.__voice.trackEnabled())).toBe(true)
  await page.getByRole('button', { name: 'Mute' }).click()
  expect(await page.evaluate(() => window.__voice.trackEnabled())).toBe(false)
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => window.__voice.sent().map((e) => e.type))).toContain('session.input_audio.mute')
  await page.getByRole('button', { name: 'Unmute' }).click()
  expect(await page.evaluate(() => window.__voice.trackEnabled())).toBe(true)
})

test('the page going to the background ends the call and releases the microphone', async ({ page }) => {
  const requests = await open(page)
  await startCall(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByRole('region', { name: 'Call in progress' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start a live call' })).toBeVisible()
  expect(requests).toEqual(['create', 'close'])
  expect(await page.evaluate(() => window.__voice.trackState())).toBe('ended')
})

test('leaving the app while the call connects ends it with no red line and frees the microphone', async ({ page }) => {
  const requests = await open(page)
  // Hold the relay's answer. The microphone stream has arrived by the time the POST is sent, so the page is hidden
  // while the POST is pending, and no visibilitychange event fires (the app must notice when the answer comes back).
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const posted = new Promise<void>((r) => {
    void page.route('**/api/voice/session', async (route) => {
      requests.push('create')
      r()
      await gate
      await route.fulfill({
        json: { voice_session_id: SESSION, sdp_answer: 'v=0\r\na=answer\r\n', max_minutes: 30 },
      })
    })
  })
  await page.getByRole('button', { name: 'Start a live call' }).click()
  await posted
  expect(await page.evaluate(() => window.__voice.trackState())).not.toBe('ended')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  })
  release()
  await expect.poll(() => requests).toEqual(['create', 'close'])
  await expect(page.getByRole('button', { name: 'Start a live call' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('call-error')).toHaveCount(0)
  expect(await page.evaluate(() => window.__voice.trackState())).toBe('ended')
})

test('a relay refusal shows one dismissible line', async ({ page }) => {
  await open(page)
  await page.route('**/api/voice/session', (route) =>
    route.fulfill({ status: 429, json: { message: "Today's live-voice limit is used up." } }),
  )
  await page.getByRole('button', { name: 'Start a live call' }).click()
  const line = page.getByTestId('call-error')
  await expect(line).toContainText("Today's live-voice limit is used up.")
  await line.getByRole('button').click()
  await expect(line).toHaveCount(0)
})

test('the hand-off chip shows the signed question, then flips to the answer', async ({ page }) => {
  await open(page)
  await startCall(page)
  await page.evaluate(() => {
    window.__voice.emit({ type: 'session.input_transcript.delta', delta: 'What is on my plate today?' })
    window.__voice.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' } })
  })
  const chip = page.getByRole('list', { name: 'Hand-offs' }).getByRole('listitem')
  await expect(chip).toHaveText('Handed to Talos: What is on my plate today? · working')
  await expect(chip).toHaveAttribute('data-state', 'working')
  await page.evaluate(() => window.__voice.emitReply('dlg_1', 'Two meetings and one deadline.'))
  await expect(chip).toHaveText('Talos answered: Two meetings and one deadline.')
  await expect(chip).toHaveAttribute('data-state', 'done')
})

test('End hangs up: session.close on the channel, close request to the relay', async ({ page }) => {
  const requests = await open(page)
  await startCall(page)
  await page.getByRole('button', { name: 'End call' }).click()
  await expect(page.getByRole('button', { name: 'Start a live call' })).toBeVisible()
  expect(requests).toEqual(['create', 'close'])
  expect(await page.evaluate(() => window.__voice.sent().map((e) => e.type))).toContain('session.close')
})

test('hold-to-talk: the mic opens only while the talk area is pressed', async ({ page }) => {
  await open(page)
  await startCall(page)
  const area = page.getByTestId('talk-area')
  const box = await area.boundingBox()
  if (!box) throw new Error('no talk area')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.getByRole('button', { name: 'Hold to talk' })).toBeVisible({ timeout: 3000 }) // long-press switches mode
  await page.mouse.up()
  expect(await page.evaluate(() => window.__voice.trackEnabled())).toBe(false)
  await page.mouse.down()
  expect(await page.evaluate(() => window.__voice.trackEnabled())).toBe(true)
  await page.mouse.up()
  expect(await page.evaluate(() => window.__voice.trackEnabled())).toBe(false)
})
