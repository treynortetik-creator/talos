import type { Browser, BrowserContext, Page } from '@playwright/test'
import {
  enrollDevice,
  expect,
  openThread,
  recordWire,
  sentFrames,
  signedIn,
  test,
  waitUntil,
} from '../harness/fixtures.ts'
import type { Stack } from '../harness/stack.ts'

// The Run button, end to end: the real relay, the real bridge (which alone decides whether a tap counts) and the real app.
// The agent is FakeClaude with its automatic replies off, so the only thing that reaches it is what the Mac hands over.

const SCRIPT = 'echo hello from Alex Example\nls -la ~/notes\n'
const RUN_LINE = `Run exactly this:\n\n\`\`\`sh\n${SCRIPT}\`\`\``
const POST = `Cleanup for Alex Example:\n\n\`\`\`sh\n${SCRIPT}\`\`\`\n`

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** A message id whose ULID time is `ms`, the way the agent's own messages are named. */
function messageIdAt(ms: number): string {
  let t = ms
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = crockford[t % 32] + time
    t = Math.floor(t / 32)
  }
  let rand = ''
  for (let i = 0; i < 16; i++) rand += crockford[Math.floor(Math.random() * 32)]
  return `m_${time}${rand}`
}

const opened: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()))
})

/** The Mac's agent notifications that carry the owner's Run (`run="tap"`). */
const runNotes = (stack: Stack) => stack.claude.notifications.filter((n) => n.meta.run === 'tap')

async function agentPosts(stack: Stack, text: string): Promise<void> {
  const res = await stack.claude.callTool('reply', { thread_id: 'general', text })
  expect(res.isError).toBeFalsy()
}

async function twoDevices(stack: Stack, page: Page, context: BrowserContext, browser: Browser) {
  await stack.startBridge({ autoReply: false })
  recordWire(page)
  await enrollDevice(stack, page, context)
  await openThread(page, 'General')
  const ctxB = await browser.newContext()
  opened.push(ctxB)
  const pageB = await ctxB.newPage()
  recordWire(pageB)
  await enrollDevice(stack, pageB, ctxB, { label: 'tablet' })
  await openThread(pageB, 'General')
  return pageB
}

test('13. Run: one tap hands the agent exactly that script once; a second tap and a second device get the plain refusal', async ({
  stack,
  page,
  context,
  browser,
}) => {
  const pageB = await twoDevices(stack, page, context, browser)
  await agentPosts(stack, POST)

  const blockA = page.getByTestId('msg-agent').filter({ hasText: 'Cleanup for Alex Example' })
  const blockB = pageB.getByTestId('msg-agent').filter({ hasText: 'Cleanup for Alex Example' })
  await expect(blockA.getByTestId('run-button')).toBeVisible()
  await expect(blockB.getByTestId('run-button')).toBeVisible()

  // First tap, device A: a plain script is one tap. The agent gets the owner's own Run message, and it is marked `tap`.
  await blockA.getByTestId('run-button').click()
  await expect(blockA.getByTestId('run-status')).toHaveText(/^Sent to your Mac/)
  const note = await stack.claude.waitForNotification((n) => n.meta.run === 'tap')
  expect(note.content).toBe(RUN_LINE)
  expect(note.meta).toMatchObject({ thread_id: 'general', trust: 'owner', kind: 'text', run: 'tap' })
  // What the app signed names this very block, and the script is the one the agent posted, not anything else.
  const signed = sentFrames(page, 'message').filter((f) => f.json.intent === 'run')
  expect(signed).toHaveLength(1)
  expect(signed[0]?.json.text).toBe(RUN_LINE)
  expect(signed[0]?.json.run_block).toEqual({ message_id: expect.stringMatching(/^m_/), index: 0 })

  // Second tap of the same block: the app cannot send it again from this screen, so reload it, which shows Run again
  // (the Mac, not the screen, is the guard) and tap once more.
  await page.reload()
  await openThread(page, 'General')
  const again = page.getByTestId('msg-agent').filter({ hasText: 'Cleanup for Alex Example' })
  await again.getByTestId('run-button').click()
  const refusal = 'That Run was not run: that block was already tried.'
  const refusals = (p: Page) => p.getByRole('status').filter({ hasText: refusal })
  await expect(refusals(page)).toHaveCount(1)

  // The same block from the second device: refused with the same plain line.
  await blockB.getByTestId('run-button').click()
  // The thread is shared, so each device ends up with both refusals: the first device's and its own.
  await expect(refusals(pageB)).toHaveCount(2)
  await expect(refusals(page)).toHaveCount(2)

  // The agent heard of the Run exactly once, and hears nothing of the refusals.
  expect(runNotes(stack)).toHaveLength(1)
  expect(
    stack.claude.notifications.filter((n) => typeof n.content === 'string' && n.content.includes('was not run')),
  ).toHaveLength(0)
  // Both refusals are on the Mac's record, with no script text in the log.
  await waitUntil(() => (stack.bridgeLog().match(/run refused/g) ?? []).length >= 2, 'both refusals in the bridge log')
  expect(stack.bridgeLog()).not.toContain('hello from Alex Example')
})

test('13. Run: a block over seven days old is refused with the plain line and nothing reaches the agent', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  // The Mac reads a block's age from its message id. An agent message carrying an id just over the 7-day limit reaches the
  // app through the relay (the relay stands in for a stale history), and the app offers Run on it like any other. One hour
  // past 7 days pins the limit itself, which sits a day inside the bridge's 8-day memory of blocks already run.
  const oldId = messageIdAt(stack.now() - 7 * 24 * 3600_000 - 3600_000)
  await stack.relay.services.bus.toApps(
    {
      type: 'reply',
      message: {
        id: oldId,
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        format: 'markdown',
        text: POST,
        attachments: [],
        via: 'app',
        created_at: new Date(stack.now() - 8 * 24 * 3600_000).toISOString(),
      },
    },
    { durable: true },
  )
  const block = page.getByTestId('msg-agent').filter({ hasText: 'Cleanup for Alex Example' })
  await expect(block.getByTestId('run-button')).toBeVisible()
  await block.getByTestId('run-button').click()
  await expect(page.getByText('That script is over a week old. Ask me to post it again.')).toBeVisible()
  expect(runNotes(stack)).toHaveLength(0)
  expect(stack.claude.notifications.filter((n) => n.meta.run !== undefined)).toHaveLength(0)

  // The control: a fresh block from the agent runs, so the refusal above was about the age and nothing else.
  await stack.claude.callTool('reply', { thread_id: 'general', text: POST })
  const fresh = page.getByTestId('msg-agent').filter({ hasText: 'Cleanup for Alex Example' }).last()
  await fresh.getByTestId('run-button').click()
  await stack.claude.waitForNotification((n) => n.meta.run === 'tap')
  expect(runNotes(stack)).toHaveLength(1)
})
