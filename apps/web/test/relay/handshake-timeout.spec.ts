// A dial that hangs (the upgrade is accepted by the network but its answer never reaches the page) is given up on by the
// client itself after HANDSHAKE_GIVE_UP_MS (20 s), with no focus or online event to trigger it, and the page redials and comes
// back. The page's clock is Playwright's, so the 20 s is fast-forwarded, never waited out.
import { expect, test } from '../helpers/fixtures.ts'
import { frameOfType, openSignedIn, waitUntil } from '../helpers/util.ts'

test('a handshake that hangs is given up on after 20 s and the page reconnects on its own', async ({
  page,
  context,
  harness,
}) => {
  await page.clock.install()
  await openSignedIn(harness, page, context)
  expect(frameOfType(harness, 'hello')).toHaveLength(1)
  harness.silenceNextWs() // the next dial hangs: no 101, no close
  harness.dropAppSockets() // the live link drops, so the page redials after its backoff
  await expect
    .poll(
      async () => {
        await page.clock.fastForward(500) // the backoff wait, in the page's own clock
        return harness.silencedWsCount()
      },
      { message: 'the redial reached the relay and was black-holed', timeout: 0, intervals: [25] },
    )
    .toBe(1)
  await page.clock.fastForward(19_000) // 19 s into a dial that gets no answer: still waiting, nothing replaced
  expect(harness.silencedWsCount()).toBe(1)
  expect(frameOfType(harness, 'hello')).toHaveLength(1)
  await page.clock.fastForward(2_000) // past 20 s: the client gives up by itself, with no focus or online event
  await expect(page.getByText(/Can't reach your server/)).toBeVisible()
  // dropped by the client's own timer (code 4001), not by a browser close (1006) that a hung socket might also end in
  const codes = await page.evaluate(
    () => (globalThis as { __talosDrops?: { codes: Record<number, number> } }).__talosDrops?.codes,
  )
  expect(codes?.[4001]).toBe(1)
  // the normal backoff, then a whole dial
  await expect
    .poll(
      async () => {
        await page.clock.fastForward(1_000)
        return frameOfType(harness, 'hello').length
      },
      { message: 'a second hello on the redial after the give-up', timeout: 0, intervals: [25] },
    )
    .toBe(2)
  await waitUntil(() => harness.relay.appCount > 0, 'app socket back')
  await expect(page.getByText(/Can't reach your server/)).toHaveCount(0)
  await page.getByLabel('Message', { exact: true }).fill('after the hung dial')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toBeVisible()
  expect(frameOfType(harness, 'hello')).toHaveLength(2)
})
