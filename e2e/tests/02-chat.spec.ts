import { expect, openThread, sendText, signedIn, test } from '../harness/fixtures.ts'

test('2. a signed message reaches the agent in the right thread and the reply comes back with receipts', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await sendText(page, 'hello')
  const note = await stack.claude.waitForNotification((n) => n.content === 'hello')
  expect(note.meta).toMatchObject({ thread_id: 'general', trust: 'owner', kind: 'text' })
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: hello' })).toBeVisible()
  // The agent saw it (delivered), then answered in the thread (seen).
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: /^(Delivered|Seen)$/ })).toBeVisible()

  // A message in another thread stays in that thread.
  const made = await stack.claude.callTool('create_thread', { name: 'Errands' })
  expect(made.isError).toBeFalsy()
  // the owner spoke in General just now, so the thread is made at once (settings on request, 2026-11-14), with no card; an
  // unasked one is still a card (journeys/palette-open-thread.spec.ts)
  expect(made.content[0]?.text ?? '').toContain('created thread errands')
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)
  await openThread(page, 'Errands')
  await sendText(page, 'over here')
  const other = await stack.claude.waitForNotification((n) => n.content === 'over here')
  expect(other.meta.thread_id).toBe('errands')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: over here' })).toBeVisible()
  await openThread(page, 'General')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: over here' })).toHaveCount(0)
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: hello' })).toBeVisible()
})
