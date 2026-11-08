// Helpers for specs that run on phones and desktop: on a phone the thread list and each thread's settings live in the left
// menu (the slim header has no tab strip), on wider screens they are on the page.
import { expect, type Page } from '@playwright/test'

export const isPhoneWidth = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

export async function openPhoneMenu(page: Page) {
  const menu = page.getByTestId('phone-menu')
  if (await menu.isVisible()) return // already open (a thread's settings sheet opened from it leaves it open underneath)
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(menu).toBeVisible()
  // let the slide-in finish: WebKit's "stable" check never settles on a control inside a running transform animation
  await menu.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)).then(() => undefined))
}

/** Closes the phone menu if it is open (it stays open under a thread's settings sheet). No-op on a wider screen. */
export async function closePhoneMenu(page: Page) {
  const menu = page.getByTestId('phone-menu')
  if (!(await menu.isVisible())) return
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
}

/** The thread on screen's settings: its ⋯ in the menu's list on a phone (the highlighted row), the header's ⋯ elsewhere. */
export async function openThreadSettings(page: Page) {
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    await page
      .getByTestId('phone-menu')
      .locator('.group:has(a[aria-current="page"]) [data-testid^="thread-more-"]')
      .click()
    return
  }
  await page.getByTestId('thread-settings-trigger').click()
}

/** The thread's "what goes here" text. It is no longer a line under the header: it is read in the thread's settings. */
export async function expectPurpose(page: Page, text: string) {
  await openThreadSettings(page)
  await expect(page.getByLabel('What goes here')).toHaveValue(text)
  await page.getByTestId('thread-settings').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('thread-settings')).toBeHidden()
  await closePhoneMenu(page)
}

/** The control that lists and switches threads: the tab strip on wide screens, the menu's thread list on phones. */
export async function threadSwitcher(page: Page) {
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    return page.getByTestId('phone-menu').getByRole('navigation', { name: 'Threads' })
  }
  return page.getByRole('navigation', { name: 'Primary' }) // the sidebar's list (the tab strip under the header is gone)
}

/** The Session panel: docked beside the chat on a desktop (1024 px and up), a sheet below that. */
export const sessionPanel = (page: Page) =>
  page.getByTestId((page.viewportSize()?.width ?? 0) >= 1024 ? 'session-dock' : 'session-sheet')

/** Opens the Session panel with the usage chip and returns it. */
export async function openSessionPanel(page: Page) {
  const panel = sessionPanel(page)
  // a docked panel stays open between visits (the choice is kept per device): only press the chip when it is closed
  if (!(await panel.isVisible())) await page.getByTestId('session-trigger').click()
  await expect(panel).toBeVisible()
  return panel
}
