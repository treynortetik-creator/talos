// Settings > Memory folders in a real browser (fake mode: the made-up agent folder in src/lib/fakeMemoryFolders.ts). Tick the
// folders Notes shows, Save; the Mac's answer says saved; an offline Mac says nothing was saved.
import { expect, type Page, test } from '@playwright/test'

type Talos = { store: { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void } }

async function open(page: Page) {
  await page.goto('/settings/memory-folders')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  return page.getByTestId('memory-folders')
}

test('pick folders and save: Notes shows them', async ({ page }) => {
  const s = await open(page)
  await expect(s.getByRole('checkbox')).toHaveCount(3)
  await expect(s.getByText('48 notes')).toBeVisible()
  const save = s.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled() // nothing changed yet
  await s.getByRole('checkbox', { name: /^notes/ }).check()
  await s.getByRole('checkbox', { name: /^journal/ }).check()
  await save.click()
  await expect(s.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
  await expect(save).toBeDisabled()
  // every checkbox row is a finger-sized target
  for (const box of await s.locator('label').all())
    expect((await box.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
})

test('an offline Mac: says nothing was saved', async ({ page }) => {
  const s = await open(page)
  await s.getByRole('checkbox', { name: /^projects/ }).check()
  await page.evaluate(() => {
    const t = (window as unknown as { __talos: Talos }).__talos
    t.store.setState((st) => ({ presence: { ...(st.presence as Record<string, unknown>), bridge_online: false } }))
  })
  await s.getByRole('button', { name: 'Save' }).click()
  await expect(s.getByRole('alert')).toContainText('nothing was saved')
})
