import { expect, type Page, test } from '@playwright/test'

// 0.18 in a real browser (fake mode, VITE_FAKE=1): a long agent reply is drawn in pieces, and it looks and behaves like one page.
// The clipboard is a stub (never the real one).
const ID = 'm_01JBF3V7Q8K2M4N6P8R0S1TL1'
const section = (n: number) =>
  [
    `## Section ${n}`,
    '',
    `Words for section ${n}: ${'steady words in a row '.repeat(12).trim()}.`,
    '',
    '- first point',
    '- second point',
    '',
    '| name | value |',
    '|------|-------|',
    `| row ${n} | ${'a long cell value '.repeat(8).trim()} |`,
    '',
    '```sh',
    `echo section-${n}`,
    '```',
    '',
  ].join('\n')
const LONG = `# Long reply\n\n${Array.from({ length: 28 }, (_, i) => section(i)).join('\n')}`

async function open(page: Page) {
  await page.addInitScript(() => {
    ;(window as unknown as { __copied: string[] }).__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => (window as unknown as { __copied: string[] }).__copied.push(t) },
    })
  })
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(
    ([id, text]) => {
      type Store = { getState(): { messages: Record<string, unknown[]> }; setState(s: unknown): void }
      const st = (window as unknown as { __talos: { store: Store } }).__talos.store
      const msg = {
        id,
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text,
        format: 'markdown',
        attachments: [],
        via: 'app',
        created_at: '2026-10-28T15:00:00.000Z',
      }
      st.setState({
        ...st.getState(),
        messages: { ...st.getState().messages, general: [...(st.getState().messages.general ?? []), msg] },
      })
    },
    [ID, LONG],
  )
  const row = page.locator(`[data-msg-id="${ID}"]`)
  await row.scrollIntoViewIfNeeded()
  await expect(row.getByRole('heading', { name: 'Long reply' })).toBeVisible()
  return row
}

test('a long reply is drawn in pieces inside one prose box, and no page scrolls sideways', async ({ page }) => {
  const row = await open(page)
  expect(LONG.length).toBeGreaterThan(8 * 1024)
  expect(await row.locator('.prose-talos').count()).toBe(1)
  expect(await row.locator('.prose-talos > [data-md-chunk]').count()).toBeGreaterThan(3)
  expect(await row.locator('pre').count()).toBe(28)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('the pieces take the same height as one flow, and the first and last blocks have no outer margin', async ({
  page,
}) => {
  const row = await open(page)
  const box = row.locator('.prose-talos')
  const measure = () =>
    box.evaluate((el) => {
      const first = el.querySelector('h1')
      const last = el.querySelector('[data-md-chunk]:last-child > :last-child')
      return {
        height: el.getBoundingClientRect().height,
        firstMargin: first ? getComputedStyle(first).marginTop : null,
        lastMargin: last ? getComputedStyle(last).marginBottom : null,
      }
    })
  const pieces = await measure()
  expect(pieces.firstMargin).toBe('0px')
  expect(pieces.lastMargin).toBe('0px')
  // the same markup as one flow (no piece wrappers): the pieces must not change a pixel of layout
  await box.evaluate((el) => {
    el.innerHTML = Array.from(el.querySelectorAll(':scope > [data-md-chunk]'))
      .map((c) => c.innerHTML)
      .join('')
  })
  const whole = await box.evaluate((el) => el.getBoundingClientRect().height)
  expect(Math.abs(pieces.height - whole)).toBeLessThanOrEqual(1)
})

test('Copy on a code block in a later piece copies that block, and a table in a later piece scrolls inside itself', async ({
  page,
}) => {
  const row = await open(page)
  const pre = row.locator('pre').nth(20)
  await pre.scrollIntoViewIfNeeded()
  const copy = pre.getByRole('button', { name: 'Copy code' })
  await copy.click()
  await expect(copy).toHaveText('Copied')
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([
    'echo section-20\n',
  ])
  const table = row.getByRole('table').nth(20)
  await table.scrollIntoViewIfNeeded()
  expect(await table.evaluate((t) => t.tabIndex)).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a selection across two pieces holds the text of both', async ({ page }) => {
  const row = await open(page)
  const text = await row.locator('.prose-talos').evaluate((el) => {
    const pieces = el.querySelectorAll(':scope > [data-md-chunk]')
    const a = pieces[0] as HTMLElement
    const b = pieces[1] as HTMLElement
    const range = document.createRange()
    range.setStart(a, 0)
    range.setEnd(b, b.childNodes.length)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    return sel?.toString() ?? ''
  })
  expect(text).toContain('Long reply')
  expect(text).toContain(`Words for section ${1}`)
})
