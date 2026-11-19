import { expect, sendText, signedIn, test } from '../harness/fixtures.ts'
import { hostileClockMs } from '../harness/hostile.ts'

// The hostile nightly shifts every Node and bun process's Date; the harness must shift the browser (and the agent's hooks)
// the same, or the bridge refuses the page's signed frames as stale. In a normal run there is nothing to prove.
test.skip(hostileClockMs() === 0, 'only meaningful in the hostile nightly (TALOS_HOSTILE_CLOCK_MS set)')

test('hostile: a signed message reaches the agent and the page shares this process clock', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await sendText(page, 'hello')
  const note = await stack.claude.waitForNotification((n) => n.content === 'hello')
  expect(note.meta).toMatchObject({ thread_id: 'general', trust: 'owner', kind: 'text' })
  // a reload opens a new document: the shift must hold there too, and time must not run backwards
  const before = await page.evaluate(() => Date.now())
  await page.reload()
  const pageNow = await page.evaluate(() => Date.now())
  expect(pageNow).toBeGreaterThanOrEqual(before)
  expect(
    await page.evaluate(() => (globalThis as unknown as { __talosHostileClockMs?: number }).__talosHostileClockMs),
  ).toBe(hostileClockMs())
  expect(Math.abs(pageNow - Date.now())).toBeLessThan(60_000)
})
