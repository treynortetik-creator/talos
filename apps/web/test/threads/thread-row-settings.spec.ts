// The "..." at the right end of each thread row (the sidebar on tablet and desktop, the Threads list on a phone): it opens THAT
// thread's settings sheet (ThreadEditor, with Own session and Park / Restart), never navigates the row, is hidden until hover or
// keyboard focus on a mouse and always there on touch, and is absent from Schedules. Real browser, fake mode (VITE_FAKE=1),
// both themes. Screenshots go to $SHOT_DIR when it is set (outside the repo).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })
const SHOTS = process.env.SHOT_DIR

type Talos = {
  store: {
    getState: () => { config: { threads: Array<Record<string, unknown>> } }
    setState: (f: (s: never) => never) => void
  }
  patchConfig: (p: Record<string, unknown>) => Promise<void>
  emit: (type: string, fields: Record<string, unknown>) => void
}

async function open(page: Page, go = true) {
  if (go) await page.goto(isPhoneWidth(page) ? '/threads' : '/')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async () => {
    const c = (window as unknown as { __talos: Talos }).__talos
    const cur = c.store.getState().config.threads
    const mk = (id: string, name: string, order: number) => ({
      id,
      name,
      kind: 'fixed',
      order,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    })
    await c.patchConfig({
      threads: [...cur, { ...mk('work', 'Work', 2), session: 'dedicated' }, mk('daily', 'Daily', 3)],
      dedicated: { enabled: true },
    })
    c.store.setState(((s: { presence: { features?: string[] } }) => ({
      presence: { ...s.presence, features: [...(s.presence.features ?? []), 'thread-sessions/1'] },
    })) as never)
    c.emit('workers.status', {
      status: {
        supported: true,
        supervisor_online: true,
        threads: [{ thread_id: 'work', state: 'live' }],
        governor: { state: 'ok' },
        at: new Date().toISOString(),
      },
    })
  })
}

/** The list the ... sits in: the sidebar on a wide screen, the page on a phone. */
const scope = (page: Page) =>
  isPhoneWidth(page) ? page.getByRole('main') : page.getByRole('complementary', { name: 'Sidebar' })
const more = (page: Page, name: string) =>
  scope(page).getByRole('button', { name: `Thread settings for ${name}`, exact: true })
const opacity = (el: ReturnType<typeof more>) => el.evaluate((e) => Number(getComputedStyle(e).opacity))
const isTouch = (page: Page) =>
  page.evaluate(() => matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches)

