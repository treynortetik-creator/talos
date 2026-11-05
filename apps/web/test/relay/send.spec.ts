import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, clickRetryIfShown, frameOfType, openSignedIn, sigOk, waitUntil } from '../helpers/util.ts'

test('send text: the relay gets a message whose osig verifies on the RAW json, with attachments: []', async ({
  page,
  context,
  harness,
}) => {
  const dev = await openSignedIn(harness, page, context)
  await page.getByLabel('Message', { exact: true }).fill('Draft the release notes')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'message frame')
  const rec = frameOfType(harness, 'message')[0]
  if (!rec) throw new Error('no frame')
  expect(rec.raw.attachments).toEqual([])
  expect(rec.text).toContain('"attachments":[]')
  expect(rec.raw.device_id).toBe(dev.deviceId)
  expect(rec.raw.thread_id).toBe('general')
  expect(await sigOk(rec.raw, dev.publicJwk)).toBe(true)
  // The same bytes with one field altered must not verify.
  expect(await sigOk({ ...rec.raw, text: 'Something else' }, dev.publicJwk)).toBe(false)
  // The owner's row appears and is acked as sent.
  await expect(page.getByTestId('msg-owner').filter({ hasText: 'Draft the release notes' })).toBeVisible()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toBeVisible()
})

test('a reply from the agent renders and announces itself', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: 'Done. **Three** sections.' }))
  await expect(page.getByTestId('msg-agent').locator('strong')).toHaveText('Three')
  await expect(page.getByRole('log')).toContainText('Done.')
})

test('offline send queues, then the identical signed bytes deliver exactly once on reconnect', async ({
  page,
  context,
  harness,
}) => {
  const dev = await openSignedIn(harness, page, context)
  harness.blockWs(true)
  harness.dropAppSockets()
  await expect(page.getByText(/Can't reach your server/)).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('sent while the server was away')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toBeVisible()
  expect(frameOfType(harness, 'message')).toHaveLength(0)

  // The signed bytes are in IndexedDB.
  const stored = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('talos-app')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const req = open.result.transaction('outbox').objectStore('outbox').getAll()
          req.onsuccess = () => resolve((req.result as Array<{ bytes: string }>).map((e) => e.bytes))
        }
      }),
  )
  expect(stored).toHaveLength(1)

  harness.blockWs(false)
  await clickRetryIfShown(page)
  await waitUntil(() => frameOfType(harness, 'message').length >= 1, 'delivery after reconnect', 15_000)
  await page.waitForTimeout(500)
  const delivered = frameOfType(harness, 'message')
  expect(delivered).toHaveLength(1)
  expect(delivered[0]?.text).toBe(stored[0])
  expect(await sigOk((delivered[0] as { raw: Record<string, unknown> }).raw, dev.publicJwk)).toBe(true)
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toBeVisible()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Waiting to send' })).toHaveCount(0)
})

test('a frame held for an unpinned device is not sent until the Mac pins it', async ({ page, context, harness }) => {
  const dev = await openSignedIn(harness, page, context, '/t/general', { pinned: false })
  await expect(page.getByText('Waiting for your Mac to confirm this device.').first()).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('hold me')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForTimeout(400)
  expect(frameOfType(harness, 'message')).toHaveLength(0)
  harness.pinDevice(dev.deviceId, true)
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'held frame delivered after pin')
  await expect(page.getByText('Waiting for your Mac to confirm this device.')).toHaveCount(0)
})
