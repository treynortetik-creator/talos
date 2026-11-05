import { loadFrameFixture } from '@talos-app/testkit'
import { card, cardIdFrom, expect, HIGH_RISK_CARD, rawSocket, sentFrames, signedIn, test } from '../harness/fixtures.ts'

test('5. a replayed card.resolve (same bytes, new socket) changes nothing and reaches the agent once', async ({
  stack,
  page,
  context,
}) => {
  const stepups: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/auth/stepup/')) stepups.push(`${r.method()} ${new URL(r.url()).pathname}`)
  })
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...HIGH_RISK_CARD }))
  await card(page, id)
    .getByRole('button', { name: /^Publish/ })
    .click()
  await stack.claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)
  await expect(card(page, id).getByTestId('collapse-line')).toHaveText(/^✓ Published/)
  // The step-up was a real passkey ceremony against the relay, not a client-side flag.
  expect(stepups).toEqual(['POST /api/auth/stepup/options', 'POST /api/auth/stepup/verify'])

  const hello = sentFrames(page, 'hello')[0]
  const resolve = sentFrames(page, 'card.resolve')[0]
  if (!hello || !resolve) throw new Error('did not capture the frames')
  const seenBefore = stack.claude.notifications.filter((n) => n.meta.kind === 'card_action').length

  const replies = await rawSocket(page, [hello.text, resolve.text])
  const answer = replies.find((f) => f.ref === resolve.json.id)
  // Either an idempotent ack of the original sequence number or an explicit refusal; never a second delivery.
  expect(answer && ['ack', 'error'].includes(String(answer.type))).toBe(true)
  await page.waitForTimeout(1500)
  expect(stack.claude.notifications.filter((n) => n.meta.kind === 'card_action')).toHaveLength(seenBefore)
  expect(stack.claude.toolCalls.filter((t) => t.name === 'card_result')).toHaveLength(1)
  await expect(card(page, id).getByTestId('collapse-line')).toHaveText(/^✓ Published/)

  // The same replay after a bridge restart: the Mac remembers the frame ids it has seen.
  await stack.stopBridge()
  await stack.startBridge()
  await rawSocket(page, [hello.text, resolve.text])
  await page.waitForTimeout(1500)
  expect(stack.claude.notifications.filter((n) => n.meta.kind === 'card_action')).toHaveLength(0)
})

test('voice.ask from an app is never forwarded to the bridge (only the voice module emits it)', async ({
  stack,
  page,
  context,
}) => {
  const dev = await signedIn(stack, page, context)
  const hello = sentFrames(page, 'hello')[0]
  if (!hello) throw new Error('no hello captured')
  const ask: Record<string, unknown> = { ...loadFrameFixture('voice.ask'), device_id: dev.deviceId }
  const replies = await rawSocket(page, [hello.text, JSON.stringify(ask)])
  const refused = replies.find((f) => f.ref === ask.id)
  expect(refused?.type).toBe('error')
  await page.waitForTimeout(800)
  expect(stack.claude.notifications.filter((n) => n.meta.kind === 'voice_delegation')).toHaveLength(0)
  const queued = stack.relay.services.db
    .prepare("select count(*) as n from core_events where type = 'voice.ask'")
    .get() as { n: number }
  expect(queued.n).toBe(0)
})
