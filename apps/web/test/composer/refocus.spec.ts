// Dictation tools (Wispr Flow and friends) check that the FOCUSED element is editable before they paste. After a send
// the box must therefore still hold focus, however the send was triggered. Desktop-pointer only: refocusing on a phone
// would pop the keyboard.
import { expect, type Page, test } from '@playwright/test'

const activeIsBox = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement
    return a instanceof HTMLTextAreaElement && a.getAttribute('aria-label') === 'Message'
  })

// What a dictation tool does: ask whether the focused element is editable, then paste into it.
async function dictate(page: Page, text: string) {
  expect(await activeIsBox(page)).toBe(true)
  await page.evaluate((t) => {
    const el = document.activeElement as HTMLTextAreaElement
    el.setRangeText(t, el.selectionStart, el.selectionEnd, 'end')
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: t }))
  }, text)
}

test.describe('composer keeps focus after sending', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop pointer only')

  test('clicking Send leaves the box focused and the next dictated message sends', async ({ page }) => {
    await page.goto('/t/general')
    const box = page.getByLabel('Message', { exact: true })
    await box.click()
    await box.pressSequentially('one')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('msg-agent').getByText('echo: one')).toBeVisible()
    expect(await activeIsBox(page)).toBe(true)
    await dictate(page, 'two')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('msg-agent').getByText('echo: two')).toBeVisible()
    expect(await activeIsBox(page)).toBe(true)
  })

  test('Enter leaves the box focused and the next dictated message sends', async ({ page }) => {
    await page.goto('/t/general')
    const box = page.getByLabel('Message', { exact: true })
    await box.click()
    await box.pressSequentially('one')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('msg-agent').getByText('echo: one')).toBeVisible()
    expect(await activeIsBox(page)).toBe(true)
    await dictate(page, 'two')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('msg-agent').getByText('echo: two')).toBeVisible()
  })
})
