// An attachment upload that never answers must not lock the message box (the owner, 2026-11-20 03:22: text and a photo in the
// box, no Send, Enter did nothing, a reload fixed it). The real relay and bridge; the browser's request to /api/media is held
// with no answer, as a lost request or a relay hiccup would leave it.
import { expect, signedIn, test } from '../harness/fixtures.ts'

test('a stalled photo upload: Enter says it is waiting, the chip gives up with Retry, and Retry then sends', async ({
  stack,
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await signedIn(stack, page, context)
  const composer = page.getByTestId('composer')
  const box = page.getByLabel('Message', { exact: true })
  const chip = composer.getByTestId('chip')
  const send = composer.getByRole('button', { name: 'Send', exact: true })

  // the upload request goes out and never gets an answer
  await page.route('**/api/media', () => {})
  await box.fill('look at this')
  await page
    .getByTestId('pick-files')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.alloc(4096, 7) })
  await expect(chip).toHaveAttribute('data-state', 'uploading')
  await expect(send).toHaveAttribute('aria-disabled', 'true')
  await box.press('Enter')
  await expect(composer.getByTestId('composer-note')).toHaveText(/Waiting for the upload/)
  await expect(box).toHaveValue('look at this')

  // no answer within the stall time: the chip gives up, says so, and offers Retry
  await expect(chip).toHaveAttribute('data-state', 'error', { timeout: 60_000 })
  await expect(chip.getByTestId('chip-status')).toHaveText(/no answer/)
  await expect(composer.getByTestId('composer-note')).toHaveCount(0)

  // the network is back: Retry uploads it, and Enter sends the words with the photo
  await page.unroute('**/api/media')
  await chip.getByTestId('chip-retry').click()
  await expect(chip).toHaveAttribute('data-state', 'ready')
  await box.press('Enter')
  const note = await stack.claude.waitForNotification((n) => n.content === 'look at this', 15_000)
  expect(note.meta.thread_id).toBe('general')
  expect(stack.claude.notifications.filter((n) => n.content === 'look at this')).toHaveLength(1)
})
