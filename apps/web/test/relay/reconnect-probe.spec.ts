// 0.19, real page + real client against the relay harness: coming back to the page (online, focus, a page restored from the
// back-forward cache) probes the live socket and replaces it only when it is dead. A healthy socket is kept (one ping, no
// second hello, nothing written twice); a dead one is replaced once and the message written into it arrives once. The page's
// clock is Playwright's, so the 10 s probe window is fast-forwarded, never waited out.
import { expect, test } from '../helpers/fixtures.ts'
import { frameOfType, openSignedIn, waitUntil } from '../helpers/util.ts'

const COMING_BACK = () => {
  window.dispatchEvent(new Event('online'))
  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
}

test('online, focus and a restored page leave a healthy socket alone: one ping, no new hello, one message', async ({
  page,
  context,
  harness,
}) => {
  await page.clock.install()
  await openSignedIn(harness, page, context)
  expect(frameOfType(harness, 'hello')).toHaveLength(1)
  await page.evaluate(COMING_BACK)
  await waitUntil(() => frameOfType(harness, 'ping').length >= 1, 'the probe ping')
  await page.clock.fastForward(12_000) // well past the probe window
  await page.getByLabel('Message', { exact: true }).fill('after coming back')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toBeVisible()
  expect(frameOfType(harness, 'hello')).toHaveLength(1) // never replaced
  expect(frameOfType(harness, 'ping')).toHaveLength(1) // the three events shared one probe
  expect(frameOfType(harness, 'message')).toHaveLength(1)
})

test('a dead socket is replaced once when the page comes back, and the message written into it arrives once', async ({
  page,
  context,
  harness,
}) => {
  await page.clock.install()
  await openSignedIn(harness, page, context)
  harness.silenceOpenWs() // the link dies under the page: nothing comes back, nothing closes
  await page.getByLabel('Message', { exact: true }).fill('written into the dead link')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'the message reached the relay')
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toHaveCount(0) // its ack was swallowed
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the one event: the old code had no focus listener
  await waitUntil(() => frameOfType(harness, 'ping').length >= 1, 'the probe ping')
  await page.clock.fastForward(11_000) // past the probe window, with no pong
  await waitUntil(() => frameOfType(harness, 'hello').length === 2, 'one replacement socket')
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toBeVisible()
  await page.clock.fastForward(12_000)
  expect(frameOfType(harness, 'hello')).toHaveLength(2) // and no third
  // the identical signed bytes went again; the relay answers the repeat as a duplicate, so there is one message
  const sent = frameOfType(harness, 'message')
  expect(new Set(sent.map((f) => f.raw.id)).size).toBe(1)
  expect(new Set(sent.map((f) => f.text)).size).toBe(1)
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'written into the dead link' })).toHaveCount(1)
})
