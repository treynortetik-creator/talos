// Settings → Agent recovery at 375 px wide: Restart is on screen, big enough to tap, do not push the page sideways,
// and still work after a failed attempt and with the Mac offline.
import { expect, type Page, test } from '@playwright/test'
import { RECOVER_SENT_TEXT } from '@talos-app/protocol'
import { open, sentFrames } from '../cards/e2e.ts'

test.use({ viewport: { width: 375, height: 667 } })

const BUTTONS = ['Restart agent']
const NOTE = 'To put back the last good setup, use the Talos menu on your Mac: Restore last good setup.'

async function expectTappable(page: Page) {
  for (const name of BUTTONS) {
    const b = page.getByRole('button', { name })
    await b.scrollIntoViewIfNeeded()
    await expect(b).toBeVisible()
    await expect(b).toBeEnabled()
    const box = await b.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375)
  }
  await expect(page.getByRole('button', { name: /restore/i })).toHaveCount(0)
  await expect(page.getByText(NOTE)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('the button is tappable, and Restart sends one recover frame', async ({ page }) => {
  await open(page, '/settings/agent')
  await expectTappable(page)
  await page.getByRole('button', { name: 'Restart agent' }).click()
  await expect(page.getByText(RECOVER_SENT_TEXT)).toBeVisible()
  const frames = (await sentFrames(page)).filter((f) => f.type === 'agent.recover')
  expect(frames).toHaveLength(1)
  expect(frames[0]).toMatchObject({ action: 'restart' })
})

test('failed state: the Mac’s refusal is shown and the button stays tappable', async ({ page }) => {
  await open(page, '/settings/agent')
  await page.evaluate(() => window.__talos.failNextRecoverWith('There is no saved setup to put back.'))
  await page.getByRole('button', { name: 'Restart agent' }).click()
  await expect(page.getByRole('alert')).toContainText('no saved setup')
  await expectTappable(page)
  await page.getByRole('button', { name: 'Restart agent' }).click() // a second try works
  await expect(page.getByText(RECOVER_SENT_TEXT)).toBeVisible()
})

test('offline state: the button is there and the screen says recovery needs the Mac app', async ({ page }) => {
  await open(page, '/settings/agent', { offline: true })
  await expect(page.getByTestId('agent-recover-offline')).toContainText('Recovery needs the Mac app running')
  await expectTappable(page)
  await page.getByRole('button', { name: 'Restart agent' }).click()
  await expect(page.getByRole('alert')).toContainText('Recovery needs the Mac app running')
  expect((await sentFrames(page)).filter((f) => f.type === 'agent.recover')).toHaveLength(0)
})
