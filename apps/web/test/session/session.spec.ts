// CC-C3 in a real browser (iphone, pixel, desktop): the session sheet, controls, the composer `/` picker, and the mod
// offline / absent states, against the scripted fake session (`VITE_FAKE=1`; `?fake_mod=offline|absent`).
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { sessionPanel } from '../helpers/phone.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  session: { patch(p: Record<string, unknown>): void; failNext(code: string, text: string): void }
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const controls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __talos: Fake }).__talos.sent.filter((f) => f.type === 'session.control'))

async function openThread(page: Page, mod?: 'offline' | 'absent') {
  await page.goto(`/t/general${mod ? `?fake_mod=${mod}` : ''}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}
/** The usage glance without opening the sheet: the header chip on wide screens, the context ring on phones. */
async function expectUsageGlance(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await expect(page.getByTestId('session-trigger')).toContainText('31%')
    await expect(page.getByTestId('session-trigger')).toHaveAttribute(
      'aria-label',
      'Session: weekly usage 60% used, context 31% used',
    )
    return
  }
  await expect(page.getByTestId('session-chip')).toContainText('wk 60% used')
  await expect(page.getByTestId('session-chip')).toContainText('ctx 31% used')
  await expect(page.getByTestId('session-chip')).not.toContainText('5h')
}
async function openSheet(page: Page) {
  await page.getByTestId('session-trigger').click()
  await expect(sessionPanel(page)).toBeVisible()
}

test('the header chip is visible without opening the sheet and the sheet shows the two rows', async ({ page }) => {
  await openThread(page)
  await expectUsageGlance(page)
  await openSheet(page)
  const sheet = sessionPanel(page)
  await expect(sheet.getByTestId('meter-five')).toHaveCount(0)
  await expect(sheet).not.toContainText('5-hour')
  await expect(sheet.getByTestId('meter-week')).toContainText('60% used')
  await expect(sheet.getByTestId('meter-context')).toContainText('31% used')
  await expect(sheet.getByTestId('session-model')).toContainText('Opus 5.5')
  await expect(sheet).not.toContainText('$')
  await expectAxeClean(page)
})

test('Stop appears only while busy and sends the shown turn id', async ({ page }) => {
  await openThread(page)
  await openSheet(page)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await fake(page, (t) => t.session.patch({ busy: true, turn_id: 'turn_9' }))
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('session-outcome')).toContainText('Stopped.')
  const c = await controls(page)
  expect(c).toHaveLength(1)
  expect(c[0]).toMatchObject({ action: 'stop', turn_id: 'turn_9' })
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
})

test('model switch: re-read warning inline, tap switches; haiku answers pending, calmly', async ({ page }) => {
  await openThread(page)
  await openSheet(page)
  await page.getByRole('button', { name: /^Model/ }).click()
  await expect(page.getByTestId('model-reread')).toContainText('re-reads the whole conversation')
  await page.getByRole('radio', { name: 'Sonnet' }).click()
  await expect(page.getByTestId('session-model')).toContainText('Sonnet 5.5')
  await page.getByRole('button', { name: /^Model/ }).click()
  await page.getByRole('radio', { name: 'Haiku' }).click()
  const line = page.getByTestId('session-outcome').getByText('Waiting for confirmation at the Mac.')
  await expect(line).toBeVisible()
  await expect(line).toHaveAttribute('data-kind', 'pending')
  const c = await controls(page)
  expect(c.map((f) => (f as { args?: string }).args)).toEqual(['sonnet', 'haiku'])
})

test('effort row sets the level', async ({ page }) => {
  await openThread(page)
  await openSheet(page)
  await page.getByRole('radio', { name: 'xhigh' }).click()
  await expect(page.getByRole('radio', { name: 'xhigh' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('session-controls').getByText('Applies from the next message')).toBeVisible()
  expect((await controls(page))[0]).toMatchObject({ command: 'effort', args: 'xhigh' })
})

test('a control failure shows the result text', async ({ page }) => {
  await openThread(page)
  await openSheet(page)
  await fake(page, (t) => t.session.failNext('model_switch_denied', 'Your hook refused this switch.'))
  await page.getByRole('button', { name: 'Compact' }).click()
  await expect(page.getByTestId('session-outcome')).toContainText('Your hook refused this switch.')
})

test('New conversation confirms in the app', async ({ page }) => {
  await openThread(page)
  await openSheet(page)
  await page.getByRole('button', { name: 'New conversation' }).click()
  expect(await controls(page)).toHaveLength(0)
  await page.getByRole('button', { name: 'Start new' }).click()
  await expect(page.getByTestId('session-outcome')).toContainText('Started a new conversation.')
})

test('picker: choosing a skill sends the ordinary message', async ({ page }) => {
  await openThread(page)
  const box = page.getByLabel('Message', { exact: true })
  await box.fill('/rel')
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible()
  await page.getByRole('option', { name: /release-notes/ }).click()
  await expect(page.getByTestId('msg-agent').getByText('echo: /release-notes')).toBeVisible()
  expect(await controls(page)).toHaveLength(0)
})

test('picker: a Mac-only built-in is greyed and does nothing', async ({ page }) => {
  await openThread(page)
  await page.getByLabel('Message', { exact: true }).fill('/perm')
  const opt = page.getByRole('option', { name: /permissions/ })
  await expect(opt).toHaveAttribute('aria-disabled', 'true')
  await expect(opt).toContainText('Run this at the Mac')
  await opt.click({ force: true }) // aria-disabled: a person can still tap it
  await expect(page.getByTestId('composer-note')).toContainText('Run this at the Mac.')
})

test('picker: keyboard picks /compact as a control', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hardware keyboard path')
  await openThread(page)
  const box = page.getByLabel('Message', { exact: true })
  await box.fill('/compa')
  await box.press('Enter')
  await expect.poll(async () => (await controls(page)).length).toBe(1)
  expect((await controls(page))[0]).toMatchObject({ action: 'compact' })
})

test('mod offline: read-only, one hint, "Mod offline"', async ({ page }) => {
  await openThread(page, 'offline')
  // Checked before the sheet opens: an open dialog hides the rest of the page from the accessibility tree.
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await expect(page.getByTestId('session-trigger')).toHaveAttribute(
      'aria-label',
      /weekly usage 60% used.*mod offline/,
    )
  } else {
    // The chip stays narrow: a small dot says the mod lapsed, and the words are in the button's name and tooltip.
    await expect(page.getByTestId('session-offline-dot')).toBeVisible()
    await expect(page.getByTestId('session-chip')).not.toContainText('mod offline')
    await expect(page.getByTestId('session-trigger')).toHaveAccessibleName(/^Session: wk 60% used.*mod offline/)
  }
  await openSheet(page)
  await expect(page.getByTestId('mod-offline')).toBeVisible()
  await expect(page.getByTestId('mod-hint')).toContainText(
    "Controls need the Talos mod, and it isn't loaded on your Mac yet.",
  )
  await expect(page.getByTestId('mod-hint')).not.toContainText('--plugin-dir')
  await expect(page.getByTestId('session-controls')).toHaveCount(0)
  await expectAxeClean(page)
})

test('mod absent: nothing breaks, one hint, two "No reading yet"', async ({ page }) => {
  await openThread(page, 'absent')
  await expect(page.getByTestId('session-chip')).toHaveCount(0)
  await expect(page.getByTestId('session-trigger')).toHaveAttribute('aria-label', 'Session')
  await openSheet(page)
  await expect(page.getByTestId('mod-hint')).toHaveCount(1)
  await expect(sessionPanel(page).getByText('No reading yet')).toHaveCount(2)
  await expect(page.getByTestId('session-controls')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByLabel('Message', { exact: true }).fill('/')
  await expect(page.getByTestId('slash-hint')).toContainText('Controls need the Talos mod')
})

test('Settings -> Session shows the same panel', async ({ page }) => {
  await page.goto('/settings/session')
  await expect(page.getByRole('heading', { name: 'Session' }).first()).toBeVisible()
  await expect(page.getByTestId('meter-week')).toContainText('60% used')
  await expect(page.getByTestId('meter-five')).toHaveCount(0)
})

test('an older peer that still sends the 5-hour window: read without error, shown nowhere', async ({ page }) => {
  await openThread(page)
  await fake(page, (t) =>
    t.session.patch({
      rate_limits: [{ kind: 'five_hour', percent: 97, resets_at: new Date(Date.now() + 3_600_000).toISOString() }],
    }),
  )
  await openSheet(page)
  const sheet = sessionPanel(page)
  await expect(sheet.getByTestId('meter-week')).toContainText('No reading yet')
  await expect(sheet).not.toContainText('97%')
  await expect(sheet).not.toContainText('5-hour')
  await expect(page.getByTestId('session-trigger')).not.toHaveAttribute('aria-label', /97|5-hour/)
})
