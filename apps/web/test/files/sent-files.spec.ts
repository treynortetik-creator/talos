// Files: the files sent in Talos, by the owner or an agent, across every thread (files.sent), in a real browser (fake mode,
// made-up files from src/lib/fakeFilesSent.ts). A phone gets a sheet with rows under day headings; a desktop gets a table
// in the pane column. Type chips, a name search, date and thread filters, a count and Clear filters; a file the Mac removed
// is greyed, name and date only, with one line at the end. SHOT_DIR=<dir> saves the labelled screenshots.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { isPhoneWidth } from '../helpers/phone.ts'

// The made-up files are placed hours before the page's now (fakeFilesSent.ts), so the day headings depend on the time of
// day: the page's clock and zone are pinned (a Wednesday noon, UTC) so every run sees the same days.
test.use({ bypassCSP: true, serviceWorkers: 'block', timezoneId: 'UTC' })
const at = (hhmm: string) => new Date(`2026-03-11T${hhmm}:00Z`)
const NOON = at('12:00')
const SHOTS = process.env.SHOT_DIR

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.mouse.move(1, 1)
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.screenshot({ path: join(SHOTS, name) })
}

async function openFiles(page: Page, opts: { media?: boolean; now?: Date } = {}) {
  await page.clock.install({ time: opts.now ?? NOON })
  if (opts.media !== false)
    await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: 'made-up file' }))
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  if (isPhoneWidth(page)) {
    await page.getByRole('button', { name: 'Library' }).click()
    return page.getByRole('dialog', { name: 'Library' })
  }
  await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
  return page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' })
}

const names = (where: ReturnType<Page['locator']>) => where.getByTestId('sent-file').allInnerTexts()

test('what the agent sent, newest first, then what you sent; chips, search and Clear filters; a removed file is greyed', async ({
  page,
}, info) => {
  const files = await openFiles(page)
  const rows = files.getByTestId('sent-file')
  await expect(rows.first()).toContainText('weekly-summary.html')
  await expect(rows).toHaveCount(7) // the agent's; the owner's two are on the other side
  await shot(page, `${info.project.name}-files-all.png`)

  // a page opens its own sandboxed /page in a new tab, on the tap itself
  const page1 = files.getByRole('link', { name: /weekly-summary\.html/ })
  await expect(page1).toHaveAttribute('href', /\/media\/md_[0-9A-Z]+\/page\?c=2$/)
  await expect(page1).toHaveAttribute('target', '_blank')

  await files.getByRole('radio', { name: 'Files', exact: true }).click()
  await files.getByRole('radio', { name: 'Docs' }).click()
  await expect(files.getByRole('radio', { name: 'Docs' })).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(() => names(files))
    .toEqual([
      expect.stringContaining('receipt.pdf'),
      expect.stringContaining('release-notes.md'),
      expect.stringContaining('quarterly-deck.pdf'),
    ])
  await expect(files.getByTestId('sent-files-count')).toHaveText('3 files')
  // the other side keeps the filters
  await files.getByRole('radio', { name: 'From you' }).click()
  await expect
    .poll(() => names(files))
    .toEqual([expect.stringContaining('trip-plan.md'), expect.stringContaining('packing-list.txt')])
  await files.getByRole('searchbox', { name: 'Search names' }).fill('PLAN')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('trip-plan.md')
  await shot(page, `${info.project.name}-files-filtered.png`)
  await files.getByRole('button', { name: 'Clear filters' }).click()
  await expect(rows).toHaveCount(2) // still your side
  await expect(files.getByRole('button', { name: 'Clear filters' })).toHaveCount(0)
  await files.getByRole('radiogroup', { name: 'Whose' }).getByRole('radio').first().click()
  await expect(rows).toHaveCount(7)

  // the file the Mac removed: listed, greyed, no link; the end says why and how far back the list goes
  const gone = files.locator('[data-testid="sent-file"][data-removed]')
  await expect(gone).toHaveCount(1)
  await expect(gone).toContainText('old-report.html')
  await expect(gone.getByRole('link')).toHaveCount(0)
  await expect(files.getByTestId('sent-files-end')).toContainText('Files from the last 90 days')
  await expect(files.getByTestId('sent-files-end')).toContainText('can no longer be opened')
})

