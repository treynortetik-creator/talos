// Journey: the connection is gone, the owner sends a message, the app is killed at once (no pagehide, so the 250 ms
// snapshot debounce in socketClient.ts never fires), and the owner reopens it. The message must reach the agent exactly
// once; and while the app is dead and the relay and Mac are back, nothing arrives. The connection is cut by stopping
// the relay: `context.setOffline(false)` after a crash makes Chromium close the new tab.
import { expect, killApp, openThread, sendText, signedIn, test, waitUntil } from '../../harness/fixtures.ts'

const TEXT = 'queued then killed'
const mine = (n: { content?: string }) => n.content === TEXT

test('queue-kill-reopen: a message queued offline survives a hard kill and is delivered once after reopening', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const origin = new URL(page.url()).origin

  await test.step('go offline and send', async () => {
    await stack.stopRelay()
    await sendText(page, TEXT)
    await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toBeVisible()
  })

  const back = await test.step('kill the app at once', async () => await killApp(page, context))

  // The relay is back and the Mac has reconnected, but the app is still dead: the dead app must have delivered nothing
  // (the relay was down when the owner sent, so any earlier arrival would mean the queue sent it some other way).
  await test.step('the relay and the Mac are back; the dead app has delivered nothing', async () => {
    await stack.startRelay()
    await waitUntil(() => stack.relay.services.bus.bridgeOnline(), 'the Mac to reconnect', 60_000)
    await new Promise((r) => setTimeout(r, 1500)) // a live app would reconnect and flush its queue within this
    expect(stack.claude.notifications.filter(mine)).toHaveLength(0)
  })

  await test.step('reopen the app', async () => {
    await back.goto(`${origin}/t/general`)
    await openThread(back, 'General')
  })

  await test.step('the message is still there, is delivered, and gets its answer', async () => {
    await stack.claude.waitForNotification(mine, 60_000)
    await expect(back.getByTestId('msg-agent').filter({ hasText: `ack: ${TEXT}` })).toBeVisible({ timeout: 30_000 })
    await expect(back.getByTestId('msg-owner').filter({ hasText: TEXT })).toHaveCount(1)
    await expect(back.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toHaveCount(0)
  })

  await test.step('and only once', async () => {
    await back.waitForTimeout(1500)
    expect(stack.claude.notifications.filter(mine)).toHaveLength(1)
  })
})

test('queue-kill-reopen (no kill, control): the same send and a plain reload also delivers once', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await context.setOffline(true)
  stack.dropAppSockets()
  await expect(page.getByText(/You're offline/)).toBeVisible()
  await sendText(page, TEXT)
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toBeVisible()
  await context.setOffline(false)
  await page.reload()
  await stack.claude.waitForNotification(mine, 60_000)
  await page.waitForTimeout(1500)
  expect(stack.claude.notifications.filter(mine)).toHaveLength(1)
})
