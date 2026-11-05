// Journey: the owner taps Approve while the Mac is away; the Mac comes back; the agent is told once and the card ends.
// Two more cases for a Mac that is away a long time: it returns after the card has expired (the clock of the relay and
// of the Mac jump two hours; the agent must not be told to go ahead), and an approved card whose result never comes (the
// app's own clock jumps two hours; the card must stop saying "Working on it").

import { clockEnv } from '../../harness/clock.ts'
import {
  card,
  cardIdFrom,
  enrollDevice,
  expect,
  HIGH_RISK_CARD,
  LOW_RISK_CARD,
  openThread,
  recordWire,
  signedIn,
  test,
  waitUntil,
} from '../../harness/fixtures.ts'

test.setTimeout(150_000)

test('mac-away-approve: a tap while the Mac is down reaches the agent exactly once when it returns', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...LOW_RISK_CARD }))
  const article = card(page, id)
  await expect(article.getByRole('button', { name: 'Yes, shorter' })).toBeVisible()

  await test.step('the Mac goes away and the owner taps Approve', async () => {
    await stack.crashBridge()
    await article.getByRole('button', { name: 'Yes, shorter' }).click()
    await waitUntil(() => stack.pendingForBridge() >= 1, 'the relay to hold the tap for the Mac')
  })

  const claude = await test.step('the Mac comes back', async () => await stack.startBridge())
  await test.step('the agent is told PRIMARY, once, and the card collapses', async () => {
    const act = await claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id, 60_000)
    expect(act.meta).toMatchObject({ card_action: 'primary', trust: 'owner' })
    await expect(article.getByTestId('collapse-line')).toHaveText(/^✓/, { timeout: 30_000 })
    await expect(article.getByRole('button', { name: /^(Yes, shorter|Keep the long one)$/ })).toHaveCount(0)
    await waitUntil(() => stack.pendingForBridge() === 0, 'the Mac to acknowledge everything')
    await page.waitForTimeout(1500)
    expect(claude.notifications.filter((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)).toHaveLength(1)
  })
})

test('mac-away-approve (high risk): the passkey tap made while the Mac is down still reaches the agent once', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...HIGH_RISK_CARD }))
  const article = card(page, id)
  await expect(article.getByRole('button', { name: /Publish/ })).toBeVisible()

  await test.step('the Mac goes away and the owner approves with the passkey', async () => {
    await stack.crashBridge()
    await article.getByRole('button', { name: /Publish/ }).click() // step-up: the virtual authenticator answers
    await waitUntil(() => stack.pendingForBridge() >= 1, 'the relay to hold the approval for the Mac')
  })

  const claude = await test.step('the Mac comes back', async () => await stack.startBridge())
  await test.step('the agent is told PRIMARY, once, and the card collapses', async () => {
    const act = await claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id, 60_000)
    expect(act.meta).toMatchObject({ card_action: 'primary', trust: 'owner' })
    await expect(article.getByTestId('collapse-line')).toHaveText(/^✓ Published/, { timeout: 30_000 })
    await page.waitForTimeout(1500)
    expect(claude.notifications.filter((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)).toHaveLength(1)
  })
})

const TWO_HOURS = 2 * 60 * 60 * 1000
// Long enough to pass a card's 5-minute life, short of the 10-minute rule on how long a tap may wait.
const EIGHT_MINUTES = 8 * 60 * 1000

test('mac-away-approve (stale): a tap held for a Mac that returns after the card expired is not acted on', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...LOW_RISK_CARD, expires_in_s: 300 }))
  const article = card(page, id)
  await expect(article.getByRole('button', { name: 'Yes, shorter' })).toBeVisible()

  await test.step('the Mac goes away and the owner taps Approve; the relay holds the tap', async () => {
    await stack.crashBridge()
    await article.getByRole('button', { name: 'Yes, shorter' }).click()
    await waitUntil(() => stack.pendingForBridge() >= 1, 'the relay to hold the tap for the Mac')
  })

  const claude =
    await test.step('eight minutes pass and the Mac returns: the card is expired, the tap is not yet too old', async () => {
      stack.skew.ms += EIGHT_MINUTES // the relay's clock
      return await stack.startBridge({ env: clockEnv(EIGHT_MINUTES) }) // the Mac's clock
    })

  await test.step('the agent is not told to go ahead, and the card ends as expired', async () => {
    await waitUntil(() => stack.pendingForBridge() === 0, 'the Mac to acknowledge the held tap', 60_000)
    await expect(article.getByTestId('collapse-line')).toHaveText(/Expired/, { timeout: 30_000 })
    await page.waitForTimeout(1500)
    const told = claude.notifications.filter((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)
    expect(told.map((n) => n.meta.card_action)).not.toContain('primary')
  })
})

test('mac-away-approve (no result): an approved card whose result never comes stops saying "Working on it"', async ({
  stack,
  page,
  context,
}) => {
  await page.clock.install()
  recordWire(page)
  // This agent takes the approval and never calls card_result (the fake one would, by default).
  const claude = await stack.startBridge({ autoReply: false })
  await enrollDevice(stack, page, context)
  await openThread(page, 'General')
  const id = cardIdFrom(await claude.callTool('card', { ...LOW_RISK_CARD }))
  const article = card(page, id)
  await article.getByRole('button', { name: 'Yes, shorter' }).click()
  await claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id, 30_000)

  await test.step('the agent has the approval and has reported nothing: the card says it is working', async () => {
    await expect(article.getByTestId('collapse-line')).toHaveText(/Working on it/, { timeout: 30_000 })
  })

  await test.step('two hours pass in the app: the card says no result has come', async () => {
    await page.clock.fastForward(TWO_HOURS)
    await expect(article.getByTestId('collapse-line')).toHaveText(/No result reported yet/, { timeout: 15_000 })
  })
})
