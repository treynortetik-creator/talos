import { expect, type Page, test } from '@playwright/test'
import { expectPurpose, openPhoneMenu, openThreadSettings } from '../helpers/phone.ts'

// Thread management (docs/THREADS.md) in fake mode (VITE_FAKE=1): create with icon and color, rename, reorder (drag,
// keyboard, arrows), archive and restore, default thread. Screenshots for the PR land in docs/screenshots/threads/.
const SHOTS = '../../docs/screenshots/threads'
const isDesktop = (name: string) => name === 'desktop'

// The fake client lives in memory, so specs navigate inside the app (never page.goto after the first load).
async function start(page: Page, desktop: boolean) {
  await page.goto(desktop ? '/' : '/threads')
}

/** The visible thread list surface: the sidebar on desktop, the Threads tab on phones. */
async function openList(page: Page, desktop: boolean) {
  if (desktop) return page.getByLabel('Sidebar')
  const menu = page.getByRole('button', { name: 'Open menu' })
  const tab = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Threads' })
  await expect(menu.or(tab)).toBeVisible()
  if (await menu.isVisible()) {
    await menu.click()
    await page.getByTestId('phone-menu').getByRole('link', { name: 'All threads' }).click()
  } else await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Threads' }).click()
  await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible()
  return page.locator('main')
}

async function openThread(page: Page, desktop: boolean, id: string, name: string) {
  if (desktop) {
    const done = page.getByLabel('Sidebar').getByRole('button', { name: 'Done managing threads' })
    if (await done.isVisible()) await done.click()
    await page
      .getByLabel('Sidebar')
      .getByRole('link', { name: new RegExp(name) })
      .click()
  } else {
    await openList(page, false)
    const done = page.getByTestId('edit-threads').filter({ visible: true })
    if ((await done.textContent()) === 'Done') await done.click()
    await page.getByTestId(`thread-row-${id}`).click()
  }
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

async function createThread(
  page: Page,
  desktop: boolean,
  t: { name: string; icon: string; color: string; topic?: string; makeDefault?: boolean },
) {
  const scope = await openList(page, desktop)
  await scope.getByTestId('new-thread').click()
  const sheet = page.getByTestId('thread-settings')
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Name').fill(t.name)
  await sheet.getByRole('button', { name: `${t.color} color`, exact: true }).click()
  await sheet.getByLabel('Search icons').fill(t.icon)
  await sheet.getByRole('button', { name: `${t.icon} icon`, exact: true }).click()
  if (t.topic) await sheet.getByLabel('What goes here').fill(t.topic)
  if (t.makeDefault) await sheet.getByLabel(/Default thread/).check()
  await sheet.getByRole('button', { name: 'Create thread' }).click()
  await expect(sheet).toBeHidden()
}

async function order(page: Page): Promise<string[]> {
  return page
    .getByTestId('thread-order')
    .filter({ visible: true })
    .locator('[data-reorder-row]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-reorder-row') ?? ''))
}

async function editMode(page: Page, desktop: boolean) {
  const scope = await openList(page, desktop)
  const btn = scope.getByTestId('edit-threads')
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click()
  await expect(page.getByTestId('thread-order').filter({ visible: true })).toBeVisible()
}

test('create a thread with an icon, a color and a topic; it shows in the list with that color', async ({
  page,
}, info) => {
  const desktop = isDesktop(info.project.name)
  await start(page, desktop)
  await createThread(page, desktop, { name: 'App build', icon: 'Hammer', color: 'Orange', topic: 'Builds and CI' })
  const scope = desktop ? page.getByLabel('Sidebar') : page.locator('main')
  if (!desktop)
    await expect(scope.getByTestId('thread-row-app_build').locator('[data-thread-color="orange"]')).toBeVisible()
  await openThread(page, desktop, 'app_build', 'App build')
  await expectPurpose(page, 'Builds and CI')
  if (desktop) {
    await expect(page.getByTestId('thread-screen').locator('[data-thread-color="orange"]').first()).toBeVisible()
  } else {
    // the slim phone header has no icon; the thread's colour shows on its card in the menu
    await openPhoneMenu(page)
    await expect(page.getByTestId('phone-menu-current').locator('[data-thread-color="orange"]').first()).toBeVisible()
    await page.keyboard.press('Escape')
  }
  if (desktop) await expect(scope.locator('[data-thread-color="orange"]')).toHaveCount(1)
})

