// Upload into the thread's folder from Memory -> Agent folders (the tree beside a file on wide screens, one at a time on
// phones), in a real browser (fake mode, VITE_FAKE=1), on the desktop, iPhone and Pixel projects. Upload puts a file in the folder of the file on view, else the
// thread's folder; a taken name comes back as "name (2).ext" and the line says so; an instruction file is refused in words.
// On a wide screen a file dropped on a folder row goes into that folder. Phone widths must not scroll sideways.
import { expect, type Page, test } from '@playwright/test'
import { FILES_PUT_WORDING } from '@talos-app/protocol'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

/** The thread's folder: Memory -> Agent folders (Files lists the files sent in Talos now). */
async function openFiles(page: Page) {
  await page.goto('/memory?af=general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  const folder = page.getByTestId('agent-folder')
  await expect(folder).toBeVisible()
  return folder
}
const file = (name: string, text = 'made-up notes\n') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
const onMac = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __talos: { fakeFiles: { calls: Array<{ op: string; path: string }> } } }
    ).__talos.fakeFiles.calls
      .filter((c) => c.op === 'put')
      .map((c) => c.path),
  )

test('Upload puts a file in the thread folder; a taken name is kept and the upload is renamed', async ({ page }) => {
  const pane = await openFiles(page)
  const tree = pane.getByRole('tree', { name: 'Files' })
  await expect(tree.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible()
  await expect(page.getByText('view and add files', { exact: false }).first()).toBeVisible() // the title line says so
  const upload = pane.getByRole('button', { name: 'Upload a file to this folder' })
  const b = await upload.boundingBox()
  if (isPhoneWidth(page)) expect(b?.height ?? 0).toBeGreaterThanOrEqual(44)
  await pane.getByTestId('files-upload-input').setInputFiles(file('trip-notes.txt'))
  await expect(pane.getByTestId('files-upload-line')).toHaveText('Put trip-notes.txt in this folder.')
  await expect(tree.getByRole('treeitem', { name: 'trip-notes.txt', exact: true })).toBeVisible()
  await pane.getByTestId('files-upload-input').setInputFiles(file('README.md'))
  await expect(pane.getByTestId('files-upload-line')).toHaveText(
    'README.md was taken, so it is README (2).md in this folder.',
  )
  await expect(tree.getByRole('treeitem', { name: 'README (2).md', exact: true })).toBeVisible()
  expect(await onMac(page)).toEqual(['trip-notes.txt', 'README.md'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('an instruction file is refused in words, and nothing is put', async ({ page }) => {
  const pane = await openFiles(page)
  await pane.getByTestId('files-upload-input').setInputFiles(file('AGENTS.md'))
  await expect(pane.getByRole('alert')).toHaveText(`AGENTS.md: ${FILES_PUT_WORDING.instructions}`)
  await expect(pane.getByRole('treeitem', { name: 'AGENTS.md', exact: true })).toHaveCount(0)
})

test('several files at once: the one refused stays said, after the ones that were put', async ({ page }) => {
  const pane = await openFiles(page)
  await pane.getByTestId('files-upload-input').setInputFiles([file('one.txt'), file('CLAUDE.md'), file('two.txt')])
  await expect(pane.getByRole('alert')).toHaveText(`Not put: CLAUDE.md: ${FILES_PUT_WORDING.instructions}`)
  const tree = pane.getByRole('tree', { name: 'Files' })
  await expect(tree.getByRole('treeitem', { name: 'one.txt', exact: true })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'two.txt', exact: true })).toBeVisible()
})

test.describe('wide screens', () => {
  test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'drag and drop is the pane’s'))

  test('Upload goes to the folder of the file on view; a drop on a folder row goes into that folder', async ({
    page,
  }) => {
    const pane = await openFiles(page)
    const tree = pane.getByRole('tree', { name: 'Files' })
    await tree.getByRole('treeitem', { name: 'docs', exact: true }).click()
    await tree.getByRole('treeitem', { name: 'plan.md', exact: true }).click()
    await expect(pane.getByRole('button', { name: 'Upload a file to docs' })).toHaveText('Upload to docs')
    await pane.getByTestId('files-upload-input').setInputFiles(file('agenda.md'))
    await expect(pane.getByTestId('files-upload-line')).toHaveText('Put agenda.md in docs.')
    // a file dragged in from the desktop and dropped on the "scripts" row
    const drop = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['echo hi\n'], 'run.sh', { type: 'text/plain' }))
      return dt
    })
    const row = tree.getByRole('treeitem', { name: 'scripts', exact: true })
    await row.dispatchEvent('dragover', { dataTransfer: drop })
    await row.dispatchEvent('drop', { dataTransfer: drop })
    await expect(pane.getByTestId('files-upload-line')).toHaveText('Put run.sh in scripts.')
    expect(await onMac(page)).toEqual(['docs/agenda.md', 'scripts/run.sh'])
  })
})
