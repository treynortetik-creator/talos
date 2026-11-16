import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// Fake mode (VITE_FAKE=1). A .md attachment opens in the app as a rendered page (not raw text, not a download): headings, a table,
// a code block with Copy, a Contents list, a Rendered / Source toggle and a full-screen view. The media route is stubbed here.
const MD = [
  '# Release notes',
  '',
  'Intro with a [link](https://example.com).',
  '',
  '## Install',
  '',
  '```sh',
  'npm install talos',
  '```',
  '',
  '## Table',
  '',
  '| name | size |',
  '|------|------|',
  '| a    | 1    |',
  '',
  '### Details',
  '',
  'More.',
  '',
].join('\n')

test.use({ serviceWorkers: 'block' })

async function send(page: Page, md = MD) {
  await page.context().route('**/media/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/markdown',
      body: r.request().method() === 'GET' ? md : '',
    }),
  )
  await page.goto('/t/general')
  await page
    .getByTestId('pick-files')
    .setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(md) })
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('md-card')).toBeVisible()
}

test('renders in the app: heading, table, code block with Copy', async ({ page }) => {
  await send(page)
  const card = page.getByTestId('md-card')
  await expect(card.getByRole('heading', { name: 'Release notes' })).toBeVisible()
  await expect(card.getByRole('table')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Copy code' })).toBeVisible()
})

test('Contents jumps to a heading; Source shows the raw text; both work from the keyboard', async ({ page }) => {
  await send(page)
  const card = page.getByTestId('md-card')
  await card.getByRole('button', { name: 'Contents' }).focus()
  await page.keyboard.press('Enter')
  await card.getByRole('button', { name: 'Details' }).focus()
  await page.keyboard.press('Enter')
  await expect(card.getByRole('heading', { name: 'Details' })).toBeFocused()
  await card.getByRole('button', { name: 'Source' }).focus()
  await page.keyboard.press('Space')
  await expect(card.getByTestId('md-source')).toContainText('## Install')
  await card.getByRole('button', { name: 'Rendered' }).focus()
  await page.keyboard.press('Enter')
  await expect(card.getByRole('heading', { name: 'Release notes' })).toBeVisible()
})

test('Expand opens the full-screen view, Tab stays inside it, Escape closes and returns focus', async ({
  page,
}, info) => {
  await send(page)
  const expand = page.getByRole('button', { name: 'Expand notes.md to full screen' })
  await expand.click()
  const dialog = page.getByRole('dialog', { name: 'notes.md' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Release notes' })).toBeVisible()
  // WebKit's Tab skips buttons by default, so the Tab ring is checked on Chromium.
  for (let i = 0; i < (info.project.name === 'iphone' ? 0 : 12); i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(expand).toBeFocused()
})

test('a table wider than the card scrolls inside itself and can be reached and scrolled from the keyboard', async ({
  page,
  browserName,
}) => {
  const cols = ['name', 'size', 'owner', 'status', 'updated', 'notes', 'path', 'kind', 'region', 'cost', 'tags', 'id']
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`
  await send(page, ['# Wide', '', row(cols), row(cols.map(() => '---')), row(cols.map((c) => `${c} 1`)), ''].join('\n'))
  const table = page.getByTestId('md-card').getByRole('table')
  await expect(table).toBeVisible()
  expect(await table.evaluate((t) => t.scrollWidth > t.clientWidth)).toBe(true)
  await table.focus()
  await expect(table).toBeFocused()
  // Headless WebKit does not scroll a focused overflow box with the arrow keys (the iPhone projects are a touch phone, where a
  // finger scrolls it); the keyboard scroll is checked in Chromium, and the table taking focus is checked everywhere.
  if (browserName !== 'webkit') {
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => table.evaluate((t) => t.scrollLeft)).toBeGreaterThan(0)
  }
  await expectAxeClean(page, ['[data-testid="md-card"]'])
})

test('desktop layout: the card and the full-screen view fit, axe clean', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop only')
  await send(page)
  await expectAxeClean(page, ['[data-testid="md-card"]'])
  await page.getByRole('button', { name: 'Expand notes.md to full screen' }).click()
  const dialog = page.getByRole('dialog', { name: 'notes.md' })
  const box = await dialog.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(1400)
  await expectAxeClean(page, ['[role="dialog"]'])
})

test('phone layout 390x844: no sideways scroll, controls are tap-size, full screen fits, axe clean', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'phone only')
  await page.setViewportSize({ width: 390, height: 844 })
  await send(page)
  const card = page.getByTestId('md-card')
  await expect(card).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  for (const name of ['Rendered', 'Source', 'Contents', 'Expand notes.md to full screen']) {
    const b = await card.getByRole('button', { name }).boundingBox()
    expect(b?.height, name).toBeGreaterThanOrEqual(44)
  }
  await expectAxeClean(page, ['[data-testid="md-card"]'])
  await page.getByRole('button', { name: 'Expand notes.md to full screen' }).click()
  const dialog = page.getByRole('dialog', { name: 'notes.md' })
  const box = await dialog.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(390)
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true)
  await expectAxeClean(page, ['[role="dialog"]'])
})
