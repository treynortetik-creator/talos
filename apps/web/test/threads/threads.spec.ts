import { expect, test } from '@playwright/test'
import { closePhoneMenu, expectPurpose, openThreadSettings } from '../helpers/phone.ts'

// Fake mode (VITE_FAKE=1). Screenshots land in test-results/shots/threads/<project>-*.png; with TALOS_SHOTS=1 they replace the
// committed ones in test/threads/shots (as manage.spec.ts does), so an ordinary run never rewrites tracked files.
const SHOTS = process.env.TALOS_SHOTS ? 'test/threads/shots' : 'test-results/shots/threads'
const shot = (name: string, project: string) => `${SHOTS}/${project}-${name}.png`

test('threads list explains itself, creates and shows notify state', async ({ page }, info) => {
  await page.goto('/threads')
  await expect(page.getByTestId('threads-explainer')).toContainText('Threads keep topics apart')
  await expect(page.getByTestId('notify-general')).toBeVisible()
  await page.screenshot({ path: shot('list', info.project.name) })
  await page.locator('main').getByTestId('new-thread').click()
  await page.getByTestId('thread-settings').getByLabel('Name').fill('Trip planning')
  await page.getByRole('button', { name: 'Create thread' }).click()
  await expect(page.getByTestId('thread-row-trip_planning')).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss explanation' }).click()
  await expect(page.getByTestId('threads-explainer')).toHaveCount(0)
})

test('an empty thread explains itself; settings set notify and the note', async ({ page }, info) => {
  await page.goto('/threads')
  await page.locator('main').getByTestId('new-thread').click()
  await page.getByTestId('thread-settings').getByLabel('Name').fill('Empty topic')
  await page.getByRole('button', { name: 'Create thread' }).click()
  await page.getByTestId('thread-row-empty_topic').click()
  await expect(page.getByTestId('thread-empty-explainer')).toContainText('A thread is one topic')
  await page.screenshot({ path: shot('empty', info.project.name) })
  await openThreadSettings(page)
  await page.getByRole('button', { name: 'Needs you only' }).click()
  await page.getByLabel('What goes here').fill('Notes for the trip')
  await page.screenshot({ path: shot('settings', info.project.name) })
  await page.getByRole('button', { name: 'Save' }).click()
  await closePhoneMenu(page)
  await expectPurpose(page, 'Notes for the trip')
})

test('settings sheet stays inside a 375px viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto('/t/general')
  await openThreadSettings(page)
  const box = await page.getByTestId('thread-settings').boundingBox()
  expect(box).not.toBeNull()
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375)
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(667)
  await page.screenshot({ path: shot('settings-375', info.project.name) })
})
