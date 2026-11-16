// Memory -> Agent folders: each thread's folder on the Mac, read-only plus uploads (what the Files pane was before Files
// listed the files sent in Talos). A tree with a filter and a viewer (Markdown rendered, code with line numbers, images) beside
// it on a wide screen; one at a time on a phone. The fake Mac serves DEMO_FILES (src/lib/fakeClient.ts).
import { expect, type Locator, type Page, test } from '@playwright/test'
import { FILES_WORDING } from '@talos-app/protocol'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR42mNk+M9Qz0AEYBxVSF+FjP8ZGBgYGBhGFQ4VhQAAqHQFEVRXxsQAAAAASUVORK5CYII=',
  'base64',
)

async function open(page: Page, route = '/memory') {
  await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.goto(route)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const items = (tree: Locator) => tree.getByRole('treeitem')
const item = (tree: Locator, name: string) => tree.getByRole('treeitem', { name, exact: true })

test("Memory lists each thread's folder; one opens in place and Back returns to the list", async ({ page }) => {
  await open(page)
  const list = page.getByTestId('agent-folders')
  await expect(list.getByRole('heading', { name: 'Agent folders' })).toBeVisible()
  await list.getByTestId('agent-folder-general').click()
  await expect(page).toHaveURL(/\/memory\?af=general$/)
  const folder = page.getByTestId('agent-folder')
  await expect(folder.getByText('~/talos-agent')).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('agent-folders')).toBeVisible()
})

test.describe('wide screens', () => {
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'a phone shows one at a time'))

  test('the tree beside a viewer: folders first, Markdown, code, the filter, an image, a file that is not text', async ({
    page,
  }) => {
    await open(page, '/memory?af=general')
    const folder = page.getByTestId('agent-folder')
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
    await open(page, '/memory')
    await page.evaluate(() =>
      (
        window as unknown as { __talos: { fakeFiles: { failNextWith(m: string): void } } }
      ).__talos.fakeFiles.failNextWith("This thread's folder isn't there any more."),
    )
    await page.getByTestId('agent-folder-general').click()
    const folder = page.getByTestId('agent-folder')
    await expect(folder.getByText("This thread's folder isn't there any more.")).toBeVisible()
    await folder.getByRole('button', { name: 'Try again' }).click()
    await expect(folder.getByRole('treeitem', { name: 'README.md' })).toBeVisible()
  })
})

test.describe('phones', () => {
  test.beforeEach(({ page }) => test.skip(!isPhoneWidth(page), 'wide screens show the tree beside the file'))

  test('one at a time: the tree, a file, back to the tree; no sideways scroll', async ({ page }) => {
    await open(page, '/memory?af=general')
    const folder = page.getByTestId('agent-folder')
    const tree = folder.getByRole('tree', { name: 'Files' })
    await item(tree, 'README.md').click()
    await expect(folder.getByRole('heading', { name: 'Atlas' })).toBeVisible()
    await folder.getByRole('button', { name: 'All files' }).click()
    await expect(item(tree, 'README.md')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
})
