// Shared by the Schedules specs: the organized page starts every group shut, so a spec that wants the rows opens them first.
import type { Page } from '@playwright/test'

/** Opens every group that is shut. Waits (without failing) for the first group header, so an empty page costs a short wait. */
export async function expandGroups(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid^="group-toggle-"]')
  // The page has settled when a group header or an empty state is drawn: an empty state has no groups to open, and waiting
  // out the 4 s for a header that never comes cost every empty-state test 4 s. Anything else still gets the 4 s.
  await toggles
    .first()
    .or(page.locator('[data-testid^="empty-"]').first())
    .first()
    .waitFor({ timeout: 4000 })
    .catch(() => {})
  if ((await toggles.count()) === 0) return
  // each click shuts one fewer: take the first still-shut header until none is left
  const shut = page.locator('[data-testid^="group-toggle-"][aria-expanded="false"]')
  for (let i = 0; i < 50 && (await shut.count()) > 0; i++) await shut.first().click()
}
