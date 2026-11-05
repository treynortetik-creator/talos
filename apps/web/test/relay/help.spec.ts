// Talos Help against the production build served by the relay harness, with the real sign-in gate and signed frames:
// readable while signed out, linked from the sign-in screen, and the Ask button leaves the sending to the owner.
import { expect, test } from '../helpers/fixtures.ts'
import { frameOfType, openSignedIn, sigOk, waitUntil } from '../helpers/util.ts'

test('signed out, Help opens without a redirect to sign-in, says Ask is not ready, and Back goes through the gate', async ({
  page,
}) => {
  const statusRequests: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/status') statusRequests.push(r.url())
  })
  await page.goto('/help')
  await expect(page.getByRole('heading', { level: 1, name: 'Talos Help' })).toBeVisible()
  await expect(page).toHaveURL(/\/help$/)
  await expect(page.getByTestId('help-ask-waiting')).toBeVisible()
  await expect(page.getByTestId('help-ask')).toHaveCount(0)
  // signed out, the build section is plain text: no red failed state, and no request for the server's status (it would only 401)
  await expect(page.getByTestId('help-build-signedout')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(statusRequests).toEqual([])
  await page.getByRole('link', { name: 'Back to settings' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('the sign-in screen links to Help', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('link', { name: 'Help' }).click()
  await expect(page).toHaveURL(/\/help$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Fix it' })).toBeVisible()
})

test('signed in: Ask fills the message box and sends nothing; the owner sends it and one signed message arrives', async ({
  page,
  context,
  harness,
}) => {
  const dev = await openSignedIn(harness, page, context, '/help')
  await page.getByRole('searchbox', { name: 'Search Help' }).fill('quiet hours')
  // a cold open of /help starts the connection too (the soft gate), and Ask waits for the config it brings
  await expect(page.getByTestId('help-ask')).toBeVisible()
  await page.getByTestId('help-ask').click()
  await expect(page).toHaveURL(/\/t\/general$/)
  const box = page.getByLabel('Message', { exact: true })
  await expect(box).toHaveValue('I need help with Talos. quiet hours')
  expect(frameOfType(harness, 'message')).toHaveLength(0)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitUntil(() => frameOfType(harness, 'message').length === 1, 'message frame')
  const rec = frameOfType(harness, 'message')[0]
  if (!rec) throw new Error('no frame')
  expect(rec.raw.text).toBe('I need help with Talos. quiet hours')
  expect(rec.raw.device_id).toBe(dev.deviceId)
  expect(await sigOk(rec.raw, dev.publicJwk)).toBe(true)
})

test('signed in: Settings ends with Help and the row opens the page', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context, '/settings')
  const rows = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')
  await expect(rows.last()).toHaveText('Help')
  await rows.last().click()
  await expect(page).toHaveURL(/\/help$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Talos Help' })).toBeVisible()
})
