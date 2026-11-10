// Shared by the Schedules specs: the organized page starts every group shut, so a spec that wants the rows opens them first.
import type { Page } from '@playwright/test'

/** Opens every group that is shut. Waits (without failing) for the first group header, so an empty page costs a short wait. */
export async function expandGroups(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid^="group-toggle-"]')
  await toggles
    .first()
    .waitFor({ timeout: 4000 })
    .catch(() => {})
  // each click shuts one fewer: take the first still-shut header until none is left
  const shut = page.locator('[data-testid^="group-toggle-"][aria-expanded="false"]')
  for (let i = 0; i < 50 && (await shut.count()) > 0; i++) await shut.first().click()
}
