// Esc and input-method keys in the search boxes that live in a real dialog or sheet (fake mode, production build; iPhone, Pixel,
// desktop): Esc with text clears the box and the dialog stays, an empty box closes it once, and a held Esc never closes it.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { openPalette } from '../helpers/keys.ts'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })
const paletteBox = (page: Page) => page.getByRole('combobox')

/** Playwright marks a second key-down of a key that is still down as a repeat; record what the page actually saw. */
async function recordRepeats(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __esc: boolean[] }
    w.__esc = []
    window.addEventListener('keydown', (e) => e.key === 'Escape' && w.__esc.push(e.repeat), true)
  })
  return () => page.evaluate(() => (window as unknown as { __esc: boolean[] }).__esc)
}

/** An input-method Esc as a browser sends it: isComposing, and keyCode 229 (Safari sends 229 after the composition ended). */
const imeEsc = (box: Locator) =>
  box.evaluate((el) => {
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }))
    }
  })

test.describe('the command palette', () => {
  test('Esc clears the text and stays; a second Esc closes it, once', async ({ page }) => {
    await page.goto('/t/general')
    await openPalette(page)
    await paletteBox(page).fill('abc')
    await page.keyboard.press('Escape')
    await expect(paletteBox(page)).toHaveValue('')
    await expect(palette(page)).toBeVisible()
    await expect(paletteBox(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(palette(page)).toBeHidden()
  })

  test('a held Esc clears once and never closes it, with text or on an empty box', async ({ page }) => {
    await page.goto('/t/general')
    await openPalette(page)
    const seen = await recordRepeats(page)
    await paletteBox(page).fill('abc')
    await page.keyboard.down('Escape')
    await page.keyboard.down('Escape')
    await page.keyboard.down('Escape')
    await page.keyboard.down('Escape')
    expect(await seen()).toEqual([false, true, true, true]) // the later key-downs really were repeats
    await expect(paletteBox(page)).toHaveValue('')
    await expect(palette(page)).toBeVisible()
    await page.keyboard.up('Escape')
    await page.keyboard.press('Escape') // a fresh press on the empty box closes
    await expect(palette(page)).toBeHidden()
  })

  test('an input-method Esc clears nothing and closes nothing', async ({ page }) => {
    await page.goto('/t/general')
    await openPalette(page)
    await paletteBox(page).fill('abc')
    await imeEsc(paletteBox(page))
    await expect(paletteBox(page)).toHaveValue('abc')
    await expect(palette(page)).toBeVisible()
  })

  test('an input-method Enter runs no item', async ({ page }) => {
    await page.goto('/t/general')
    await openPalette(page)
    await paletteBox(page).fill('settings')
    await paletteBox(page).evaluate((el) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })),
    )
    await expect(palette(page)).toBeVisible()
    await expect(page).toHaveURL(/\/t\/general/)
  })
})

/** The list the owner searches from: the desktop sidebar, or the phone menu after it slid in. */
async function scope(page: Page) {
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    return page.getByTestId('phone-menu')
  }
  return page.getByRole('complementary', { name: 'Sidebar' })
}

test.describe('the thread list search (sidebar, and the phone menu sheet)', () => {
  test('Esc clears the text, the next Esc puts the list back, and the phone menu stays open throughout', async ({
    page,
  }) => {
    await page.goto('/t/general')
    const nav = await scope(page)
    await nav.getByRole('button', { name: 'Search threads' }).click()
    const box = nav.getByRole('searchbox', { name: 'Search all threads' })
    await box.fill('fake agent')
    await page.keyboard.press('Escape')
    await expect(box).toHaveValue('')
    await expect(box).toBeFocused()
    if (isPhoneWidth(page)) await expect(page.getByTestId('phone-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(nav.getByRole('searchbox')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Inbox' })).toBeVisible()
    if (isPhoneWidth(page)) await expect(page.getByTestId('phone-menu')).toBeVisible()
  })

  test('a held Esc never ends the search or closes the phone menu', async ({ page }) => {
    await page.goto('/t/general')
    const nav = await scope(page)
    await nav.getByRole('button', { name: 'Search threads' }).click()
    const box = nav.getByRole('searchbox', { name: 'Search all threads' })
    await box.fill('fake agent')
    const seen = await recordRepeats(page)
    for (let i = 0; i < 4; i++) await page.keyboard.down('Escape')
    expect((await seen()).slice(1)).toEqual([true, true, true])
    await expect(box).toHaveValue('')
    await expect(box).toBeVisible()
    if (isPhoneWidth(page)) await expect(page.getByTestId('phone-menu')).toBeVisible()
    await page.keyboard.up('Escape')
  })

  test('an input-method Esc does nothing here either', async ({ page }) => {
    await page.goto('/t/general')
    const nav = await scope(page)
    await nav.getByRole('button', { name: 'Search threads' }).click()
    const box = nav.getByRole('searchbox', { name: 'Search all threads' })
    await box.fill('fake agent')
    await imeEsc(box)
    await expect(box).toHaveValue('fake agent')
    if (isPhoneWidth(page)) await expect(page.getByTestId('phone-menu')).toBeVisible()
  })
})

test.describe('the icon search in the thread editor sheet', () => {
  test('Esc clears it and keeps the sheet and the name typed so far; a second Esc closes the sheet', async ({
    page,
  }) => {
    await page.goto('/t/general')
    const nav = await scope(page)
    await nav.getByRole('button', { name: 'Add a thread' }).click()
    const sheet = page.getByTestId('thread-settings')
    await expect(sheet).toBeVisible()
    await sheet.locator('#thread-name').fill('Kept name')
    const icons = sheet.getByLabel('Search icons')
    await icons.fill('star')
    await page.keyboard.press('Escape')
    await expect(icons).toHaveValue('')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('#thread-name')).toHaveValue('Kept name')
    // held with text in the box: the first key-down clears it, the repeats close nothing
    await icons.fill('star')
    for (let i = 0; i < 4; i++) await page.keyboard.down('Escape')
    await page.keyboard.up('Escape')
    await expect(icons).toHaveValue('')
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape') // a fresh press on the empty box closes the sheet
    await expect(sheet).toBeHidden()
  })
})

test.describe('a held Esc that closed a dialog', () => {
  test('does not go on to close the details panel behind it', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the details panel is a desktop layout')
    // the real Shell on the fake client, with a job open in the right-hand details panel
    await page.goto('/test/schedules/harness/index.html?route=/schedules/weekly-review&variant=healthy')
    await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
    const details = page.getByRole('complementary', { name: 'Weekly review' })
    await expect(details).toBeVisible()
    await openPalette(page)
    const seen = await recordRepeats(page)
    await page.keyboard.down('Escape') // fresh, empty box: closes the palette
    await expect(palette(page)).toBeHidden()
    for (let i = 0; i < 4; i++) await page.keyboard.down('Escape') // the key is still down: these are repeats
    expect((await seen()).slice(1)).toEqual([true, true, true, true])
    await expect(details).toBeVisible()
    await page.keyboard.up('Escape')
    await page.keyboard.press('Escape') // a fresh Esc is the page's again: it closes the panel
    await expect(details).toBeHidden()
  })
})
