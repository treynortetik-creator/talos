// The Nyx screen (/memory) in a real browser (fake mode, VITE_FAKE=1) on the iPhone, Pixel and desktop projects: the empty
// screen, an address that is refused, connecting (the address is saved and Nyx sign-in opens in a new tab), the connected screen
// with its stubbed "Add Nyx to agents" list, changing the address, no console errors, and axe clean in both themes.
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const NYX = 'https://nyx.example.com'

/** Console errors and uncaught errors of the page; the test ends by asserting there were none. */
function watch(page: Page): string[] {
  const seen: string[] = []
  page.on('console', (m) => m.type() === 'error' && seen.push(`console: ${m.text()}`))
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`))
  return seen
}

async function open(page: Page) {
  // the sign-in tab is a made-up host: nothing leaves the test
  await page
    .context()
    .route(`${NYX}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>Nyx</p>' }))
  await page.goto('/memory')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByRole('heading', { level: 1, name: 'Nyx' })).toBeVisible()
}
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test('empty: one field and a Connect button; a refused address says why and opens nothing', async ({ page }) => {
  const errors = watch(page)
  await open(page)
  await expect(page.getByText("Your team's memory lives in Nyx. Connect it here.")).toBeVisible()
  const field = page.getByLabel('Nyx address')
  await expect(field).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible()
  await expect(page.getByText(/Connected to/)).toHaveCount(0)
  if (isPhoneWidth(page)) {
    expect(await noSideScroll(page)).toBe(true)
    const box = await page.getByRole('button', { name: 'Connect' }).boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  await expectAxeClean(page)

  // nothing is asked of Nyx and no tab is opened for a refused address (axe opens blank pages of its own, so count Nyx requests)
  let toNyx = 0
  page.context().on('request', (r) => r.url().startsWith(NYX) && toNyx++)
  for (const bad of ['http://nyx.example.com', 'javascript:alert(1)', 'https://nyx.example.com/a b']) {
    await field.fill(bad)
    await page.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByRole('alert')).toHaveText('Use a full https address, like https://nyx.example.com')
  }
  await expectAxeClean(page) // the error state too
  expect(toNyx).toBe(0)
  await expect(page.getByText(/Connected to/)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('keyboard: type the address and press Enter; Connect is reached by Tab where the browser tabs to buttons', async ({
  page,
  browserName,
}) => {
  await open(page)
  await page.getByLabel('Nyx address').focus()
  await page.getByLabel('Nyx address').fill(NYX)
  // Safari leaves buttons out of the Tab order by default, so only the other engines are asked to land on it
  if (browserName !== 'webkit') {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Connect' })).toBeFocused()
    await page.getByLabel('Nyx address').focus()
  }
  const popup = page.waitForEvent('popup')
  await page.keyboard.press('Enter')
  await (await popup).close()
  await expect(page.getByText('Connected to nyx.example.com')).toBeVisible()
})

test('connecting saves the address, opens Nyx sign-in in a new tab, and shows the connected screen', async ({
  page,
}) => {
  const errors = watch(page)
  await open(page)
  await page.getByLabel('Nyx address').fill(NYX)
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Connect' }).click()
  const tab = await popup
  await tab.waitForLoadState('domcontentloaded')
  expect(tab.url()).toBe(`${NYX}/sign-in`)
  await tab.close()

  await expect(page.getByText('Connected to nyx.example.com')).toBeVisible()
  // a blocked tab can't be told apart from an opened one, so the link is always there and nothing claims it opened
  const after = page.getByTestId('nyx-after')
  await expect(after.getByRole('link', { name: 'Sign in to Nyx' })).toHaveAttribute('href', `${NYX}/sign-in`)
  await expect(after).not.toContainText('opened')
  await expect(page.getByLabel('Nyx address')).toHaveCount(0)
  const sent = await page.evaluate(() =>
    (window as unknown as { __talos: { sent: Array<{ type: string; patch?: unknown }> } }).__talos.sent
      .filter((f) => f.type === 'config.patch')
      .map((f) => f.patch),
  )
  expect(sent.at(-1)).toEqual({ memory: { nyx_url: `${NYX}/` } })

  const openLink = page.getByRole('link', { name: 'Open Nyx' })
  await expect(openLink).toHaveAttribute('href', `${NYX}/`)
  await expect(openLink).toHaveAttribute('target', '_blank')
  await expect(page.getByRole('button', { name: 'Change address' })).toBeVisible()

  // the stub: a row for Main, every box off, and the line that says it is coming
  const boxes = page.getByTestId('nyx-agents').getByRole('checkbox')
  expect(await boxes.count()).toBeGreaterThanOrEqual(1)
  for (const b of await boxes.all()) {
    await expect(b).toBeDisabled()
    await expect(b).not.toBeChecked()
  }
  await expect(page.getByText("Coming soon: this adds Nyx to each agent's own Claude setup.")).toBeVisible()
  if (isPhoneWidth(page)) expect(await noSideScroll(page)).toBe(true)
  await expectAxeClean(page)
  expect(errors).toEqual([])
})

test('Open Nyx opens the saved address in a new tab', async ({ page }) => {
  await open(page)
  await page.getByLabel('Nyx address').fill(NYX)
  const first = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Connect' }).click()
  await (await first).close()
  await expect(page.getByText('Connected to nyx.example.com')).toBeVisible()
  const second = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open Nyx' }).click()
  const tab = await second
  await tab.waitForLoadState('domcontentloaded')
  expect(tab.url()).toBe(`${NYX}/`)
})

test('Change address: Cancel keeps the old one, a new https address replaces it', async ({ page }) => {
  await open(page)
  await page.getByLabel('Nyx address').fill(NYX)
  const first = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Connect' }).click()
  await (await first).close()
  await page.getByRole('button', { name: 'Change address' }).click()
  await expect(page.getByLabel('Nyx address')).toHaveValue(`${NYX}/`)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Connected to nyx.example.com')).toBeVisible()

  await page.getByRole('button', { name: 'Change address' }).click()
  await page.getByLabel('Nyx address').fill('https://memory.example.org')
  await page.context().route('https://memory.example.org/**', (r) => r.fulfill({ status: 200, body: 'ok' }))
  const next = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Connect' }).click()
  await (await next).close()
  await expect(page.getByText('Connected to memory.example.org')).toBeVisible()
})
