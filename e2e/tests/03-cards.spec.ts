import { card, cardIdFrom, expect, HIGH_RISK_CARD, LOW_RISK_CARD, signedIn, test } from '../harness/fixtures.ts'

test('4. a high-risk card needs the passkey step-up, then the agent is told PRIMARY and reports the result', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const made = await stack.claude.callTool('card', { ...HIGH_RISK_CARD })
  expect(made.isError).toBeFalsy()
  const id = cardIdFrom(made)
  const article = card(page, id)
  await expect(article.getByRole('button', { name: /Publish/ })).toBeVisible()
  await article.getByRole('button', { name: /Publish/ }).click() // step-up: the virtual authenticator answers
  const act = await stack.claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)
  expect(act.meta).toMatchObject({ card_action: 'primary', trust: 'owner' })
  // FakeClaude answers card_result ok; the bridge tells the relay; the card collapses.
  await expect(article.getByTestId('collapse-line')).toHaveText(/^✓ Published/)
  await expect(article.getByRole('button', { name: /^(Publish|Kill publish)$/ })).toHaveCount(0)
})

test('6. kill: the agent is told KILL and nothing is run', async ({ stack, page, context }) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...LOW_RISK_CARD }))
  const article = card(page, id)
  await article.getByRole('button', { name: 'Keep the long one' }).click()
  const act = await stack.claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)
  expect(act.meta.card_action).toBe('kill')
  await expect(article.getByTestId('collapse-line')).toHaveText(/^✕ Killed/)
  await expect(article.getByRole('button', { name: /^(Yes, shorter|Keep the long one)$/ })).toHaveCount(0)
  // No card_result was ever called for a killed card.
  expect(stack.claude.toolCalls.filter((t) => t.name === 'card_result')).toHaveLength(0)
})
