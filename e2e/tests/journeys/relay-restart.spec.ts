// Journey: the relay is redeployed (stopped, then started again on the same port, data folder and keys) while the owner
// keeps sending and the agent keeps replying. Every message and every reply must land once, in order, and nothing may be
// left waiting at the relay for the Mac. This is a graceful stop, not a crash: no journey kills the relay process with
// data held (bughunt-crash only checks that a reset socket cannot bring it down).
// What makes the first test real: the relay stays down until the Mac has failed to reconnect more than once (so a retry
// that gives up is caught), the owner's messages and the agent's replies made meanwhile wait in the app's queue and on
// the Mac, and a stopped relay must leave no timer running. In that test the relay itself holds nothing across the
// restart (the Mac had acknowledged the first two messages); a frame the relay holds through a restart is the second test.
import { card, cardIdFrom, expect, LOW_RISK_CARD, sendText, signedIn, test, waitUntil } from '../../harness/fixtures.ts'

test.setTimeout(180_000)

const owner = ['steady 1', 'steady 2', 'while down 3', 'while down 4', 'after 5']
/** How many times the bridge has scheduled a reconnect so far (each follows a refused or dropped connection). */
const retries = (log: string) => log.split('reconnect scheduled').length - 1

const replies = ['agent reply A (down)', 'agent reply B (down)']

test('relay-restart: messages and replies sent around a relay restart each land once, in order', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)

  await test.step('two messages before the restart', async () => {
    for (const t of owner.slice(0, 2)) {
      await sendText(page, t)
      await stack.claude.waitForNotification((n) => n.content === t)
    }
  })

  await test.step('the relay goes down and stays down past two failed reconnects by the Mac', async () => {
    const before = retries(stack.bridgeLog())
    await stack.stopRelay()
    expect(stack.relayTimersLeft(), 'a stopped relay must leave no timer running').toBe(0)
    await waitUntil(() => retries(stack.bridgeLog()) >= before + 2, 'the Mac to fail to reconnect twice', 60_000)
  })

  await test.step('the owner sends two more and the agent replies twice while the relay is away', async () => {
    for (const t of owner.slice(2, 4)) await sendText(page, t)
    for (const text of replies) {
      const r = await stack.claude.callTool('reply', { thread_id: 'general', text })
      // A reply with nowhere to go must say so or be kept: it may not look sent and vanish.
      expect(r.isError, JSON.stringify(r)).toBeFalsy()
    }
  })

  await test.step('the relay comes back', async () => {
    await stack.startRelay()
    await waitUntil(() => stack.relay.services.bus.bridgeOnline(), 'the Mac to reconnect', 90_000)
  })

  await test.step('the owner sends one more', async () => {
    await sendText(page, owner[4] as string)
  })

  await test.step('the agent got every message once, in the order sent', async () => {
    await stack.claude.waitForNotification((n) => n.content === owner[4], 90_000)
    const got = stack.claude.notifications.filter((n) => owner.includes(n.content ?? '')).map((n) => n.content)
    expect(got).toEqual(owner)
    await waitUntil(() => stack.pendingForBridge() === 0, 'the relay to hold nothing for the Mac', 60_000)
  })

  await test.step('the app shows every message and reply once, each side in order', async () => {
    const texts = async (testId: string) =>
      (await page.getByTestId(testId).allInnerTexts()).map((t) => t.trim()).filter((t) => !t.startsWith('ack:'))
    for (const r of replies)
      await expect(page.getByTestId('msg-agent').filter({ hasText: r })).toHaveCount(1, { timeout: 60_000 })
    for (const t of owner) await expect(page.getByTestId('msg-owner').filter({ hasText: t })).toHaveCount(1)
    expect((await texts('msg-agent')).map((t) => replies.find((r) => t.includes(r)))).toEqual(replies)
    expect((await texts('msg-owner')).map((t) => owner.find((o) => t.includes(o)))).toEqual(owner)
  })

  await test.step('a reload shows the same thing (the history on the Mac and the relay agree)', async () => {
    await page.reload()
    for (const r of replies)
      await expect(page.getByTestId('msg-agent').filter({ hasText: r })).toHaveCount(1, { timeout: 30_000 })
    for (const t of owner) await expect(page.getByTestId('msg-owner').filter({ hasText: t })).toHaveCount(1)
  })
})

test('relay-restart (held tap): a tap the relay holds for an absent Mac survives the relay restart and lands once', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...LOW_RISK_CARD }))
  const article = card(page, id)
  await expect(article.getByRole('button', { name: 'Yes, shorter' })).toBeVisible()

  await test.step('the Mac goes away and the owner taps; the relay holds the tap', async () => {
    await stack.crashBridge()
    await article.getByRole('button', { name: 'Yes, shorter' }).click()
    await waitUntil(() => stack.pendingForBridge() >= 1, 'the relay to hold the tap for the Mac')
  })

  await test.step('the relay restarts with the tap still held (same database)', async () => {
    await stack.stopRelay()
    await stack.startRelay()
    expect(stack.pendingForBridge(), 'the held tap must survive the restart').toBeGreaterThanOrEqual(1)
  })

  const claude = await test.step('the Mac returns', async () => await stack.startBridge())
  await test.step('the agent is told PRIMARY once', async () => {
    const act = await claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id, 60_000)
    expect(act.meta).toMatchObject({ card_action: 'primary', trust: 'owner' })
    await waitUntil(() => stack.pendingForBridge() === 0, 'the Mac to acknowledge everything')
    await page.waitForTimeout(1500)
    expect(claude.notifications.filter((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)).toHaveLength(1)
  })
})
