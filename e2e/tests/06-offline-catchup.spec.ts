import { expect, openThread, sendText, signedIn, test } from '../harness/fixtures.ts'

test('8a. offline: the message waits in the outbox and is delivered exactly once on reconnect', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await context.setOffline(true)
  stack.dropAppSockets() // setOffline may already have closed it
  await expect(page.getByText(/You're offline/)).toBeVisible()
  await sendText(page, 'sent while offline')
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toBeVisible()
  expect(stack.claude.notifications.filter((n) => n.content === 'sent while offline')).toHaveLength(0)
  await context.setOffline(false)
  const retry = page.getByRole('button', { name: /^Retry/ })
  if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => {})
  await stack.claude.waitForNotification((n) => n.content === 'sent while offline', 20_000)
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: sent while offline' })).toBeVisible()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(stack.claude.notifications.filter((n) => n.content === 'sent while offline')).toHaveLength(1)
})

test('8b. a reload with a stale last_seq catches up on everything it missed, and an open card is re-rendered', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  // Close the app, let the agent talk and raise a card, then open it again from a cold start.
  const origin = new URL(page.url()).origin
  await page.close()
  await stack.claude.callTool('reply', { thread_id: 'general', text: 'while you were away 1' })
  await stack.claude.callTool('reply', { thread_id: 'general', text: 'while you were away 2' })
  const made = await stack.claude.callTool('card', {
    thread_id: 'general',
    kind: 'decision',
    title: 'Still open?',
    primary_label: 'Yes',
    kill_label: 'No',
    risk: 'low',
    origin: 'chat',
  })
  const id = /\bc_[0-9A-HJKMNP-TV-Z]{26}\b/.exec(made.content[0]?.text ?? '')?.[0] as string
  const back = await context.newPage()
  await back.goto(`${origin}/t/general`)
  await expect(back.getByTestId('msg-agent').filter({ hasText: 'while you were away 1' })).toBeVisible()
  await expect(back.getByTestId('msg-agent').filter({ hasText: 'while you were away 2' })).toBeVisible()
  await expect(back.locator(`[data-card-id="${id}"]`).getByRole('button', { name: 'Yes' })).toBeVisible()
  await openThread(back, 'General')
})
