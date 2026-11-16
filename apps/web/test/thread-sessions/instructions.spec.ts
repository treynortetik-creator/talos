// The Instructions section of thread settings (AGENTS.md in the thread's own folder) in a real browser (fake mode,
// VITE_FAKE=1), on the desktop, iPhone and Pixel projects: Edit loads the file, Save writes it, a save over a file that
// changed on the Mac meanwhile is refused with Reload, and the reload shows that change as a diff. A thread without its own
// session has no section; one with no folder yet says how to get one. Phone widths must not scroll sideways.
import { expect, type Page, test } from '@playwright/test'
import { AGENTS_MD_WORDING } from '@talos-app/protocol'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

type Talos = {
  store: {
    getState: () => { config: { threads: Array<Record<string, unknown>> } }
    setState: (f: (s: never) => never) => void
  }
  patchConfig: (p: Record<string, unknown>) => Promise<void>
  emit: (type: string, fields: Record<string, unknown>) => void
  fakeAgentsMd: { changeOnMac(id: string, text: string | null): void; onMac(id: string): string | null | undefined }
}

/** Adds Work with its own session (and, unless `folder` is false, its own folder), then opens its settings. */
async function open(page: Page, o: { folder?: boolean; session?: boolean } = {}) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(
    async ({ folder, session }) => {
      const c = (window as unknown as { __talos: Talos }).__talos
      const cur = c.store.getState().config.threads.filter((t) => t.id !== 'work')
      await c.patchConfig({
        threads: [
          ...cur,
          {
            id: 'work',
            name: 'Work',
            kind: 'fixed',
            order: 2,
            notify: 'all',
            voice_context: 'recent',
            archived: false,
            created_at: '2026-10-28T00:00:00.000Z',
            ...(session ? { session: 'dedicated' } : {}),
            ...(session && folder ? { session_opts: { cwd: '/Users/alex/Projects/atlas' } } : {}),
          },
        ],
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
    },
    { folder: o.folder !== false, session: o.session !== false },
  )
  if (isPhoneWidth(page)) {
    await openPhoneMenu(page)
    await page.getByTestId('phone-menu').getByRole('button', { name: 'Thread settings for Work', exact: true }).click()
  } else {
    await page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByRole('button', { name: 'Thread settings for Work', exact: true })
      .click({ force: true })
  }
  await expect(page.getByTestId('thread-settings')).toBeVisible()
}
const section = (page: Page) => page.getByTestId('instructions')
const onMac = (page: Page) =>
  page.evaluate(() => (window as unknown as { __talos: Talos }).__talos.fakeAgentsMd.onMac('work'))
const noSideScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

test('Edit loads AGENTS.md, Save writes it to the thread folder on the Mac', async ({ page }) => {
  await open(page)
  const s = section(page)
  await s.scrollIntoViewIfNeeded()
  await expect(s.getByRole('heading', { name: 'Instructions' })).toBeVisible()
  await s.getByRole('button', { name: 'Edit AGENTS.md' }).click()
  const box = s.getByTestId('instructions-text')
  await expect(box).toHaveValue('')
  await expect(s.getByText('No AGENTS.md yet.', { exact: false })).toBeVisible()
  const save = s.getByTestId('instructions-save')
  await expect(save).toBeDisabled() // nothing changed yet
  await box.fill('# Atlas\n\nRun the tests before you say done.\n')
  await save.click()
  await expect(s.getByTestId('instructions-note')).toHaveText('Saved. The thread’s next session reads it.')
  expect(await onMac(page)).toBe('# Atlas\n\nRun the tests before you say done.\n')
  const b = await save.boundingBox()
  expect(b?.height ?? 0).toBeGreaterThanOrEqual(44) // thumb-sized
  await noSideScroll(page)
  await expectAxeClean(page)
})

test('a save over a file changed on the Mac meanwhile is refused; Reload shows the change as a diff', async ({
  page,
}) => {
  await open(page)
  const s = section(page)
  await s.scrollIntoViewIfNeeded()
  await s.getByRole('button', { name: 'Edit AGENTS.md' }).click()
  await s.getByTestId('instructions-text').fill('mine\n')
  await s.getByTestId('instructions-save').click()
  await expect(s.getByTestId('instructions-note')).toContainText('Saved.')
  // the agent edits its own instructions on the Mac, while this editor still holds the save
  await page.evaluate(() =>
    (window as unknown as { __talos: Talos }).__talos.fakeAgentsMd.changeOnMac('work', 'mine\nand the agent’s line\n'),
  )
  await s.getByTestId('instructions-text').fill('mine, edited\n')
  await s.getByTestId('instructions-save').click()
  await expect(s.getByRole('alert')).toContainText(AGENTS_MD_WORDING.conflict)
  expect(await onMac(page)).toBe('mine\nand the agent’s line\n') // the change made meanwhile is kept
  await s.getByRole('button', { name: 'Reload' }).click()
  // the owner's text is kept, the Mac's text is shown beside it, and the change made there is a diff
  await expect(s.getByTestId('instructions-text')).toHaveValue('mine, edited\n')
  await expect(s.getByTestId('instructions-mac-text')).toContainText('and the agent’s line')
  const outside = s.getByTestId('instructions-outside')
  await expect(outside).toContainText('Changed outside Settings')
  await outside.getByText('View the diff').click()
  await expect(outside.locator('pre')).toContainText('+and the agent’s line')
  // a save now goes over the file as it is on the Mac
  await s.getByTestId('instructions-save').click()
  await expect(s.getByTestId('instructions-note')).toContainText('Saved.')
  expect(await onMac(page)).toBe('mine, edited\n')
  await noSideScroll(page)
})

test('a thread with its own session but no folder yet says how to get one; a shared thread has no section', async ({
  page,
}) => {
  await open(page, { folder: false })
  await expect(section(page).getByTestId('instructions-no-folder')).toBeVisible()
  await expect(section(page).getByRole('button', { name: 'Edit AGENTS.md' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await open(page, { session: false })
  await expect(page.getByTestId('thread-settings')).toBeVisible()
  await expect(section(page)).toHaveCount(0)
})