test('an old file the relay no longer holds waits for a tap to get it from the Mac; reopening Files asks again', async ({
  page,
}) => {
  // the relay has let the old deck (media id ...T008) go: a HEAD for it is 410; everything else is there
  await page.route('**/media/**', (r) =>
    r.request().method() === 'HEAD' && r.request().url().includes('T008?')
      ? r.fulfill({ status: 410, body: '' })
      : r.fulfill({ status: 200, contentType: 'text/plain', body: 'made-up file' }),
  )
  const files = await openFiles(page, { media: false })
  const deck = files.getByTestId('sent-file').filter({ hasText: 'quarterly-deck.pdf' })
  await expect(deck).toContainText('On your Mac: tap to get it')
  await expect(deck.getByRole('link', { name: /quarterly-deck/ })).toHaveCount(0) // (the Thread column's link stays)
  // asked again each time Files opens, never kept
  await page.evaluate(() => {
    const w = window as unknown as {
      __asked?: number
      __talos: { files: { sent: (...a: unknown[]) => unknown } }
    }
    const real = w.__talos.files.sent
    w.__asked = 0
    w.__talos.files.sent = (...a: unknown[]) => {
      w.__asked = (w.__asked ?? 0) + 1
      return real(...a)
    }
  })
  await files.getByRole('button', { name: 'Close Library' }).click()
  if (isPhoneWidth(page)) await page.getByRole('button', { name: 'Library' }).click()
  else await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked?: number }).__asked)).toBeGreaterThan(0)
})

test('a thread filter narrows to that thread; a date filter to the last 7 days', async ({ page }) => {
  const files = await openFiles(page)
  const rows = files.getByTestId('sent-file')
  await expect(rows).toHaveCount(7)
  await files.getByRole('combobox', { name: 'Thread' }).selectOption('inbox')
  await expect(rows).toHaveCount(2)
  await files.getByRole('combobox', { name: 'Thread' }).selectOption('')
  await files.getByRole('combobox', { name: 'Date' }).selectOption('week')
  await expect(rows).toHaveCount(5) // the 8- and 37-day-old ones go
})

test.describe('phones', () => {
  test.beforeEach(({ page }) => test.skip(!isPhoneWidth(page), 'a desktop shows the table'))

  test('rows under day headings, 44 px targets, no sideways scroll', async ({ page }) => {
    const files = await openFiles(page)
    await expect(files.getByRole('region', { name: 'Today' })).toBeVisible()
    await expect(files.getByRole('region', { name: 'Yesterday' })).toBeVisible()
    const b = await files.getByTestId('sent-file').first().boundingBox()
    expect(b?.height ?? 0).toBeGreaterThanOrEqual(44)
    for (const chip of await files.getByRole('radio').all())
      expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })

  // the headings are calendar days in the device's zone, not 24-hour windows: files from minutes before midnight are
  // Yesterday just after it, and Today just before it
  test('just after midnight the last few hours are Yesterday; just before it they are Today', async ({ page }) => {
    let files = await openFiles(page, { now: at('00:05') }) // the agent's 0.4 and 1.2 hours ago: 23:41 and 22:53 last night
    const inDay = (day: string) => files.getByRole('region', { name: day }).getByTestId('sent-file').allInnerTexts()
    await expect(files.getByRole('region', { name: 'Today' })).toHaveCount(0)
    await expect
      .poll(() => inDay('Yesterday'))
      .toEqual([expect.stringContaining('weekly-summary.html'), expect.stringContaining('standup-notes.mp3')])
    await page.close()
    const page2 = await page.context().newPage()
    files = await openFiles(page2, { now: at('23:55') }) // the same two today; 26 and 30 hours ago yesterday
    await expect.poll(() => inDay('Today')).toHaveLength(2)
    await expect
      .poll(() => inDay('Yesterday'))
      .toEqual([expect.stringContaining('whiteboard.png'), expect.stringContaining('receipt.pdf')])
  })
})

