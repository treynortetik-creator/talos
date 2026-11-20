// Stacked panes beside the chat, and the Files pane (owner-approved design, 2026-11-11). On a wide screen the thread header has
// a pane toolbar (Files, Pages, +; Terminal only in the Mac app); panes stack in a column on the right of the chat, each can
// be collapsed to its title bar or closed, and the layout is remembered per thread on this device. Files lists the files
// sent in Talos (the thread's folder is under Memory: test/memory/agent-folders.spec.ts). On a phone, Files is a bottom
// sheet and there is no terminal.

import { expect, type Locator, type Page, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR42mNk+M9Qz0AEYBxVSF+FjP8ZGBgYGBhGFQ4VhQAAqHQFEVRXxsQAAAAASUVORK5CYII=',
  'base64',
)
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 TalosDesktop/1.0'

async function open(page: Page, thread = 'general') {
  await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.goto(`/t/${thread}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}

/** Adds the thread `work`, whose folder on the fake Mac is ~/Projects/atlas. */
async function seedWork(page: Page) {
  await page.evaluate(async () => {
    const c = (
      window as unknown as {
        __talos: {
          store: { getState: () => { config: { threads: Array<{ id: string }> } } }
          patchConfig: (p: unknown) => Promise<void>
        }
      }
    ).__talos
    const keep = c.store.getState().config.threads.filter((t) => t.id !== 'work')
    await c.patchConfig({
      threads: [
        ...keep,
        {
          id: 'work',
          name: 'Work',
          kind: 'fixed',
          order: 2,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
        },
      ],
    })
  })
}

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

test.describe('wide screens', () => {
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'the phone has its own Library sheet'))

  test('the pane toolbar opens the Library beside the chat; it collapses, closes, and is remembered per thread', async ({
    page,
  }, info) => {
    await open(page)
    const bar = page.getByRole('toolbar', { name: 'Panes' })
    await expect(bar.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'false')
    // Files and Pages are one now
    await expect(bar.getByRole('button', { name: 'Files' })).toHaveCount(0)
    await expect(bar.getByRole('button', { name: 'Pages' })).toHaveCount(0)
    // no + menu: it only repeated the buttons (owner, 2026-11-15)
    await expect(bar.getByRole('button', { name: 'Add a pane' })).toHaveCount(0)
    // a browser is not the Mac app: no terminal
    await expect(bar.getByRole('button', { name: 'Terminal' })).toHaveCount(0)
    const column = page.getByRole('complementary', { name: 'Panes' })
    await expect(column).toHaveCount(0)

    await bar.getByRole('button', { name: 'Library' }).click()
    // the column took the room: the header names no panes now; the thread menu has them
    await expect(bar).toHaveCount(0)
    const lib = column.getByRole('region', { name: 'Library' })
    await expect(lib).toBeVisible()
    const sent = lib.getByTestId('sent-files')
    await expect(sent.getByRole('table')).toBeVisible()
    await expect(sent.getByTestId('sent-file').first()).toBeVisible()
    const chat = await box(page.getByTestId('thread-screen'))
    expect((await box(column)).x).toBeGreaterThanOrEqual(chat.x + chat.width - 1)
    await page.mouse.move(1, 1)
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    await page.screenshot({ path: info.outputPath('panes-library.png') })

    // alone in its column there is nothing to fold it for: only the X (owner, 2026-11-15)
    await expect(lib.getByRole('button', { name: 'Collapse Library' })).toHaveCount(0)
    await expect(lib.getByRole('button', { name: 'Close Library' })).toBeVisible()

    // remembered on this device, for this thread only
    await page.reload()
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    await expect(column.getByRole('region', { name: 'Library' })).toBeVisible()
    await seedWork(page)
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: /^Work/ }).click()
    await expect(page).toHaveURL(/\/t\/work$/)
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    await expect(column).toHaveCount(0)
    await bar.getByRole('button', { name: 'Library' }).click()
    await expect(column.getByRole('region', { name: 'Library' }).getByTestId('sent-files')).toBeVisible()

    // closed: gone, and the toolbar says so
    await column.getByRole('region', { name: 'Library' }).getByRole('button', { name: 'Close Library' }).click()
    await expect(column).toHaveCount(0)
    await expect(bar.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('a pane left folded in a saved layout opens full when it is alone', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('talos.panes', JSON.stringify({ general: { open: ['library'], collapsed: ['library'] } })),
    )
    await open(page)
    const lib = page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' })
    await expect(lib.getByTestId('sent-files')).toBeVisible()
    await expect(lib.getByRole('button', { name: 'Expand Library' })).toHaveCount(0)
  })

  test('a layout kept from before opens the Library where Files or Pages were', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('talos.panes', JSON.stringify({ general: { open: ['files', 'pages'], collapsed: [] } })),
    )
    await open(page)
    const column = page.getByRole('complementary', { name: 'Panes' })
    await expect(column.getByRole('region', { name: 'Library' })).toHaveCount(1)
  })

  test('a Mac too old to list sent files: the Library says to update it', async ({ page }) => {
    await open(page)
    await page.evaluate(() => {
      const c = (
        window as unknown as {
          __talos: {
            store: {
              setState: (f: (s: { presence: { features?: string[] } }) => unknown) => void
            }
          }
        }
      ).__talos
      c.store.setState((s) => ({
        presence: { ...s.presence, features: (s.presence.features ?? []).filter((f) => f !== 'files-sent/1') },
      }))
    })
    await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
    const files = page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' })
    await expect(files.getByTestId('sent-files-unavailable')).toHaveText('Update Talos on your Mac to see sent files.')
  })
})

test.describe('a narrow header', () => {
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'the phone has its own header'))

  test('too narrow to name the panes: only the thread menu, which lists them; with room, the named buttons', async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await open(page)
    // open the Library: the column takes the room, and the header is now too narrow to name its panes
    await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
    await expect(page.getByRole('toolbar', { name: 'Panes' })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('header-narrow.png') })
    await page.getByRole('button', { name: 'Thread menu' }).click()
    const row = page.getByRole('menuitemcheckbox', { name: 'Hide Library' })
    await expect(row).toHaveAttribute('aria-checked', 'true')
    await row.click()
    await expect(page.getByRole('complementary', { name: 'Panes' })).toHaveCount(0)
    // the room is back: the named button again, and no pane rows in the menu
    await expect(page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('header-wide.png') })
    await page.getByRole('button', { name: 'Thread menu' }).click()
    await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0)
  })
})

test.describe('in the Mac app', () => {
  test.use({ userAgent: DESKTOP_UA })
  test.beforeEach(async ({ page }) => {
    test.skip(isPhoneWidth(page), 'the Mac app is not a phone')
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>
      w.webkit = { messageHandlers: { talos: { postMessage: () => undefined } } }
    })
  })

  test('the toolbar has a Terminal pane, which stacks with the Library', async ({ page }, info) => {
    await open(page)
    const bar = page.getByRole('toolbar', { name: 'Panes' })
    await bar.getByRole('button', { name: 'Library' }).click()
    // the header is narrow now: the Terminal is a row of the thread menu
    await page.getByRole('button', { name: 'Thread menu' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Show Terminal' }).click()
    const column = page.getByRole('complementary', { name: 'Panes' })
    await expect(column.getByRole('region', { name: 'Terminal' })).toBeVisible()
    await expect(column.getByRole('region', { name: 'Library' }).getByTestId('sent-file').first()).toBeVisible()
    // two in the column: each can fold to give the other the room
    const lib = column.getByRole('region', { name: 'Library' })
    await lib.getByRole('button', { name: 'Collapse Library' }).click()
    expect((await box(lib)).height).toBeLessThan(60)
    expect((await box(column.getByRole('region', { name: 'Terminal' }))).height).toBeGreaterThan(300)
    await lib.getByRole('button', { name: 'Expand Library' }).click()
    await page.mouse.move(1, 1)
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    await page.screenshot({ path: info.outputPath('mac-files-terminal.png') })
  })
})

test.describe('phones', () => {
  test.beforeEach(({ page }) => test.skip(!isPhoneWidth(page), 'wide screens have the pane column'))

  test('the Library opens as a bottom sheet listing the pages and files sent in Talos; no terminal, no pane toolbar', async ({
    page,
  }, info) => {
    await open(page)
    await expect(page.getByRole('toolbar', { name: 'Panes' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Terminal/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Files' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Pages' })).toHaveCount(0)
    const button = page.getByRole('button', { name: 'Library' })
    const b = await box(button)
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44)
    await button.click()
    const sheet = page.getByRole('dialog', { name: 'Library' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('Pages and files, from your agent and from you')).toBeVisible()
    await expect(sheet.getByTestId('sent-file').first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    await page.screenshot({ path: info.outputPath('phone-library-sheet.png') })
    await sheet.getByRole('button', { name: 'Close Library' }).click()
    await expect(sheet).toHaveCount(0)
  })
})
