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
  // No step-up since 2026-11-14 (the owner: zero Face ID approvals): the signed tap alone approved a high-risk card.
  expect(stepups).toEqual([])

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
