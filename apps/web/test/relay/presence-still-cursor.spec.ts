// A page that reflows under a cursor nobody moves must not say someone is here. Chromium can fire a pointermove when the layout
// changes under a still cursor (new messages arriving, a card appearing); counted as activity, it kept an owner who had walked
// away "present" for the relay's 60 s window, and the relay held their pushes. Only a real move of the pointer counts.
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn, waitUntil } from '../helpers/util.ts'

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'a mouse cursor parked over the page'))

test('new messages arriving under a parked cursor send no "someone is here"; a real move does', async ({
  page,
  context,
  harness,
}) => {
  // The 15 s report throttle runs on the page's clock (the app takes its Date.now when it starts, so the clock goes in first):
  // the test jumps it instead of waiting it out.
  await page.clock.install()
  await openSignedIn(harness, page, context)
  const visibility = () => harness.appFrames().filter((f) => f.raw.type === 'visibility' && f.raw.state === 'visible')
  // the cursor is parked over the timeline: the first pointermove only records where it is
  await page.mouse.move(400, 300)
  // let the 15 s report throttle run out, so a counted pointermove would send a frame now
  await page.clock.fastForward(16_000)
  const before = visibility().length
  // count the pointermoves the page gets: what follows must really reach it
  await page.evaluate(() => {
    const w = window as unknown as { __moves: number }
    w.__moves = 0
    window.addEventListener('pointermove', () => w.__moves++, { capture: true })
  })
  // New messages arrive, and the browser reports the pointer at the very same spot: what Chromium sends when the layout
  // changes under a still cursor (seen on WSL; headless here does not reflow-fire it, so the spec sends that event itself).
  for (let i = 0; i < 5; i++) {
    harness.relay.sendToApps(agentReply({ text: `row ${i} ${'filler '.repeat(30)}`, format: 'plain' }))
    await expect(page.getByTestId('msg-agent').filter({ hasText: `row ${i} ` })).toBeVisible()
    await page.mouse.move(400, 300)
  }
  // One more reply, and the app's own answer to it (thread.read, not pointer activity) leaves on the same socket after anything
  // the last move sent: once that arrives, a frame the moves would have caused has arrived too.
  const reads = () => harness.appFrames().filter((f) => f.raw.type === 'thread.read').length
  const readsBefore = reads()
  harness.relay.sendToApps(agentReply({ text: 'last row', format: 'plain' }))
  await waitUntil(() => reads() > readsBefore, 'the app marking the last reply read')
  expect(await page.evaluate(() => (window as unknown as { __moves: number }).__moves)).toBeGreaterThan(0)
  expect(visibility()).toHaveLength(before)
  // a person moving the mouse still counts
  await page.mouse.move(420, 310)
  await waitUntil(() => visibility().length === before + 1, 'a visibility frame for a real move')
})
