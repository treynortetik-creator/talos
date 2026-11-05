import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, sentFrames, signedIn, test } from '../harness/fixtures.ts'
import { type Stack, startStack, waitUntil } from '../harness/stack.ts'

// One-touch dictation, end to end: the real browser records the fake microphone, the built relay sends the recording to an
// OpenAI-shaped endpoint (a stand-in on a free local port, so no real OpenAI is ever called) and the words come back into
// the message box. Nothing is sent until the owner taps Send.

const WORDS = 'Lunch with Alex Example at noon, then email alex@example.com the notes.'
const KEY = 'sk-test-not-a-real-key'
const MIB = 1024 * 1024

type Call = { auth: string | undefined; type: string | undefined; bytes: number; path: string }
let stack: Stack
let live: Stack | undefined // set only once a stack really started, so afterEach never stops one that failed to boot
let stub: Server | undefined
const calls: Call[] = []

test.beforeEach(async () => {
  calls.length = 0
  stub = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      calls.push({
        auth: req.headers.authorization,
        type: req.headers['content-type']?.split(';')[0],
        bytes: Buffer.concat(chunks).length,
        path: req.url ?? '',
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ text: WORDS }))
    })
  })
  const server = stub
  // listen on port 0 and read the port back, so no other worker can take it in between
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stand-in OpenAI server has no port')
  const port = address.port
  live = undefined
  stack = await startStack({
    env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, DICTATE_DAILY_MAX_MB: '1' },
  })
  live = stack
})
test.afterEach(async () => {
  await live?.stop()
  live = undefined
  const server = stub
  stub = undefined
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Starts dictating and stops once the recorder has run for a moment (the timer moves off 0:00), which is a condition, not a pause. */
async function dictate(page: Page): Promise<void> {
  await page.getByTestId('dictate').click()
  const strip = page.getByTestId('dictate-recording')
  await expect(strip).toBeVisible()
  await expect(strip.locator('.font-mono')).not.toHaveText('0:00')
  await page.getByTestId('dictate').click()
}

test('14. dictation: the words land in the message box after the stop and nothing is sent until Send', async ({
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const box = page.getByLabel('Message', { exact: true })
  await box.fill('Notes:')
  await dictate(page)

  await expect(page.getByTestId('dictate-done')).toContainText('Added to your message. Check it, then send.')
  await expect(box).toHaveValue(`Notes: ${WORDS}`)

  // One recording reached the transcription endpoint, with the relay's key, and the relay logged lengths and no words.
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ auth: `Bearer ${KEY}`, path: '/v1/audio/transcriptions' })
  expect(calls[0]?.type).toBe('multipart/form-data')
  expect(calls[0]?.bytes).toBeGreaterThan(0)
  expect(stack.relayLog.join('\n')).not.toContain('Lunch with Alex')

  // Nothing was sent: no message frame left the app and the agent has heard nothing.
  expect(sentFrames(page, 'message')).toHaveLength(0)
  expect(stack.claude.notifications.filter((n) => n.meta.kind === 'text')).toHaveLength(0)
  await expect(page.getByTestId('msg-owner')).toHaveCount(0)

  // Send is the owner's own tap, and the agent gets exactly the box as it stood.
  await page.getByTestId('composer').getByRole('button', { name: 'Send', exact: true }).click()
  const note = await stack.claude.waitForNotification((n) => n.content === `Notes: ${WORDS}`)
  expect(note.meta).toMatchObject({ thread_id: 'general', trust: 'owner', kind: 'text' })
  expect(sentFrames(page, 'message')).toHaveLength(1)
})

test('14. dictation: when the day’s limit is used up the strip says so and the recording is not sent anywhere', async ({
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  // Today's allowance (1 MB here) has been spent by earlier recordings.
  stack.relay.services.db
    .prepare('insert into voice_dictation_usage (at, bytes) values (?, ?)')
    .run(stack.now() - 3600_000, MIB)
  const box = page.getByLabel('Message', { exact: true })
  await box.fill('Draft for Alex Example')
  await dictate(page)

  await expect(page.getByTestId('dictate-failed')).toContainText(
    "Today's dictation limit is used up. Send it as a voice note, or try again later.",
  )
  await expect(box).toHaveValue('Draft for Alex Example')
  // The app offers the voice note, and not a retry that could not work.
  await expect(page.getByRole('button', { name: 'Send as voice note' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await waitUntil(
    () => stack.relayLog.some((l) => l.includes('dictate refused: daily cap')),
    'the cap refusal in the relay log',
  )
  expect(calls).toHaveLength(0)
  expect(sentFrames(page, 'message')).toHaveLength(0)
})
