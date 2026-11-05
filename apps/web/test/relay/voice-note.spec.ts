import { expect, test } from '../helpers/fixtures.ts'
import { clickRetryIfShown, frameOfType, openSignedIn, sigOk, waitUntil } from '../helpers/util.ts'

// Chromium with a fake microphone (the WebKit project cannot automate getUserMedia).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'fake media needs Chromium'))

type Page = import('@playwright/test').Page

async function micCenter(page: Page) {
  // The live-call button beside the mic is a lazy chunk: when it lands the mic moves over by a button's width, so a press
  // aimed at the old spot hits nothing.
  await expect(page.getByRole('button', { name: 'Start a live call' })).toBeVisible()
  const box = await page.getByTestId('mic').boundingBox()
  if (!box) throw new Error('mic not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * The recorder runs from when the browser hands over the microphone, not from the press, and on a busy machine that alone
 * can use up a fixed wait: a 900 ms hold then records under the composer's 400 ms "accidental touch" floor and nothing is
 * sent. The timer on screen counts recorded time, and reads 0:01 from half a second, so a test waits for that.
 */
const recorded = (page: Page) =>
  expect(page.getByTestId('composer').getByText(/^0:0[1-9]$/)).toBeVisible({ timeout: 20_000 })

/** Presses the mic and keeps holding until the recorder has really recorded something. */
async function holdMic(page: Page) {
  const { x, y } = await micCenter(page)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect(page.getByTestId('composer').getByText('Slide to cancel')).toBeVisible()
  await recorded(page)
  return { x, y }
}

test('hold the mic and release: a signed voice_note frame with the uploaded audio', async ({
  page,
  context,
  harness,
}) => {
  const dev = await openSignedIn(harness, page, context)
  await holdMic(page)
  await page.mouse.up()
  await waitUntil(() => frameOfType(harness, 'voice_note').length === 1, 'voice_note frame', 10_000)
  const rec = frameOfType(harness, 'voice_note')[0]
  if (!rec) throw new Error('no frame')
  const att = rec.raw.attachment as Record<string, unknown>
  expect(att.kind).toBe('voice_note')
  expect(String(att.mime)).toMatch(/^audio\/(webm|mp4)/)
  expect(att.duration_ms).toBeGreaterThan(300)
  expect(String(att.waveform).length).toBe(88) // 64 bytes, base64
  expect(await sigOk(rec.raw, dev.publicJwk)).toBe(true)
  expect(harness.relay.media.size).toBe(1)
  await expect(page.getByTestId('voice-note')).toBeVisible()
  await expect(page.getByTestId('voice-note').getByText('Transcribing…')).toBeVisible()
  // A transcript frame fills it in.
  const messageId = rec.raw.client_msg_id as string
  harness.relay.sendToApps({
    type: 'transcript',
    message_id: messageId,
    text: 'hello from the fake transcript',
    engine: 'fake',
    status: 'done',
  })
  await expect(page.getByTestId('voice-note').getByText('hello from the fake transcript')).toBeVisible()
  // Speed cycles from 1x (the full cycle is in html-fullscreen-speed.spec.ts).
  await page.getByRole('button', { name: /Playback speed 1x/ }).click()
  await expect(page.getByRole('button', { name: /Playback speed 1.25x/ })).toBeVisible()
})

test('slide left cancels: nothing is uploaded or sent', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  const { x, y } = await holdMic(page)
  await page.mouse.move(x - 150, y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  expect(frameOfType(harness, 'voice_note')).toHaveLength(0)
  expect(harness.relay.media.size).toBe(0)
  await expect(page.getByTestId('recorder-locked')).toHaveCount(0)
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
})

test('slide up locks hands-free recording; Send finishes it', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  const { x, y } = await holdMic(page)
  await page.mouse.move(x, y - 90, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByTestId('recorder-locked')).toBeVisible()
  await page.waitForTimeout(700)
  expect(frameOfType(harness, 'voice_note')).toHaveLength(0)
  await page.getByRole('button', { name: 'Send voice note' }).click()
  await waitUntil(() => frameOfType(harness, 'voice_note').length === 1, 'voice_note frame', 10_000)
})

test('a tap on the mic locks; Cancel throws the recording away', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  await page.getByTestId('mic').click()
  await expect(page.getByTestId('recorder-locked')).toBeVisible()
  await recorded(page)
  await page.getByRole('button', { name: 'Pause recording' }).click()
  await expect(page.getByRole('button', { name: 'Resume recording' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel recording' }).click()
  await expect(page.getByTestId('recorder-locked')).toHaveCount(0)
  expect(frameOfType(harness, 'voice_note')).toHaveLength(0)
})

test('a tap locks, then Send delivers', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  await page.getByTestId('mic').click()
  await expect(page.getByTestId('recorder-locked')).toBeVisible()
  await recorded(page)
  await page.getByRole('button', { name: 'Send voice note' }).click()
  await waitUntil(() => frameOfType(harness, 'voice_note').length === 1, 'voice_note frame', 10_000)
})

test('a voice note recorded while the server is away is uploaded and signed on reconnect', async ({
  page,
  context,
  harness,
}) => {
  const dev = await openSignedIn(harness, page, context)
  harness.blockWs(true)
  harness.dropAppSockets()
  await expect(page.getByText(/Can't reach your server/)).toBeVisible()
  await page.getByTestId('mic').click()
  await recorded(page)
  await page.getByRole('button', { name: 'Send voice note' }).click()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toBeVisible()
  expect(harness.relay.media.size).toBe(0)
  harness.blockWs(false)
  await clickRetryIfShown(page) // the 1 s auto-retry may win the race; never wait on the button
  await waitUntil(() => frameOfType(harness, 'voice_note').length === 1, 'voice_note after reconnect', 15_000)
  const rec = frameOfType(harness, 'voice_note')[0]
  expect(rec && (await sigOk(rec.raw, dev.publicJwk))).toBe(true)
  expect(harness.relay.media.size).toBe(1)
})
