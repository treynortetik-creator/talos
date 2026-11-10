// The desktop sidebar folds to a slim rail: a toggle, Ctrl/Cmd+\, the choice kept per device, every row still reachable
// by keyboard and by name, and the unread / Needs you counts still drawn. Phones keep the bottom bar and are untouched.
// Screenshots (both themes) go to SHOTS_DIR when it is set.
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

const KEY = 'talos-sidebar-collapsed'
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 768
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const toggle = (page: Page) => page.getByTestId('sidebar-toggle')
const width = async (page: Page) => (await sidebar(page).boundingBox())?.width ?? 0

test.describe('desktop sidebar', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'desktop only')

  test('the toggle folds it to a rail and back, and keeps focus', async ({ page }) => {
    await page.goto('/settings')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
    expect(await width(page)).toBeGreaterThan(200)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await toggle(page).focus()
    await page.keyboard.press('Enter')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    expect(await width(page)).toBeLessThan(90)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page)).toHaveAccessibleName('Expand sidebar')
    await expect(toggle(page)).toBeFocused()
    await page.keyboard.press('Space')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
    await expect(toggle(page)).toBeFocused()
  })

  test('Ctrl+\\ and Cmd+\\ fold it, also from the message box, without touching the text', async ({ page }) => {
    await page.goto('/t/general')
    const box = page.getByLabel('Message', { exact: true })
    await box.click()
    await box.pressSequentially('keep me')
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    await expect(box).toBeFocused()
    await expect(box).toHaveValue('keep me')
    // the other platform's key is not ours: Ctrl on a Mac (text editing), the Windows or Super key elsewhere
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
    await page.keyboard.press(mac ? 'Control+Backslash' : 'Meta+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
    // Shift / Alt variants are other people's chords
    await page.keyboard.press('ControlOrMeta+Shift+Backslash')
    await page.keyboard.press('ControlOrMeta+Alt+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
  })

  test('the choice is remembered on this device', async ({ page }) => {
    await page.goto('/settings')
    await toggle(page).click()
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('1')
    await page.reload()
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    await toggle(page).click()
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()
    await page.reload()
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
  })

  test('storage that throws leaves it working (open by default)', async ({ page }) => {
    await page.addInitScript(() => {
      const bad = () => {
        throw new Error('blocked')
      }
      Storage.prototype.getItem = bad
      Storage.prototype.setItem = bad
    })
    await page.goto('/settings')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
    await toggle(page).click()
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  })

  test('folded, every row keeps its name, counts stay drawn, and Tab reaches them', async ({ page }) => {
    // the seeded card expires on 2026-10-29: look at the app the day before, so it still needs the owner
    await page.clock.setFixedTime(new Date('2026-10-28T10:00:00Z'))
    await page.goto('/settings')
    await toggle(page).click()
    const rail = sidebar(page)
    for (const name of ['Needs you', 'Inbox', 'Schedules', 'Settings']) {
      await expect(rail.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible()
    }
    // search is one magnifier on the rail (it unfolds the sidebar into the search box), not a row
    await expect(rail.getByRole('button', { name: 'Search threads' })).toBeVisible()
    await expect(rail.getByRole('link', { name: 'Search', exact: true })).toHaveCount(0)
    // the seeded unread reply and pending card
    const unread = rail.getByRole('img', { name: '1 unread' })
    const needs = rail.getByRole('img', { name: '1 need you' })
    await expect(unread).toBeVisible()
    await expect(needs).toBeVisible()
    const railBox = await rail.boundingBox()
    for (const badge of [unread, needs]) {
      const b = await badge.boundingBox()
      expect(b && railBox && b.x >= railBox.x && b.x + b.width <= railBox.x + railBox.width).toBe(true)
    }
    // a row reads its name, its count and nothing painted-over: the visible text is just the badge
    await expect(rail.getByRole('link', { name: /Needs you/ })).toHaveAccessibleName(/Needs you.*1 need you/)
    // Tab walks toggle -> rows, in order, all focusable
    await toggle(page).focus()
    const seen: string[] = []
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Tab')
      seen.push(await page.evaluate(() => document.activeElement?.getAttribute('href') ?? ''))
    }
    expect(seen).toEqual(expect.arrayContaining(['/', '/t/inbox', '/schedules', '/settings']))
    // folded rows do not carry the manage-threads controls
    await expect(page.getByTestId('edit-threads')).toHaveCount(0)
    const axe = await new AxeBuilder({ page }).include('[aria-label="Sidebar"]').analyze()
    expect(axe.violations).toEqual([])
  })

  test('folding while managing threads ends the mode', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('edit-threads').click()
    await toggle(page).click()
    await toggle(page).click()
    await expect(page.getByTestId('edit-threads')).toHaveAttribute('aria-pressed', 'false')
  })

  test('the chord from manage mode ends it too, and it stays ended on unfold', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('edit-threads').click()
    await expect(page.getByTestId('edit-threads')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByTestId('edit-threads')).toHaveAttribute('aria-pressed', 'false')
  })

  test('an open sheet keeps its typed text: the chord is ignored while a dialog is open', async ({ page }) => {
    await page.goto('/settings')
    // a modal hides the rest of the page from the accessibility tree: find the rail by its tag
    const rail = page.locator('aside[aria-label="Sidebar"]')
    await page.getByTestId('new-thread').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const field = dialog.getByRole('textbox').first()
    await field.fill('Half typed thread name')
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(rail).toHaveAttribute('data-collapsed', 'false')
    await expect(dialog).toBeVisible()
    await expect(field).toHaveValue('Half typed thread name')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(rail).toHaveAttribute('data-collapsed', 'true')
  })

  test('the chord from a control the fold removes lands focus on the toggle, not the page body', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('edit-threads').focus()
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    await expect(toggle(page)).toBeFocused()
    await page.keyboard.press('ControlOrMeta+Backslash')
    await page.getByTestId('new-thread').focus()
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(toggle(page)).toBeFocused()
  })

  test('a held chord toggles once, not on every key repeat', async ({ page }) => {
    await page.goto('/settings')
    await page.evaluate(() => {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform) // Cmd on a Mac, Ctrl elsewhere
      for (const repeat of [false, true, true, true]) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'Backslash',
            key: '\\',
            ctrlKey: !mac,
            metaKey: mac,
            repeat,
            bubbles: true,
          }),
        )
      }
    })
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  })

  test('the Ask button follows the column when the sidebar folds', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-28T10:00:00Z'))
    await page.goto('/')
    const ask = page.getByRole('button', { name: /^Ask / })
    await expect(ask).toBeVisible()
    const gapToColumn = async () => {
      const col = await page.locator('#main').boundingBox()
      const b = await ask.boundingBox()
      if (!col || !b) throw new Error('no boxes')
      return col.x + col.width - (b.x + b.width)
    }
    const open = await gapToColumn()
    expect(open).toBeGreaterThanOrEqual(0)
    await toggle(page).click()
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
    const folded = await gapToColumn()
    expect(folded).toBeGreaterThanOrEqual(0)
    expect(Math.abs(folded - open)).toBeLessThanOrEqual(2)
  })

  test('shots: both themes, open and folded', async ({ page }) => {
    const dir = process.env.SHOTS_DIR
    test.skip(!dir, 'SHOTS_DIR not set')
    for (const theme of ['light', 'dark'] as const) {
      await page.clock.setFixedTime(new Date('2026-10-28T10:00:00Z'))
      await page.addInitScript((t) => localStorage.setItem('talos-theme', t), theme)
      await page.goto('/settings')
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.screenshot({ path: `${dir}/sidebar-open-${theme}.png` })
      await toggle(page).click()
      await page.screenshot({ path: `${dir}/sidebar-folded-${theme}.png` })
      await page.evaluate((k) => localStorage.removeItem(k), KEY)
    }
  })
})

test.describe('phone', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'phone only')
  test('keeps the bottom bar, has no sidebar, and the chord does nothing', async ({ page }) => {
    await page.goto('/settings')
    expect(wide(page)).toBe(false)
    await expect(sidebar(page)).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+Backslash')
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  })
})
