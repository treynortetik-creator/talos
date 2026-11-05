// Memory links in real browsers (iPhone/WebKit phone width, Pixel, desktop): repeated links all open, a property link is a
// keyboard-reachable button, code stays as typed, and both themes pass axe. The note is answered by the harness's fake Mac.
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const TEXT = [
  '---',
  'title: Links',
  'related: "[[Alpha note]]" and [[Gone note]]',
  '---',
  '# Links',
  '[[Alpha note]] and again [[Alpha note]] and [[Alpha note]].',
  '',
  'Code stays: `[[Alpha note]]` and [[Gone note]] [[Gone note]].',
  '',
  '| who | note |',
  '| --- | --- |',
  '| a | [[Alpha note\\|Alpha in a table]] |',
  '',
  '- run `one tick',
  '- list item with [[Alpha note|Alpha in a list]] and `another`',
  '',
  'Then a paragraph.',
  '',
  '    [[Gone note]] in an indented block',
  '',
  '```',
  '[[Alpha note]] in a fence nobody closes',
].join('\n')
// what the Mac lists for TEXT: each distinct link once, in the order it first appears, code left out
const LINKS = [
  { text: 'Alpha note', root_id: 'notes', path: 'projects/example/Alpha note.md' },
  { text: 'Gone note', root_id: null, path: null },
  { text: 'Alpha in a table', root_id: 'notes', path: 'projects/example/Alpha note.md' },
  { text: 'Alpha in a list', root_id: 'notes', path: 'projects/example/Alpha note.md' },
]

async function openNote(page: Page) {
  await page.goto('/test/memory/harness/index.html?route=/memory')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('memory-entry-Overview.md')).toBeVisible()
  await page.evaluate(
    ([text, links]) => {
      const m = (window as unknown as { __talos: { memory: { read: unknown } } }).__talos.memory
      m.read = async () => ({
        text,
        mime: 'text/markdown',
        size: String(text).length,
        mtime: '2026-10-20T12:00:00.000Z',
        sha256: 'a'.repeat(64),
        nextOffset: null,
        links,
      })
    },
    [TEXT, LINKS] as const,
  )
  await page.getByTestId('memory-entry-Overview.md').click()
  await expect(page.getByTestId('memory-body')).toBeVisible()
}

test('repeat links all open, property links are buttons, code is left alone', async ({ page }) => {
  await openNote(page)
  const body = page.getByTestId('memory-body')
  await expect(body.locator('a[data-mem-link]')).toHaveCount(5) // 3 prose + 1 table cell + 1 list item
  await expect(body.getByTestId('memory-link-null')).toHaveCount(2)
  await expect(body.locator('code').first()).toHaveText('[[Alpha note]]')
  await expect(body).toContainText('[[Gone note]] in an indented block') // code stays as typed
  await expect(body).toContainText('[[Alpha note]] in a fence nobody closes')
  await expect(body).not.toContainText('memory.invalid')
  const front = page.getByTestId('memory-frontmatter')
  await expect(front).not.toContainText('[[')
  await expect(front.getByTestId('memory-link-null')).toHaveText('Gone note')
  // phone width: nothing pushes the page sideways
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(wide).toBe(false)
  await expectAxeClean(page) // light and dark
})

test('a property link takes focus by keyboard and Enter opens the note', async ({ page }) => {
  await openNote(page)
  const link = page.getByTestId('memory-front-link')
  await expect(link).toHaveText('Alpha note')
  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('location')).toContainText('n=projects%2Fexample%2FAlpha+note.md')
})

test('a link in the text opens its note', async ({ page }) => {
  await openNote(page)
  await page.getByTestId('memory-body').locator('a[data-mem-link]').nth(2).click() // the third copy, not the first
  await expect(page.getByTestId('location')).toContainText('n=projects%2Fexample%2FAlpha+note.md')
})
