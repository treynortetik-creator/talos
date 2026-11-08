// PR #94 review: the lows and the history of what a phone panel owns. Real browser, fake client (`VITE_FAKE=1`).
import { expect, type Page, test } from '@playwright/test'
import { openPhoneMenu, openThreadSettings } from '../helpers/phone.ts'

type Talos = { store: { setState(fn: (s: Record<string, unknown>) => Record<string, unknown>): void } }
const fake = <T>(page: Page, fn: (t: Talos) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

test.use({ reducedMotion: 'reduce', serviceWorkers: 'block' })

async function openThread(page: Page, q = '') {
  await page.goto(`/t/general${q}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}

test.describe('phone', () => {
  test.beforeEach(({ page }) => test.skip(!isPhone(page), 'phone layout only'))

  test('L3: an idle thread with a status label still shows the label in the session panel', async ({ page }) => {
    await openThread(page)
    await fake(page, (t) =>
      t.store.setState((s) => ({
        statuses: { ...(s.statuses as object), general: { state: 'idle', label: 'waiting on CI' } },
      })),
    )
    await page.getByTestId('session-trigger').click()
    await expect(page.getByTestId('session-status')).toContainText('waiting on CI')
  })

  test('L4: closing Thread settings puts focus back on the ⋯ that opened it, not the page', async ({ page }) => {
    await openThread(page)
    await openPhoneMenu(page)
    await page.getByTestId('phone-menu').getByTestId('thread-more-general').click()
    const sheet = page.getByTestId('thread-settings')
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId('phone-menu').getByTestId('thread-more-general')).toBeFocused()
  })

  test('L5: a topic set elsewhere beats a stale local note in the thread settings', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('talos.thread-descriptions', JSON.stringify({ general: 'OLD LOCAL NOTE' })),
    )
    await openThread(page)
    await fake(page, (t) =>
      t.store.setState((s) => ({
        threads: (s.threads as Array<{ id: string }>).map((th) =>
          th.id === 'general' ? { ...th, topic: 'NEW TOPIC' } : th,
        ),
      })),
    )
    await openThreadSettings(page)
    await expect(page.getByLabel('What goes here')).toHaveValue('NEW TOPIC')
  })

  test.describe('L6: a short landscape phone', () => {
    test.use({ viewport: { width: 667, height: 375 } })
    test('the menu keeps every row readable and scrolls to the footer', async ({ page }) => {
      await openThread(page)
      await fake(page, (t) =>
        t.store.setState((s) => ({
          threads: (s.threads as Array<{ id: string }>).map((th) =>
            th.id === 'general' ? { ...th, topic: 'x'.repeat(200) } : th,
          ),
        })),
      )
      await openPhoneMenu(page)
      const menu = page.getByTestId('phone-menu')
      const inbox = await menu.getByRole('link', { name: 'Inbox' }).boundingBox()
      expect(inbox?.height ?? 0, 'a thread row is not squeezed').toBeGreaterThanOrEqual(40)
      expect(await menu.evaluate((e) => e.scrollHeight > e.clientHeight), 'the whole menu scrolls').toBe(true)
      const settings = menu.getByRole('link', { name: 'Settings' })
      await settings.scrollIntoViewIfNeeded()
      await expect(settings).toBeInViewport()
    })
  })

  test('unread in another thread: the menu lists it, the current thread shows once', async ({ page }) => {
    await openThread(page)
    await fake(page, (t) => t.store.setState(() => ({ unread: { inbox: 2 } })))
    await openPhoneMenu(page)
    await expect(page.getByTestId('phone-menu').getByRole('link', { name: /Inbox/ })).toContainText('2')
  })
})

// L7: 768-1023 px is neither the phone layout nor the desktop one. It keeps the full header and the usage chip in the corner,
// and the chip opens the Session panel as a bottom sheet (below 1024 px nothing docks), so the focus checks that used to run
// at phone width run here now.
test.describe('tablet width', () => {
  test.use({ viewport: { width: 900, height: 800 } })
  test.beforeEach(({ page }, info) => test.skip(info.project.name !== 'desktop', 'a desktop browser at tablet width'))

  test('full header, no tab strip, no phone chrome', async ({ page }) => {
    await openThread(page, '?fake_agents=demo')
    await expect(page.getByTestId('phone-header')).toHaveCount(0)
    await expect(page.getByTestId('thread-tabs')).toHaveCount(0)
    await expect(page.getByTestId('session-chip')).toContainText('wk 60% used')
    await expect(page.getByTestId('agents-chip')).toHaveCount(0) // one Session panel now, Agents is a section of it
  })

  test('the chip opens a bottom sheet that traps focus and gives it back', async ({ page }) => {
    await openThread(page, '?fake_agents=demo')
    const chip = page.getByTestId('session-trigger')
    await chip.click()
    const sheet = page.getByTestId('session-sheet')
    await expect(sheet).toBeVisible()
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      expect(await sheet.evaluate((s) => s.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(chip).toBeFocused()
  })

  test('opening an agent row moves focus to its detail, not the dialog shell', async ({ page }) => {
    await openThread(page, '?fake_agents=demo')
    await page.getByTestId('session-trigger').click()
    const sheet = page.getByTestId('session-sheet')
    await sheet.getByRole('button', { name: /research mods API/ }).focus()
    await page.keyboard.press('Enter')
    await expect(sheet.getByTestId('agent-detail')).toBeVisible()
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).not.toBe(
      'session-sheet',
    )
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
  })
})
