// Helpers for specs that run on phones and desktop: on a phone the thread list, thread settings and thread purpose live in
// the left menu (the slim header has no tab strip), on wider screens they are on the page.
import { expect, type Page } from '@playwright/test'

export const isPhoneWidth = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

export async function openPhoneMenu(page: Page) {
  await page.getByRole('button', { name: 'Open menu' }).click()
  const menu = page.getByTestId('phone-menu')
  await expect(menu).toBeVisible()
  // let the slide-in finish: WebKit's "stable" check never settles on a control inside a running transform animation
  await menu.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)).then(() => undefined))
}

export async function openThreadSettings(page: Page) {
  if (isPhoneWidth(page)) await openPhoneMenu(page)
  await page.getByTestId('thread-settings-trigger').click()
}

/** The thread's "what goes here" line: on the page on wide screens, in the menu on phones (closed again after). */
export async function expectPurpose(page: Page, text: string) {
  const phone = isPhoneWidth(page)
  if (phone) await openPhoneMenu(page)
  await expect(page.getByTestId('thread-purpose')).toHaveText(text)
  if (phone) await page.keyboard.press('Escape')
}

/** The control that lists and switches threads: the tab strip on wide screens, the menu's thread list on phones. */
export async function threadSwitcher(page: Page) {
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    return page.getByTestId('phone-menu').getByRole('navigation', { name: 'Threads' })
  }
  return page.getByRole('navigation', { name: 'Primary' }) // the sidebar's list (the tab strip under the header is gone)
}
