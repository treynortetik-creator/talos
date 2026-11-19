// Shared by the Schedules specs: the organized page starts every group shut, so a spec that wants the rows opens them first.
import type { Page } from '@playwright/test'

// What the page shows before the bridge has answered, and which an answer then replaces: "Your computer is offline" while no
// list has come yet (the page draws it for a moment on every open, before Loading…), and "didn't answer" after Try again. Seen
// alone they are not the page's last word.
const BEFORE_AN_ANSWER = ['mac_offline', 'no_answer']

/**
 * Opens every group that is shut. Waits (without failing) for the first group header, or for an empty state that is an answer
 * (no jobs, not installed, off...), so an empty page costs a short wait; an empty state that only means "no answer yet" is
 * waited past, up to the same 4 s.
 */
export async function expandGroups(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid^="group-toggle-"]')
  const answered = page.locator(
    `[data-testid^="empty-"]${BEFORE_AN_ANSWER.map((k) => `:not([data-testid="empty-${k}"])`).join('')}`,
  )
  // The page has settled when a group header or an answering empty state is drawn. Stopping at the first empty state of any
  // kind lost the race under load: the page showed "offline" for up to half a second before Loading… and the list, this
  // returned, and the list came in with its groups shut (schedules/relay.spec.ts, 7 in 20 under a CPU burner, 2026-11-19).
  await toggles
    .first()
    .or(answered.first())
    .first()
    .waitFor({ timeout: 4000 })
    .catch(() => {})
  if ((await toggles.count()) === 0) return
  // each click shuts one fewer: take the first still-shut header until none is left
  const shut = page.locator('[data-testid^="group-toggle-"][aria-expanded="false"]')
  for (let i = 0; i < 50 && (await shut.count()) > 0; i++) await shut.first().click()
}