test('Files opens on what the agent sent; the switch shows what you sent; Clear filters keeps the side', async ({
  page,
}) => {
  const files = await openFiles(page)
  const whose = files.getByRole('radiogroup', { name: 'Whose' })
  await expect(whose.getByRole('radio')).toHaveCount(2)
  await expect(whose.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true')
  await expect(whose.getByRole('radio').first()).toHaveText(/^From /)
  await expect(files.getByTestId('sent-file').first()).toBeVisible()
  const agentCount = await files.getByTestId('sent-file').count()
  await whose.getByRole('radio', { name: 'From you' }).click()
  await expect(whose.getByRole('radio', { name: 'From you' })).toHaveAttribute('aria-checked', 'true')
  await expect(files.getByTestId('sent-file')).toHaveCount(2)
  expect(agentCount).toBeGreaterThan(2)
  // the arrow keys move between the halves
  await whose.getByRole('radio', { name: 'From you' }).press('ArrowLeft')
  await expect(whose.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true')
  await expect(files.getByRole('combobox', { name: 'From' })).toHaveCount(0)
})

test.describe('wide screens', () => {
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'a phone shows rows'))

  test('a table: the thread links to the message; the two halves; audio plays in the dock', async ({ page }, info) => {
    const files = await openFiles(page)
    const table = files.getByRole('table')
    await expect(table.getByRole('columnheader', { name: 'Thread' })).toBeVisible()
    const link = table.getByRole('row', { name: /weekly-summary/ }).getByRole('link', { name: 'General' })
    await expect(link).toHaveAttribute('href', /^\/t\/general\?m=m_[0-9A-Z]+$/)
    await files.getByRole('radio', { name: 'From you' }).click()
    await expect(files.getByTestId('sent-file')).toHaveCount(2)
    await files.getByRole('radiogroup', { name: 'Whose' }).getByRole('radio').first().click()
    await shot(page, `${info.project.name}-files-table.png`)
    await table.getByRole('button', { name: 'Play standup-notes.mp3' }).click()
    // the dock has it, the row shows its progress, and nothing broke
    await expect(table.getByTestId('sent-file-progress')).toBeVisible()
    await expect(page.getByText('Something broke')).toHaveCount(0)
  })
})

test.describe('pages in the Library', () => {
  const pagesAt = (now: Date) => [
    {
      id: 'pg_01JBF3V7Q8K2M4N6P8R0S2T4P1',
      thread_id: 'general',
      title: 'Quarter plan',
      version: 1,
      updated_at: new Date(now.getTime() - 2 * 3600_000).toISOString(),
      share: null,
    },
  ]
  async function withPages(page: Page, opts: { offline?: boolean } = {}) {
    await page.clock.install({ time: NOON })
    await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: 'made-up file' }))
    await page.goto('/t/general')
    await page.waitForFunction(() => Boolean((window as unknown as { __talosPages?: unknown }).__talosPages))
    await page.evaluate(
      (p) => (window as unknown as { __talosPages: (x: unknown) => void }).__talosPages(p),
      pagesAt(NOON),
    )
    if (opts.offline)
      await page.evaluate(() => {
        const t = (
          window as unknown as {
            __talos: { store: { setState: (f: (s: Record<string, unknown>) => unknown) => void } }
          }
        ).__talos
        t.store.setState((s) => ({ presence: { ...(s.presence as Record<string, unknown>), bridge_online: false } }))
      })
    if (isPhoneWidth(page)) {
      await page.getByRole('button', { name: 'Library' }).click()
      return page.getByRole('dialog', { name: 'Library' })
    }
    await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
    return page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' })
  }

  test('a published page sits among the files by time, is marked, and opens full screen', async ({ page }, info) => {
    const lib = await withPages(page)
    const pageRow = lib.locator('[data-testid="sent-file"][data-kind="page"]')
    await expect(pageRow).toHaveCount(1)
    await expect(pageRow).toContainText('Quarter plan')
    // newest first: two files from the last 1.2 hours, then the page (2 hours ago)
    const order = await lib.getByTestId('sent-file').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
    expect(order.slice(0, 3)).toEqual(['file', 'file', 'page'])
    await page.screenshot({ path: info.outputPath(`library-${info.project.name}.png`) })
    await lib.getByRole('radio', { name: 'Pages' }).click()
    await expect(lib.locator('[data-kind="file"]').filter({ hasText: 'notes' })).toHaveCount(0)
    await pageRow.getByText('Quarter plan').click()
    await expect(page.getByTitle('Quarter plan (full screen)')).toBeVisible()
  })

  test('From you has no pages (they are the agent’s), and Files leaves them out', async ({ page }) => {
    const lib = await withPages(page)
    await lib.getByRole('radio', { name: 'Files', exact: true }).click()
    await expect(lib.locator('[data-kind="page"]')).toHaveCount(0)
    await lib.getByRole('radio', { name: 'All', exact: true }).click()
    await lib.getByRole('radio', { name: 'From you' }).click()
    await expect(lib.locator('[data-kind="page"]')).toHaveCount(0)
  })

  test('with the Mac offline the pages still list, and one line says the files need the Mac', async ({ page }) => {
    const lib = await withPages(page, { offline: true })
    await expect(lib.locator('[data-kind="page"]')).toHaveCount(1)
    await expect(lib.getByTestId('sent-files-unavailable')).toHaveText(
      'Files come from your Mac, which is offline. Pages are listed.',
    )
  })
})
