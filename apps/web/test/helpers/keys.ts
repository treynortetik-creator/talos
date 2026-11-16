// The first shortcut after a page load can land before Shell has attached its key handler (useGlobalKeys runs in an effect
// after the first render). On a loaded machine that gap is long enough for the press to go nowhere, and the spec then waits
// out its whole timeout. This presses again until the shortcut took effect, and never presses into a result that already
// shows (a second Ctrl+K would close the palette). No time limit of its own: Playwright's toPass polls until the test's.
import { expect, type Page } from '@playwright/test'

export async function pressWhenListening(page: Page, key: string, took: () => Promise<boolean>): Promise<void> {
  await expect(async () => {
    if (!(await took())) await page.keyboard.press(key)
    expect(await took()).toBe(true)
  }).toPass()
}

/** Ctrl/Cmd+K, then the palette is open. */
export const openPalette = (page: Page) =>
  pressWhenListening(page, 'ControlOrMeta+k', () => page.getByRole('dialog', { name: 'Command palette' }).isVisible())
