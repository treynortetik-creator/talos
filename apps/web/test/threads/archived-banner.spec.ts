import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

// O19: an archived thread says so and offers Restore; the composer stays on. Fake mode (VITE_FAKE=1). The thread is archived
// through the same owner-signed config patch the row menu uses, then opened in-app (the fake's state lives in the page).

type Fake = {
  store: {
    getState(): {
      threads: Array<{ id: string; kind: string; archived: boolean }>
      config: { default_thread: string }
    }
  }
  sent: Array<Record<string, unknown>>
  patchConfig(p: Record<string, unknown>): Promise<void>
  setMacOnline(b: boolean): void
}

async function archiveOne(page: Page): Promise<string> {
  await page.goto('/threads')
  await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible()
  return page.evaluate(async () => {
    const c = (window as unknown as { __talos: Fake }).__talos
    const s = c.store.getState()
    // the fake starts with General and Inbox only: add one more thread, already archived
    const plans = {
      id: 'plans',
      name: 'Plans',
      kind: 'agent',
      order: 5,
      notify: 'all',
      voice_context: 'recent',
      archived: true,
      created_at: '2026-10-28T00:00:00.000Z',
    }
    await c.patchConfig({ threads: [...s.threads, plans] })
    return plans.id
  })
}
// Switching the colour scheme starts a 140ms colour fade on buttons and borders (prefers-reduced-motion does not stop it),
// so for a moment the Restore label is still the light theme's dark ink on the dark banner. Axe reads computed colours and
// would report that as a contrast failure. Wait for the browser's own list of running transitions to empty.
const themeSettled = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      const running = document.getAnimations().filter((a) => a instanceof CSSTransition)
      if (running.length === 0) return
      await Promise.allSettled(running.map((a) => a.finished))
    }
  })
const goTo = (page: Page, id: string) =>
  page.evaluate((tid) => {
    history.pushState({}, '', `/t/${tid}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, id)
const archivedNow = (page: Page, id: string) =>
  page.evaluate(
    (tid) =>
      (window as unknown as { __talos: Fake }).__talos.store.getState().threads.find((t) => t.id === tid)?.archived,
    id,
  )

test('an archived thread shows the banner and a live composer; Restore brings it back', async ({ page }) => {
  const id = await archiveOne(page)
  await goTo(page, id)
  const banner = page.getByTestId('archived-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Archived')
  await expect(page.getByRole('textbox').last()).toBeVisible() // the composer is still there
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const restore = banner.getByRole('button', { name: 'Restore' })
  expect((await restore.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  // axe on the banner itself, in both themes (the rest of the thread screen is not this change's to judge)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await themeSettled(page)
    const bad = (await new AxeBuilder({ page }).include('[data-testid="archived-banner"]').analyze()).violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    )
    expect(
      bad.map((v) => v.id),
      colorScheme,
    ).toEqual([])
  }
  const before = await page.evaluate(() => (window as unknown as { __talos: Fake }).__talos.sent.length)
  await restore.click()
  await expect(banner).toHaveCount(0)
  expect(await archivedNow(page, id)).toBe(false)
  const sent = await page.evaluate(
    (n) => (window as unknown as { __talos: Fake }).__talos.sent.slice(n).map((f) => f.type),
    before,
  )
  expect(sent).toEqual(['config.patch'])
  await expect(page.getByRole('textbox').last()).toBeVisible()
})

test('Mac offline: Restore is off and says why; back online it works', async ({ page }) => {
  const id = await archiveOne(page)
  await goTo(page, id)
  await page.evaluate(() => (window as unknown as { __talos: Fake }).__talos.setMacOnline(false))
  const banner = page.getByTestId('archived-banner')
  await expect(banner.getByRole('button', { name: 'Restore' })).toBeDisabled()
  await expect(banner).toContainText('Your Mac has to be online for this.')
  await page.evaluate(() => (window as unknown as { __talos: Fake }).__talos.setMacOnline(true))
  await expect(banner.getByRole('button', { name: 'Restore' })).toBeEnabled()
  await banner.getByRole('button', { name: 'Restore' }).click()
  await expect(banner).toHaveCount(0)
})

test('a thread that is not archived has no banner', async ({ page }) => {
  await page.goto('/t/general')
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await expect(page.getByTestId('archived-banner')).toHaveCount(0)
})

test('a landscape phone with the keyboard up gives the banner back to the composer; it returns with the keyboard down', async ({
  page,
}) => {
  const id = await archiveOne(page)
  await page.setViewportSize({ width: 844, height: 390 })
  await goTo(page, id)
  const banner = page.getByTestId('archived-banner')
  await expect(banner).toBeVisible()
  // Resizing the window fires a `resize` event, and the keyboard code answers it two animation frames later by re-deciding
  // `data-kb` from the layout (a mouse or desktop-sized window: no keyboard, so it clears the flag). Setting the flag while
  // that answer is still pending lets the pending answer wipe it. Let the viewport change settle first: one frame so the
  // event has fired, then three more so its two-frame answer has run.
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
  // the same switch the keyboard code sets (keyboardViewport.ts) when little room is left above the keyboard
  await page.evaluate(() => document.documentElement.setAttribute('data-kb', ''))
  await expect(banner).toBeHidden()
  await expect(page.getByRole('textbox').last()).toBeVisible() // the composer keeps the room
  await page.evaluate(() => document.documentElement.removeAttribute('data-kb'))
  await expect(banner).toBeVisible()
})