async function shot(page: Page, name: string, info: { project: { name: string } }, theme: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}-${theme}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('talos-theme', t), theme)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    })

    test('a ... on every thread row, named for its thread, none on Schedules, header pencil kept', async ({
      page,
    }, info) => {
      await open(page)
      await shot(page, 'list-rest', info, theme)
      for (const n of ['General', 'Work', 'Daily', 'Inbox']) await expect(more(page, n)).toHaveCount(1)
      await expect(scope(page).getByRole('button', { name: /^Thread settings for/ })).toHaveCount(4)
      // Schedules is not a thread: on a wide screen it is a sidebar row, and its row has no button beside it
      if (!isPhoneWidth(page)) {
        const sched = scope(page).getByRole('link', { name: /Schedules$/ })
        await expect(sched).toBeVisible()
        await expect(page.getByRole('button', { name: /Thread settings for Schedules/ })).toHaveCount(0)
        // its row is a bare link in the nav (no group around it holding a button), and nothing after it is a "..."
        await expect(sched.locator('xpath=parent::*[@id="sidebar-nav"]')).toHaveCount(1)
        await expect(sched.locator('xpath=following-sibling::*[@data-testid]')).toHaveCount(0)
        await expect(sched.locator('[data-testid^="thread-more-"]')).toHaveCount(0)
      }
      const pencil = page.locator('[data-testid="edit-threads"]:visible')
      await expect(pencil).toHaveCount(1) // the header pencil / Edit stays
      await pencil.click()
      await expect(pencil).toHaveAttribute('aria-pressed', 'true') // and still opens the reorder mode
      await expect(more(page, 'Work')).toHaveCount(0) // which lists the threads with its own gear instead
      await pencil.click()
    })

    test("it opens that thread's settings, with Own session and Park now on Work, and the row does not navigate", async ({
      page,
    }, info) => {
      await open(page)
      const before = page.url()
      await more(page, 'Work').click()
      const sheet = page.getByTestId('thread-settings')
      await expect(sheet).toBeVisible()
      await expect(sheet.getByLabel('Name')).toHaveValue('Work')
      await expect(sheet.getByTestId('own-session')).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Park now' })).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Restart' })).toBeVisible()
      expect(page.url()).toBe(before) // the click did not follow the row's link
      await expect(page.getByTestId('thread-settings-trigger')).toHaveCount(0) // not a thread screen: no header menu either
      await shot(page, 'work-settings', info, theme)
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      // a second row gets its own thread, not the first one's
      await more(page, 'Daily').click()
      await expect(sheet.getByLabel('Name')).toHaveValue('Daily')
      await expect(sheet.getByTestId('own-session')).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Park now' })).toHaveCount(0) // Daily has no live worker
    })

    test('General and Inbox still open settings (name and notifications) with no Own session', async ({ page }) => {
      await open(page)
      const sheet = page.getByTestId('thread-settings')
      await more(page, 'General').click()
      await expect(sheet.getByLabel('Name')).toHaveValue('General')
      await expect(sheet.getByRole('group', { name: 'Notifications' })).toBeVisible()
      await expect(sheet.getByTestId('own-session')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      await more(page, 'Inbox').click()
      await expect(sheet.getByRole('group', { name: 'Notifications' })).toBeVisible()
      await expect(sheet.getByTestId('own-session')).toHaveCount(0)
    })

    test('mouse: hidden at rest, there on hover and on keyboard focus; touch: always there', async ({ page }, info) => {
      await open(page)
      const btn = more(page, 'Work')
      // the phone projects must take the touch branch: never let a phone run the mouse checks by accident
      expect(await isTouch(page)).toBe(info.project.name !== 'desktop')
      if (await isTouch(page)) {
        expect(await opacity(btn)).toBe(1)
        const box = await btn.boundingBox()
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(40) // a thumb-sized target
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40)
        await btn.tap()
        await expect(page.getByTestId('thread-settings')).toBeVisible()
      } else {
        expect(await opacity(btn)).toBe(0)
        await scope(page).getByRole('link', { name: /^Work/ }).hover()
        await expect.poll(() => opacity(btn)).toBe(1)
        await page.mouse.move(700, 400)
        await expect.poll(() => opacity(btn)).toBe(0)
        // by keyboard: Tab from the row's link lands on the ... and it shows
        await scope(page).getByRole('link', { name: /^Work/ }).focus()
        await page.keyboard.press('Tab')
        await expect(btn).toBeFocused()
        await expect.poll(() => opacity(btn)).toBe(1)
        await shot(page, 'more-focused', info, theme)
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('thread-settings')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('thread-settings')).toBeHidden()
        await expect(btn).toBeFocused() // focus comes back to the button that opened it
      }
    })

    test('no sideways scroll, axe clean with the buttons showing', async ({ page }) => {
      await open(page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await expectAxeClean(page, [isPhoneWidth(page) ? 'main' : 'aside'])
    })
  })
}

test('the row keeps navigating when the row itself is clicked', async ({ page }) => {
  await open(page)
  await scope(page).getByRole('link', { name: /^Work/ }).click()
  await expect(page).toHaveURL(/\/t\/work$/)
})

test('the ... never covers an unread badge', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const c = (window as unknown as { __talos: { markThreadUnread: (id: string) => void } }).__talos
    for (const id of ['work', 'daily', 'inbox']) c.markThreadUnread(id)
  })
  const badges = scope(page).getByRole('img', { name: /\d+ unread/ })
  await expect(badges.first()).toBeVisible()
  for (const name of ['General', 'Work', 'Daily', 'Inbox']) {
    const b = more(page, name)
    const row = b.locator('xpath=..')
    const bb = await b.boundingBox()
    for (const badge of await row.getByRole('img', { name: /\d+ unread/ }).all()) {
      const r = await badge.boundingBox()
      expect(r && bb ? r.x + r.width <= bb.x + 1 : false, `${name}: badge ends before the ...`).toBe(true)
    }
  }
})

test('phone: the left menu rows have a ... too, and it opens that thread without leaving the page', async ({
  page,
}) => {
  test.skip(!isPhoneWidth(page), 'the left menu is the phone chrome')
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await open(page, false)
  await page.getByTestId('phone-menu-button').click()
  const menu = page.getByTestId('phone-menu')
  await expect(menu).toBeVisible()
  const btn = menu.getByRole('button', { name: 'Thread settings for Work', exact: true })
  expect(await opacity(btn)).toBe(1)
  await btn.click()
  const sheet = page.getByTestId('thread-settings')
  await expect(sheet.getByLabel('Name')).toHaveValue('Work')
  await expect(page).toHaveURL(/\/t\/general$/)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(btn).toBeFocused()
})
