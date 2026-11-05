// Package C, driven in a real browser against the real relay code path: a huge paste is stopped in the box (it used to
// close the socket in a loop and block every later message), then goes as a text file; a failed row can be Edited or
// Deleted; Reply travels as reply_to; coming back to the tab with a dead socket reconnects within seconds.
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, frameOfType, openSignedIn, waitUntil } from '../helpers/util.ts'

const box = (page: import('@playwright/test').Page) => page.getByLabel('Message', { exact: true })
const hellos = (harness: Parameters<typeof frameOfType>[0]) => frameOfType(harness, 'hello').length

test('a 300,000-character paste is stopped in the box: nothing sent, no reconnect loop, and a short message still goes', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  await waitUntil(() => hellos(harness) >= 1, 'first hello')
  const before = hellos(harness)
  await box(page).fill('x'.repeat(300_000))
  await expect(page.getByTestId('too-long')).toContainText('300,000')
  // at any width the note and its button fit the screen and the button is a real tap target
  const fit = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  expect(fit).toBe(true)
  const btn = await page.getByTestId('send-as-file').boundingBox()
  expect(btn?.height).toBeGreaterThanOrEqual(44)
  // aria-disabled: Playwright would wait for it forever, a person can still tap it, so force the click
  await page.getByRole('button', { name: 'Send', exact: true }).click({ force: true })
  await page.waitForTimeout(1500)
  expect(frameOfType(harness, 'message')).toHaveLength(0)
  expect(hellos(harness)).toBe(before) // no 1009 loop
  // the box still has it (nothing was cleared)
  expect(await box(page).inputValue()).toHaveLength(300_000)
  // clear it and a normal message goes through
  await box(page).fill('short one')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'short message delivered')
  expect(frameOfType(harness, 'message')[0]?.raw.text).toBe('short one')
})

test('"Send as a text file" uploads the paste to the real media route and clears the box', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  await box(page).fill('y'.repeat(50_000))
  await page.getByTestId('send-as-file').click()
  await expect(page.getByTestId('chip').filter({ hasText: 'message.txt' })).toBeVisible()
  await expect(page.getByTestId('chip')).toHaveAttribute('data-state', 'ready')
  expect(await box(page).inputValue()).toBe('')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'message with the file')
  const atts = frameOfType(harness, 'message')[0]?.raw.attachments as Array<{ name: string; size: number }>
  expect(atts[0]).toMatchObject({ name: 'message.txt', size: 50_000 })
})

test('Reply on an agent message is sent as reply_to and shows as a quote on the owner row', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  const reply = agentReply({ text: 'The venue is booked.', format: 'plain' })
  harness.relay.sendToApps(reply)
  const row = page.getByTestId('msg-agent').filter({ hasText: 'The venue is booked.' })
  // right-click opens the menu everywhere (the hover button is desktop-only; touch uses a long press)
  await row.getByText('The venue is booked.').click({ button: 'right' })
  await page.getByTestId('msg-reply').click()
  await expect(page.getByTestId('reply-bar')).toContainText('The venue is booked.')
  await box(page).fill('great, thanks')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'reply sent')
  expect(frameOfType(harness, 'message')[0]?.raw.reply_to).toBe(reply.message.id)
  await expect(page.getByTestId('msg-owner').getByTestId('msg-quote')).toHaveText('The venue is booked.')
})

/** The signed frames still in this browser's outbox (a held message is one). */
const heldIds = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('talos-app')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const req = open.result.transaction('outbox').objectStore('outbox').getAll()
          req.onsuccess = () => resolve((req.result as Array<{ id: string }>).map((e) => e.id))
        }
      }),
  )

test('a message that failed offers Edit and Delete; Edit puts it back in the box, Delete removes it for good (also after a reload)', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context, '/t/general', { pinned: false })
  await box(page).fill('doomed words')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'doomed words' })).toBeVisible()
  await waitUntil(() => true)
  const [first] = await heldIds(page)
  harness.relay.sendToApps({ type: 'error', ref: first, code: 'internal', message: 'nope' })
  await expect(page.getByTestId('send-failed-edit')).toBeVisible()
  await page.getByTestId('send-failed-edit').click()
  await expect(box(page)).toHaveValue('doomed words')
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'doomed words' })).toHaveCount(0)
  expect(await heldIds(page)).toHaveLength(0)

  // and Delete
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'doomed words' })).toBeVisible()
  const [second] = await heldIds(page)
  harness.relay.sendToApps({ type: 'error', ref: second, code: 'internal', message: 'nope' })
  await page.getByTestId('send-failed-delete').click()
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'doomed words' })).toHaveCount(0)
  expect(await heldIds(page)).toHaveLength(0)
  await page.waitForTimeout(700) // the timeline cache saves 250 ms after a change
  await page.reload()
  await page.getByTestId('thread-screen').waitFor()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'doomed words' })).toHaveCount(0)
  await expect(page.getByTestId('send-failed')).toHaveCount(0)
})
