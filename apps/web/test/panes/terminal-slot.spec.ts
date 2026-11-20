// The Terminal pane's slot in the Mac app (docs/TERMINAL-PANE.md): the page says where the slot is and for which thread
// (`shell_pane`), `rect: null` while it is not showing (collapsed, a menu or dialog over it), one message per thread switch,
// and `shell_pane_close` only for the owner's own close. Strict shapes: nothing else in them. The Mac app is faked by its
// message handler; its user agent lists `shell-pane` (or, for an older app, does not).
import { expect, type Page, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const UA = (features: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 TalosDesktop/1.0${features ? ` TalosFeatures/${features}` : ''}`

type Post = { type: string; thread_id?: string; rect?: { x: number; y: number; width: number; height: number } | null }
const posts = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __posts: Post[] }).__posts ?? []).filter((p) => p.type.startsWith('shell_pane')),
  )
const last = async (page: Page) => (await posts(page)).at(-1)

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__posts = []
    w.webkit = { messageHandlers: { talos: { postMessage: (m: unknown) => (w.__posts as unknown[]).push(m) } } }
  })
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}
const terminalButton = (page: Page) =>
  page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Terminal' })
const region = (page: Page) =>
  page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Terminal' })

test.describe('with the shell-pane feature', () => {
  test.use({ userAgent: UA('pick-folder,shell-pane') })
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'the Mac app'))

  test('says where the slot is, null while it is not showing, and closes only on the owner close', async ({ page }) => {
    await open(page)
    await terminalButton(page).click()
    const slot = page.getByTestId('terminal-slot')
    await expect(slot).toBeVisible()
    // where the slot is, in whole CSS pixels, for this thread, and nothing else in the message
    await expect.poll(async () => (await last(page))?.rect ?? null).not.toBeNull()
    const b = await slot.boundingBox()
    const m = await last(page)
    expect(Object.keys(m ?? {}).sort()).toEqual(['rect', 'thread_id', 'type'])
    expect(m).toMatchObject({ type: 'shell_pane', thread_id: 'general' })
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Number.isInteger(m?.rect?.[k])).toBe(true)
    expect(Math.abs((m?.rect?.x ?? 0) - (b?.x ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((m?.rect?.width ?? 0) - (b?.width ?? 0))).toBeLessThanOrEqual(1)
    expect(m?.rect?.width).toBeGreaterThanOrEqual(180)
    expect(m?.rect?.height).toBeGreaterThanOrEqual(110)

    // collapsed: null; expanded again: the rect. A pane alone in its column has no fold (e41d7488), so the Library joins it
    // (the header is too narrow to name the panes now: the thread menu lists them, 5b9602ff)
    await page.getByRole('button', { name: 'Thread menu' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Show Library' }).click()
    await expect(
      page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' }),
    ).toBeVisible()
    await region(page).getByRole('button', { name: 'Collapse Terminal' }).click()
    await expect.poll(async () => (await last(page))?.rect).toBeNull()
    await region(page).getByRole('button', { name: 'Expand Terminal' }).click()
    await expect.poll(async () => (await last(page))?.rect ?? null).not.toBeNull()

    // a menu over the page: null (the native view would hide it); gone again: the rect
    await page.getByRole('button', { name: 'Thread menu' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect.poll(async () => (await last(page))?.rect).toBeNull()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await last(page))?.rect ?? null).not.toBeNull()

    // a dialog: null
    await page.getByRole('button', { name: 'Thread menu' }).click()
    await page.getByRole('menuitem', { name: 'Thread settings' }).click()
    await expect(page.getByTestId('thread-settings')).toBeVisible()
    await expect.poll(async () => (await last(page))?.rect).toBeNull()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await last(page))?.rect ?? null).not.toBeNull()

    // the window resizes: the new size is sent
    const before = (await last(page))?.rect
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect.poll(async () => (await last(page))?.rect?.height).not.toBe(before?.height)

    // the owner closes it: shell_pane_close for this thread, strict
    await region(page).getByRole('button', { name: 'Close Terminal' }).click()
    const all = await posts(page)
    const close = all.filter((p) => p.type === 'shell_pane_close')
    expect(close).toEqual([{ type: 'shell_pane_close', thread_id: 'general' }])
  })

  test('switching threads is one message with the new id; a pane collapsed or hidden is never a close', async ({
    page,
  }) => {
    await open(page)
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
    await terminalButton(page).click()
    await expect.poll(async () => (await last(page))?.thread_id).toBe('general')
    // open the pane in Work too, then come back: the switch is one shell_pane with the new id and a rect
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: /^Work/ }).click()
    await terminalButton(page).click()
    await expect.poll(async () => (await last(page))?.thread_id).toBe('work')
    const n = (await posts(page)).length
    await page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByRole('link', { name: /^General/ })
      .click()
    await expect.poll(async () => (await last(page))?.thread_id).toBe('general')
    const switched = (await posts(page)).slice(n)
    expect(switched.filter((p) => p.rect === null)).toEqual([]) // not a "hide work" first
    expect(switched[0]).toMatchObject({ type: 'shell_pane', thread_id: 'general' })
    expect(switched[0]?.rect).not.toBeNull()
    expect((await posts(page)).filter((p) => p.type === 'shell_pane_close')).toEqual([])
  })
})

test.describe('an older Mac app (no shell-pane feature)', () => {
  test.use({ userAgent: UA('pick-folder') })
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'the Mac app'))

  test('the slot says where the terminal is, and nothing is posted about it', async ({ page }) => {
    await open(page)
    await terminalButton(page).click()
    await expect(page.getByTestId('terminal-slot')).toHaveText('Terminal is available in the Talos Mac app')
    await region(page).getByRole('button', { name: 'Close Terminal' }).click()
    expect(await posts(page)).toEqual([])
  })
})
