import { expect, test } from '@playwright/test'
import { checkConfigPatch } from '@talos-app/protocol'
import { expectAxeClean, open, sentFrames } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

test('an edit sends a merge patch with the current base_rev, touching only allowlisted fields', async ({ page }) => {
  await open(page, '/settings/agent')
  const rev = await page.evaluate(() => window.__talos.store.getState().config?.rev)
  await page.getByLabel('Agent name').fill('Atlas')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  const frame = (await sentFrames(page)).at(-1) as Record<string, unknown>
  expect(frame.type).toBe('config.patch')
  expect(frame.base_rev).toBe(rev)
  expect(frame.patch).toEqual({ agent: { name: 'Atlas' } })
  expect(checkConfigPatch(frame.patch).ok).toBe(true)
  expect(typeof frame.osig).toBe('string')
})

test('Thread settings has no Live-call context switch (the live call is archived), and Settings > Agent has none either', async ({
  page,
}) => {
  await page.goto('/t/general?settings=1') // the real app in fake mode: the cards harness has no thread screen
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('thread-switches')).toHaveCount(0)
  await expect(page.getByRole('switch', { name: /Live-call context/ })).toHaveCount(0)
  await open(page, '/settings/agent')
  await expect(page.getByRole('switch', { name: /Live-call context/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Manage threads' })).toBeVisible()
})

test('a config_conflict from the Mac shows the conflict message', async ({ page }) => {
  await open(page, '/settings/agent')
  await page.evaluate(() => window.__talos.failNextPatchWith('config_conflict'))
  await page.getByLabel('Agent name').fill('Atlas')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('alert')).toContainText('changed on another device')
  expect(await sentFrames(page)).toHaveLength(0)
})

test('it is read-only with a banner when the Mac is offline', async ({ page }) => {
  await open(page, '/settings/agent', { offline: true })
  await expect(page.getByRole('status')).toContainText('Mac is offline')
  await expect(page.getByLabel('Agent name')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled()
})

test('axe: agent settings are clean in light and dark', async ({ page }) => {
  await open(page, '/settings/agent')
  await expectAxeClean(page)
  await open(page, '/settings/agent', { offline: true })
  await expectAxeClean(page)
})
