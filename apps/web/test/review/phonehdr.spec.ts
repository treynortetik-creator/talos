// Review of PR #94 at e3e206a: failing tests for the confirmed high and medium findings, in a real browser against the
// fake client. Every test here is red at that head and should go green with the fix named beside it. Findings and the
// lows that have no test: the phone header review notes.
import { expect, type Page, test } from '@playwright/test'
import { openPhoneMenu } from '../helpers/phone.ts'
import { swipe } from '../phone/swipe.ts'

type Talos = {
  setMacOnline(online: boolean): void
  store: {
    getState(): { cards: Array<{ id: string }>; unread: Record<string, number> }
    setState(fn: (s: Record<string, unknown>) => Record<string, unknown>): void
  }
}
const fake = <T>(page: Page, fn: (t: Talos) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>

test.use({ reducedMotion: 'reduce', serviceWorkers: 'block' })
test.beforeEach(({ page }) => test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone layout only'))

const size = (page: Page) => page.viewportSize() ?? { width: 0, height: 0 }
const fromLeft = (page: Page) => ({
  from: { x: 8, y: size(page).height / 2 },
  to: { x: 200, y: size(page).height / 2 + 6 },
})
const fromRight = (page: Page) => ({
  from: { x: size(page).width - 8, y: size(page).height / 2 },
  to: { x: size(page).width - 200, y: size(page).height / 2 + 6 },
})

async function openThread(page: Page) {
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}

async function openCard(page: Page) {
  await openThread(page)
  const id = await fake(page, (t) => t.store.getState().cards[0]?.id)
  await page.goto(`/card/${id}`)
  await expect(page.getByTestId('phone-header')).toBeVisible()
}

test.describe('H1: driving mode owns the screen', () => {
  // Fix: make the guard block on any modal layer, and turn the swipe off on /drive.
  test('a left-edge swipe opens nothing and the driving controls keep working', async ({ page }) => {
    await page.goto('/drive')
    const screen = page.getByTestId('drive-screen')
    await expect(screen).toBeVisible()
    const start = page.getByRole('button', { name: 'Start driving' })
    await expect(start).toBeVisible()
    const l = fromLeft(page)
    await swipe(page, l.from, l.to)
    await page.waitForTimeout(300)
    await expect(page.getByTestId('phone-menu')).toHaveCount(0)
    await expect(screen).not.toHaveCSS('pointer-events', 'none')
    const box = await start.boundingBox()
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null,
      { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
    )
    expect(hit).toBe('Start driving')
  })
})

test.describe('H2: /card/:id is a thread screen', () => {
  // Fix: resolve the thread id from the card as well, or have ThreadView publish it.
  test('the context ring opens the session panel', async ({ page }) => {
    await openCard(page)
    await page.getByTestId('session-trigger').click()
    await expect(page.getByTestId('session-sheet')).toBeVisible()
  })

  test('a right-edge swipe opens the session panel', async ({ page }) => {
    await openCard(page)
    const r = fromRight(page)
    await swipe(page, r.from, r.to)
    await expect(page.getByTestId('session-sheet')).toBeVisible()
  })

  test('the menu keeps Thread settings for the thread on screen', async ({ page }) => {
    await openCard(page)
    await openPhoneMenu(page)
    await expect(page.getByTestId('phone-menu').getByTestId('thread-settings-trigger')).toBeVisible()
  })
})

// These read as merge guards. `html[data-kb]` and `.kb-hide-short` arrive with PR #93, so they cannot pass on this head
// alone. After both PRs land they stay red unless the ThreadScreen conflict is resolved by carrying `kb-hide-short` onto
// PhoneHeader and keeping the wrapper around Banners. Same 667 x 375 landscape phone as PR #93's `max-height: 520px` rule.
test.describe('H3: the landscape keyboard rule survives the merge with PR #93', () => {
  test.use({ viewport: { width: 667, height: 375 } })

  const keyboardUp = (page: Page) =>
    page.evaluate(() => {
      document.documentElement.dataset.kb = 'open'
    })

  test('the phone header gives its room to the message box', async ({ page }) => {
    await openThread(page)
    const header = page.getByTestId('phone-header')
    await expect(header).toBeVisible()
    await keyboardUp(page)
    await expect(header).toBeHidden()
  })

  test('banners give their room to the message box', async ({ page }) => {
    await openThread(page)
    await fake(page, (t) => t.setMacOnline(false))
    // the thread banner, not a message row's empty Copy note (also role=status)
    const banner = page.getByTestId('thread-screen').getByRole('status').filter({ hasText: /\S/ }).first()
    await expect(banner).toBeVisible()
    await keyboardUp(page)
    await expect(banner).toBeHidden()
  })
})

test.describe('M: the owner can still tell something is waiting', () => {
  // Fix: a badge or dot on the menu button, with the counts in its aria-label.
  test('an unread message in another thread shows on the menu button', async ({ page }) => {
    await openThread(page)
    const button = page.getByTestId('phone-menu-button')
    await fake(page, (t) => t.store.setState(() => ({ unread: {}, cards: [], inbox: [] })))
    await expect(button).toHaveAttribute('aria-label', 'Open menu')
    const quiet = await button.innerHTML()
    await fake(page, (t) => t.store.setState(() => ({ unread: { inbox: 3 } })))
    await expect(button).toHaveAttribute('aria-label', /3 unread/)
    expect(await button.innerHTML(), 'something visible must change on the button').not.toBe(quiet)
  })
})

test.describe('M: the owner nit from the screenshots', () => {
  // Fix: keep one. Thread settings has to survive whichever row goes.
  test('the menu lists the current thread once', async ({ page }) => {
    await openThread(page)
    await openPhoneMenu(page)
    const menu = page.getByTestId('phone-menu')
    await expect(menu.getByText('General', { exact: true })).toHaveCount(1)
    await expect(menu.getByTestId('thread-settings-trigger')).toBeVisible()
  })
})
