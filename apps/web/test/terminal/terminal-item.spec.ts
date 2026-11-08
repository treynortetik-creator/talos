// The Terminal item in a real browser: absent in a browser and on a phone, present in the Mac app (a page that looks like
// the Mac app's web view), and the room it reports matches where the page really laid it out.
import { expect, type Page, test } from '@playwright/test'

type Posted = Array<{ type: string; rect?: { x: number; y: number; width: number; height: number } | null }>
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: Posted }).__posted)

async function pretendMacApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __posted: unknown[]; webkit?: unknown }
    w.__posted = []
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { talos: { postMessage: (m: unknown) => w.__posted.push(m) } } },
    })
  })
}

test.describe('in a browser', () => {
  test('there is no Terminal item, and /terminal goes to Home', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Terminal' })).toHaveCount(0)
    await page.goto('/terminal')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('terminal-space')).toHaveCount(0)
  })
})

test.describe('in the Mac app', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh) TalosDesktop/1.0' })

  test('the sidebar has Terminal, and its screen reports the room it left', async ({ page }, info) => {
    await pretendMacApp(page)
    await page.goto('/')
    const phone = (page.viewportSize()?.width ?? 0) < 768
    if (phone) {
      // the sidebar is a tablet and desktop piece; the phone has no Terminal item even inside the Mac app
      await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible()
      await expect(page.getByRole('link', { name: 'Terminal' })).toHaveCount(0)
      return
    }
    expect(info.project.name).toBe('desktop')
    await page.getByRole('link', { name: 'Terminal' }).click()
    await expect(page).toHaveURL(/\/terminal$/)
    const space = page.getByTestId('terminal-space')
    await expect(space).toBeVisible()
    const box = await space.boundingBox()
    if (!box) throw new Error('no box')
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.type === 'terminal_view').at(-1)?.rect)
      .toEqual({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      })
    const before = (await posted(page)).filter((m) => m.type === 'terminal_view').length
    // folding the sidebar gives the terminal more room, and the shell is told
    await page.getByTestId('sidebar-toggle').click()
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.type === 'terminal_view').length)
      .toBeGreaterThan(before)
    const wider = await space.boundingBox()
    expect(wider?.width ?? 0).toBeGreaterThan(box.width)
    await page.getByRole('link', { name: 'Schedules' }).click()
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.type === 'terminal_view').at(-1)?.rect)
      .toBeNull()
  })
})
