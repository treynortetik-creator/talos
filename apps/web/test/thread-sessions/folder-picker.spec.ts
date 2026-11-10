// The Folder field in a real browser (fake mode, VITE_FAKE=1): Choose… opens the folder browser, breadcrumbs go up, a pick is
// saved and shown as ~/…, and the recent chips come back. Phone widths (390x844 iPhone and the Pixel) must not scroll sideways,
// and the buttons must be thumb-sized. Screenshots go to $SHOT_DIR when it is set.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth, openPhoneMenu } from '../helpers/phone.ts'

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

async function open(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async () => {
    const c = (window as unknown as { __talos: Talos }).__talos
    const cur = c.store.getState().config.threads
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
          session: 'dedicated',
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
  })
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

async function shot(page: Page, name: string, info: { project: { name: string } }, theme: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-folder-${name}-${theme}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('talos-theme', t), theme)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    })

    test('the field names the real agent folder, Choose… browses, and a pick is saved and shown as ~/…', async ({
      page,
    }, info) => {
      await open(page)
      const sheet = page.getByTestId('thread-settings')
      await expect(sheet.getByTestId('folder-current')).toContainText('~/talos-agent')
      await expect(sheet.getByTestId('folder-current')).toContainText(/agent folder/i)
      await shot(page, 'field', info, theme)
      await sheet.getByRole('button', { name: 'Choose…' }).click()
      const browser = sheet.getByTestId('folder-browser')
      await expect(browser).toBeVisible()
      await expect(browser.getByRole('button', { name: 'Projects' })).toBeVisible()
      await expect(browser.getByText('.config')).toHaveCount(0)
      await browser.getByLabel('Show hidden').check()
      await expect(browser.getByText('.config')).toBeVisible()
      await browser.getByLabel('Show hidden').uncheck()
      await browser.getByRole('button', { name: 'Projects' }).click()
      await expect(browser.getByRole('button', { name: 'alpha' })).toBeVisible()
      await shot(page, 'browser', info, theme)
      await browser.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: '~' }).click()
      await expect(browser.getByRole('button', { name: 'Documents' })).toBeVisible()
      await browser.getByRole('button', { name: 'Projects' }).click()
      await browser.getByRole('button', { name: 'alpha' }).click()
      await browser.getByRole('button', { name: 'Use this folder' }).click()
      await expect(browser).toBeHidden()
      await expect(sheet.getByTestId('folder-current')).toContainText('~/Projects/alpha')
      await expect(sheet.getByTestId('recent-folders').getByRole('button', { name: '~/Projects/alpha' })).toBeVisible()
      await shot(page, 'chosen', info, theme)
    })

    test('no sideways scroll, thumb-sized buttons on a phone, axe clean with the browser open', async ({ page }) => {
      await open(page)
      const sheet = page.getByTestId('thread-settings')
      await sheet.getByRole('button', { name: 'Choose…' }).click()
      await expect(sheet.getByTestId('folder-browser').getByRole('button', { name: 'Projects' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (isPhoneWidth(page)) {
        for (const name of ['Use this folder', 'Cancel', 'Projects']) {
          const box = await sheet.getByTestId('folder-browser').getByRole('button', { name, exact: true }).boundingBox()
          expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(40)
        }
      }
      await expectAxeClean(page, ['[data-testid="thread-settings"]'])
    })
  })
}

test.describe('phone, 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('the whole picker fits: no sideways scroll, and a pick from three levels down is saved', async ({
    page,
  }, info) => {
    await open(page)
    const sheet = page.getByTestId('thread-settings')
    await sheet.getByRole('button', { name: 'Choose…' }).click()
    const browser = sheet.getByTestId('folder-browser')
    await browser.getByRole('button', { name: 'Projects' }).click()
    await browser.getByRole('button', { name: 'alpha' }).click()
    await expect(browser.getByRole('button', { name: 'src' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shot(page, 'phone-390', info, 'light')
    await browser.getByRole('button', { name: 'Use this folder' }).click()
    await expect(sheet.getByTestId('folder-current')).toContainText('~/Projects/alpha')
  })
})
