import { createConnection, expect, sendHook, sendText, signedIn, test, waitUntil } from '../harness/fixtures.ts'

test('9a. bridge crash: nothing is lost, the relay replays in order, and every frame ends up consumed', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const conn = await createConnection(stack, page, 'generic')
  await sendText(page, 'before the crash')
  await stack.claude.waitForNotification((n) => n.content === 'before the crash')
  await waitUntil(() => stack.pendingForBridge() === 0, 'the first message to be consumed')

  await stack.crashBridge() // SIGKILL
  for (const t of ['one', 'two', 'three']) {
    await sendText(page, t)
    await expect(page.getByTestId('msg-owner').filter({ hasText: new RegExp(`^${t}`) })).toBeVisible()
  }
  // The bubble is optimistic: wait until the relay holds all three signed frames, so the hook gets the later sequence number.
  await waitUntil(() => stack.pendingForBridge() === 3, 'the relay to hold the 3 signed messages')
  expect(await sendHook(stack, conn, { title: 'while down', priority: 'normal' })).toBe(200)
  await waitUntil(() => stack.pendingForBridge() === 4, 'the relay to hold 3 messages and 1 event')

  const claude = await stack.startBridge()
  await claude.waitForNotification((n) => n.meta.kind === 'hook_event', 20_000)
  // Same order they were sent in: the three messages, then the event.
  const seen = claude.notifications.filter((n) => ['text', 'hook_event', 'backlog'].includes(n.meta.kind ?? ''))
  expect(seen.map((n) => (n.meta.kind === 'hook_event' ? 'event' : n.content))).toEqual([
    'one',
    'two',
    'three',
    'event',
  ])
  // Consumed acks: the relay buffer for the bridge drains completely, and a second restart replays nothing.
  await waitUntil(() => stack.pendingForBridge() === 0, 'every frame to be acked as consumed')
  await stack.stopBridge()
  const again = await stack.startBridge()
  await page.waitForTimeout(1500)
  expect(again.notifications.filter((n) => ['text', 'hook_event', 'backlog'].includes(n.meta.kind ?? ''))).toHaveLength(
    0,
  )
})

test('9b. messages that waited more than 15 minutes arrive as ONE backlog notification, then the event separately', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const conn = await createConnection(stack, page, 'generic')
  await stack.crashBridge()
  // The relay's clock runs 20 minutes behind while these arrive, so by the time the Mac is back they are 20 minutes old.
  stack.skew.ms = -20 * 60_000
  for (const t of ['first', 'second', 'third']) await sendText(page, t)
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toHaveCount(3)
  expect(await sendHook(stack, conn, { title: 'late event', priority: 'normal' })).toBe(200)
  await waitUntil(() => stack.pendingForBridge() === 4, 'the relay to hold 3 messages and 1 event')
  stack.skew.ms = 0

  const claude = await stack.startBridge()
  await claude.waitForNotification((n) => n.meta.kind === 'hook_event', 20_000)
  const kinds = claude.notifications.map((n) => n.meta.kind)
  expect(kinds.filter((k) => k === 'backlog')).toHaveLength(1)
  expect(kinds.filter((k) => k === 'text')).toHaveLength(0)
  const backlog = claude.notifications.find((n) => n.meta.kind === 'backlog')
  expect(backlog?.meta.trust).toBe('owner')
  for (const t of ['first', 'second', 'third']) expect(backlog?.content).toContain(t)
  // The event is its own notification, external, and never inside the owner batch.
  expect(backlog?.content).not.toContain('late event')
  const event = claude.notifications.find((n) => n.meta.kind === 'hook_event')
  expect(event?.meta.trust).toBe('external')
  await waitUntil(() => stack.pendingForBridge() === 0, 'every frame to be consumed')
})
