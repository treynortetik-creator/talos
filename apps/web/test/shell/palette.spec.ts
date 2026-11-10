// The palette in the real app (fake mode, production build): desktop by keyboard alone, axe clean in both themes, focus back where it
// was on Esc, and the phone's search button and pull-down (a normal scroll never opens it). Screenshots go to $SHOT_DIR when it is set.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 768
const SHOTS = process.env.SHOT_DIR
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })
const box = (page: Page) => page.getByRole('combobox')

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

test.describe('desktop', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'desktop only')

  test('Ctrl+K opens it, the keyboard alone reaches a thread, and Esc puts focus back', async ({ page }) => {
    await page.goto('/threads')
    const before = page.getByTestId('sidebar-toggle')
    await before.focus()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette(page)).toBeVisible()
    await expect(box(page)).toBeFocused()
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette(page)).toBeHidden()
    await expect(before).toBeFocused()
    await page.keyboard.press('ControlOrMeta+k')
    await box(page).fill('settings')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/settings/)
    await expect(palette(page)).toBeHidden()
  })

  test('Ctrl+K from the message box opens it, and Esc returns to the message box with the text kept', async ({
    page,
  }) => {
    await page.goto('/t/general')
    const msg = page.getByLabel('Message', { exact: true })
    await msg.click()
    await msg.pressSequentially('keep me')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(msg).toBeFocused()
    await expect(msg).toHaveValue('keep me')
  })

  test('Ctrl+J lists what needs you; Enter opens the card and does not answer it', async ({ page }) => {
    // the seeded card's expiry is an absolute time: pin "now" to the day it was written for (the clock keeps running)
    await page.clock.install({ time: new Date('2026-10-28T16:00:00.000Z') })
    await page.goto('/threads')
    await page.keyboard.press('ControlOrMeta+j')
    await expect(palette(page)).toBeVisible()
    const first = page.getByRole('option').first()
    await expect(first).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/card\//)
    // the card is open and still waiting: Enter did not answer it
    const card = page.locator('[data-card-id]').first()
    await expect(card).toBeVisible()
    await expect(page.getByRole('link', { name: /1 need you/ })).toBeVisible()
  })

  test('Ctrl+K inside the New thread editor does not wipe what was typed', async ({ page }) => {
    await page.goto('/threads')
    await page.keyboard.press('ControlOrMeta+k')
    await box(page).fill('New thread')
    await page.keyboard.press('Enter')
    const name = page.getByRole('dialog').getByRole('textbox').first()
    await expect(name).toBeVisible()
    await name.fill('Garden')
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.press('ControlOrMeta+j')
    await expect(name).toHaveValue('Garden')
    await expect(box(page)).toHaveCount(0)
  })

  test('a plain word then Enter searches; it never sends a / command', async ({ page }) => {
    await page.goto('/t/general')
    await page.keyboard.press('ControlOrMeta+k')
    await box(page).fill('deploy')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/search\?q=deploy/)
  })

  test('Ctrl+/ opens the shortcut list in Settings', async ({ page }) => {
    await page.goto('/threads')
    await page.keyboard.press('ControlOrMeta+/')
    await expect(page).toHaveURL(/\/settings\/shortcuts/)
    await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible()
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await shot(page, `settings-shortcuts-desktop-${scheme}`)
    }
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe clean (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.goto('/threads')
      await page.keyboard.press('ControlOrMeta+k')
      await expect(palette(page)).toBeVisible()
      await shot(page, `palette-desktop-${scheme}`)
      await expectAxeClean(page)
    })
  }
})

test.describe('phone', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'phone only')

  test('the search button in the header opens the same palette, with no shortcuts shown', async ({ page }) => {
    await page.goto('/t/general')
    await page.getByRole('button', { name: 'Search and commands' }).click()
    await expect(palette(page)).toBeVisible()
    await expect(page.getByRole('option').first()).toBeVisible()
    await expect(palette(page).locator('kbd')).toHaveCount(0)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await shot(page, 'palette-phone-light')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await shot(page, 'palette-phone-dark')
    await expectAxeClean(page)
    await page.keyboard.press('Escape')
    await expect(palette(page)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Search and commands' })).toBeFocused()
  })

  test('a pull down from the top of the thread list opens it; a normal scroll never does', async ({ page }) => {
    await page.goto('/threads')
    const touch = (type: string, y: number) =>
      page.evaluate(
        ([t, yy]) => {
          const el = document.getElementById('main') as HTMLElement
          const e = new Event(t as string, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>
          const pt = [{ clientX: 120, clientY: yy as number }]
          e.touches = t === 'touchend' ? [] : pt
          e.changedTouches = pt
          el.dispatchEvent(e)
        },
        [type, y] as const,
      )
    // a scroll: the finger moves up
    await touch('touchstart', 500)
    await touch('touchmove', 400)
    await touch('touchmove', 250)
    await touch('touchend', 250)
    await expect(palette(page)).toBeHidden()
    // a pull
    await touch('touchstart', 120)
    await touch('touchmove', 200)
    await touch('touchmove', 300)
    await touch('touchend', 300)
    await expect(palette(page)).toBeVisible()
  })

  test('Settings does not list the shortcuts on a phone', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('link', { name: 'Keyboard shortcuts' })).toHaveCount(0)
  })
})

test('the shortcuts section on a wide screen', async ({ page }) => {
  test.skip(!wide(page), 'desktop only')
  await page.goto('/settings/shortcuts')
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible()
  await expectAxeClean(page)
})