test('rename keeps the id; archive and restore from edit mode; default thread', async ({ page }, info) => {
  const desktop = isDesktop(info.project.name)
  await start(page, desktop)
  await createThread(page, desktop, { name: 'Day job', icon: 'Briefcase', color: 'Hot pink' })
  await openThread(page, desktop, 'day_job', 'Day job')
  await openThreadSettings(page)
  const sheet = page.getByTestId('thread-settings')
  await sheet.getByLabel('Name').fill('Work stuff')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  // the default thread is set under Settings -> Agent now (the sheet's checkbox is gone); same patch, same rules
  await page.evaluate(() =>
    (window as unknown as { __talos: { patchConfig(p: object): Promise<void> } }).__talos.patchConfig({
      default_thread: 'day_job',
    }),
  )
  await expect(page).toHaveURL(/\/t\/day_job$/) // same id after the rename
  await expect(page.getByRole('heading', { name: 'Work stuff' })).toBeVisible()

  // the default thread can't be archived; General can once it isn't the default
  await openThreadSettings(page)
  await expect(sheet.getByLabel(/Default thread/)).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Archive thread' })).toBeDisabled()
  await sheet.getByRole('button', { name: 'Cancel' }).click()

  await openThread(page, desktop, 'general', 'General')
  await openThreadSettings(page)
  await sheet.getByRole('button', { name: 'Archive thread' }).click()
  await expect(sheet.getByRole('button', { name: 'Restore thread' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Cancel' }).click()

  await editMode(page, desktop)
  const archived = page.getByTestId('thread-archived').filter({ visible: true })
  await expect(archived).toContainText('General')
  await archived.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByTestId('thread-archived')).toHaveCount(0)
  await expect.poll(() => order(page)).toContain('general')
})

test('reorder by dragging the handle, by keyboard, and with the arrows on phones', async ({ page }, info) => {
  const desktop = isDesktop(info.project.name)
  await start(page, desktop)
  await createThread(page, desktop, { name: 'Garden', icon: 'Leaf', color: 'Lime' })
  await createThread(page, desktop, { name: 'Trips', icon: 'Plane', color: 'Cyan' })
  await editMode(page, desktop)
  await expect.poll(() => order(page)).toEqual(['general', 'garden', 'trips'])

  // drag Trips (last) above General with the pointer
  const list = page.getByTestId('thread-order').filter({ visible: true })
  const handle = list.getByTestId('reorder-handle-trips')
  const target = list.locator('[data-reorder-row="general"]')
  const h = await handle.boundingBox()
  const g = await target.boundingBox()
  if (!h || !g) throw new Error('no boxes')
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 - ((h.y - g.y + 8) * i) / 8)
  await page.mouse.up()
  await expect.poll(() => order(page)).toEqual(['trips', 'general', 'garden'])
  // the saved config agrees: leave edit mode and come back
  await page.getByTestId('edit-threads').filter({ visible: true }).click()
  await editMode(page, desktop)
  await expect.poll(() => order(page)).toEqual(['trips', 'general', 'garden'])

  // keyboard: Space picks up Garden, ArrowUp twice, Space drops
  const kb = list.getByTestId('reorder-handle-garden')
  await kb.focus()
  await kb.press(' ')
  await kb.press('ArrowUp')
  await page.getByTestId('reorder-handle-garden').filter({ visible: true }).press('ArrowUp')
  await page.getByTestId('reorder-handle-garden').filter({ visible: true }).press(' ')
  await expect.poll(() => order(page)).toEqual(['garden', 'trips', 'general'])
  await expect(page.getByTestId('reorder-announce').filter({ hasText: 'dropped' })).toHaveCount(1)

  if (!desktop) {
    await page.getByRole('button', { name: 'Move Garden down' }).click()
    await expect.poll(() => order(page)).toEqual(['trips', 'garden', 'general'])
  }
})

test('screenshots: list, edit mode and the settings sheet, light and dark', async ({ page }, info) => {
  test.skip(info.project.name === 'pixel', 'phone shots come from the iPhone project')
  const desktop = isDesktop(info.project.name)
  const form = desktop ? 'desktop' : 'phone'
  await start(page, desktop)
  await createThread(page, desktop, { name: 'App build', icon: 'Hammer', color: 'Orange', topic: 'Builds and CI' })
  await createThread(page, desktop, { name: 'Day job', icon: 'Briefcase', color: 'Hot pink', topic: 'Work' })
  await createThread(page, desktop, { name: 'Trips', icon: 'Plane', color: 'Cyan' })
  await createThread(page, desktop, { name: 'Garden', icon: 'Leaf', color: 'Lime' })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    if (desktop) await openThread(page, true, 'app_build', 'App build')
    else {
      await openList(page, false)
      const btn = page.getByTestId('edit-threads').filter({ visible: true })
      if ((await btn.getAttribute('aria-pressed')) === 'true') await btn.click()
    }
    await page.screenshot({ path: `${SHOTS}/${form}-${theme}-list.png` })
    await editMode(page, desktop)
    await page.screenshot({ path: `${SHOTS}/${form}-${theme}-edit.png` })
    await page.getByTestId('thread-edit-app_build').filter({ visible: true }).click()
    await expect(page.getByTestId('thread-settings')).toBeVisible()
    await page.waitForTimeout(250) // the sheet's open transition
    await page.screenshot({ path: `${SHOTS}/${form}-${theme}-settings.png` })
    await page.keyboard.press('Escape')
  }
})
