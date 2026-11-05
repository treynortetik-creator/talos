import { expect, openThread, sendText, sendVoiceNote, signedIn, test } from '../harness/fixtures.ts'

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
  await openThread(page, 'Errands')
  await sendText(page, 'over here')
  const other = await stack.claude.waitForNotification((n) => n.content === 'over here')
  expect(other.meta.thread_id).toBe('errands')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: over here' })).toBeVisible()
  await openThread(page, 'General')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: over here' })).toHaveCount(0)
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: hello' })).toBeVisible()
})

test('3. voice note round trip: transcript under the bubble, the agent gets the transcript, a spoken reply plays', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await sendVoiceNote(page)
  const note = await stack.claude.waitForNotification((n) => n.meta.kind === 'voice_note')
  expect(note.content).toBe('hello from the stub transcriber')
  expect(note.meta).toMatchObject({ thread_id: 'general', trust: 'owner' })
  await expect(page.getByTestId('voice-note').getByText('hello from the stub transcriber')).toBeVisible()
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: hello from the stub transcriber' })).toBeVisible()

  // The agent answers with voice: the bridge runs the (stub) TTS command and attaches the audio.
  const res = await stack.claude.callTool('reply', { thread_id: 'general', text: 'Spoken answer', voice: true })
  expect(res.isError).toBeFalsy()
  const audio = page.getByTestId('audio').first()
  await expect(audio).toBeVisible()
  const src = await audio.locator('audio').getAttribute('src')
  expect(src).toBeTruthy()
  const media = await page.request.get(new URL(src as string, page.url()).href)
  expect(media.status()).toBe(200)
  expect(media.headers()['content-type']).toBe('audio/mpeg')
})
