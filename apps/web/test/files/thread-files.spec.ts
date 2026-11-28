// Thread files (/files): each thread's folder on the Mac, read-only plus uploads. It sat under Memory as Agent folders until
// Memory became the Nyx setup screen; old /memory?af= links come here. A tree with a filter and a viewer (Markdown rendered, code with line numbers, images) beside
// it on a wide screen; one at a time on a phone. The fake Mac serves DEMO_FILES (src/lib/fakeClient.ts).
import { expect, type Locator, type Page, test } from '@playwright/test'
import { FILES_WORDING } from '@talos-app/protocol'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR42mNk+M9Qz0AEYBxVSF+FjP8ZGBgYGBhGFQ4VhQAAqHQFEVRXxsQAAAAASUVORK5CYII=',
  'base64',
)

async function open(page: Page, route = '/files') {
  await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.goto(route)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const items = (tree: Locator) => tree.getByRole('treeitem')
const item = (tree: Locator, name: string) => tree.getByRole('treeitem', { name, exact: true })

test("Thread files lists each thread's folder; one opens in place and the back link returns to the list", async ({
  page,
}) => {
  await open(page)
  const list = page.getByTestId('thread-files')
  await expect(list.getByRole('heading', { name: 'Thread files' })).toBeVisible()
  await list.getByTestId('thread-folder-general').click()
  await expect(page).toHaveURL(/\/files\?t=general$/)
  const folder = page.getByTestId('thread-folder')
  await expect(folder.getByText('~/talos-agent')).toBeVisible()
  await page.getByRole('link', { name: 'All thread files' }).click()
  await expect(page.getByTestId('thread-folder-general')).toBeVisible()
})

test('an old Memory folder link opens that thread in Thread files', async ({ page }) => {
  await open(page, '/memory?af=general')
  await expect(page).toHaveURL(/\/files\?t=general$/)
  await expect(page.getByTestId('thread-folder').getByText('~/talos-agent')).toBeVisible()
})

test("an old memory browser path lands on Nyx's screen, not Home", async ({ page }) => {
  await open(page, '/memory/graph')
  await expect(page).toHaveURL(/\/memory$/)
  await expect(page.getByTestId('memory-screen')).toBeVisible()
})

test.describe('wide screens', () => {
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'a phone shows one at a time'))

  test('the tree beside a viewer: folders first, Markdown, code, the filter, an image, a file that is not text', async ({
    page,
  }) => {
    await open(page, '/files?t=general')
    const folder = page.getByTestId('thread-folder')
    const tree = folder.getByRole('tree', { name: 'Files' })
    await expect(items(tree)).toHaveText([
      'apps',
      'assets',
      'docs',
      'scripts',
      'CHANGELOG.md',
      'package.json',
      'README.md',
    ])
    await expect(tree.getByText(/^\.env|^\.git|node_modules/)).toHaveCount(0)
    const viewer = folder.getByTestId('files-viewer')
    await item(tree, 'README.md').click()
    await expect(viewer.getByRole('heading', { name: 'Atlas' })).toBeVisible()
    await item(tree, 'package.json').click()
    const code = viewer.getByTestId('code-view')
    await expect(code.getByTestId('line-no').first()).toHaveText('1')
    await expect(code).toContainText('"name": "atlas"')
    await item(tree, 'docs').click()
    await expect(item(tree, 'plan.md')).toBeVisible()
    await folder.getByRole('searchbox', { name: 'Filter files' }).fill('notes')
    await expect(items(tree)).toHaveText(['docs', 'notes.txt'])
    await folder.getByRole('searchbox', { name: 'Filter files' }).fill('')
    await item(tree, 'assets').click()
    await item(tree, 'logo.png').click()
    await expect(viewer.getByRole('img', { name: 'logo.png' })).toBeVisible()
    await item(tree, 'font.woff2').click()
    await expect(viewer.getByText(FILES_WORDING.binary)).toBeVisible()
  })

  test('a refusal from the Mac shows in the folder, and Try again asks again', async ({ page }) => {
    await open(page, '/files')
    await page.evaluate(() =>
      (
        window as unknown as { __talos: { fakeFiles: { failNextWith(m: string): void } } }
      ).__talos.fakeFiles.failNextWith("This thread's folder isn't there any more."),
    )
    await page.getByTestId('thread-folder-general').click()
    const folder = page.getByTestId('thread-folder')
    await expect(folder.getByText("This thread's folder isn't there any more.")).toBeVisible()
    await folder.getByRole('button', { name: 'Try again' }).click()
    await expect(folder.getByRole('treeitem', { name: 'README.md' })).toBeVisible()
  })
})

test.describe('phones', () => {
  test.beforeEach(({ page }) => test.skip(!isPhoneWidth(page), 'wide screens show the tree beside the file'))

  test('one at a time: the tree, a file, back to the tree; no sideways scroll', async ({ page }) => {
    await open(page, '/files?t=general')
    const folder = page.getByTestId('thread-folder')
    const tree = folder.getByRole('tree', { name: 'Files' })
    await item(tree, 'README.md').click()
    await expect(folder.getByRole('heading', { name: 'Atlas' })).toBeVisible()
    await folder.getByRole('button', { name: 'All files' }).click()
    await expect(item(tree, 'README.md')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
})
