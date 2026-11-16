// Journey: the Library, both ways. Real relay, real bridge (a fake Claude drives it), real browser. The agent publishes a page
// and sends a file, the owner sends one; the Library opens on what the agent sent, page and file in one list, the page
// opening full screen, and its switch shows what the owner sent. Files come from the Mac's history through the real relay
// (files.sent -> files.sent_list), pages from the relay's own list (owner, 2026-11-15: pages and files in one place).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, signedIn, test } from '../../harness/fixtures.ts'

test.setTimeout(150_000)

test('library-both-ways: a page and a file from the agent, a file from the owner; each on its side', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)

  await test.step('the agent sends a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'files-journey-'))
    const path = join(dir, 'agent-summary.md')
    writeFileSync(path, '# Summary\n\nMade by the agent.\n')
    const res = await stack.claude.callTool('reply', {
      thread_id: 'general',
      text: 'Here is the summary',
      files: [path],
    })
    expect(res.isError).toBeFalsy()
    await expect(page.getByTestId('msg-agent').filter({ hasText: 'Here is the summary' })).toBeVisible()
  })

  await test.step('the agent publishes a page', async () => {
    const res = await stack.claude.callTool('publish_page', {
      thread_id: 'general',
      title: 'Weekly report',
      html: '<!doctype html><title>Weekly report</title><h1>Weekly report</h1>',
    })
    expect(res.isError).toBeFalsy()
  })

  await test.step('the owner sends a file', async () => {
    await page
      .getByTestId('pick-files')
      .setInputFiles({ name: 'owner-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes from the owner\n') })
    const box = page.getByTestId('composer').getByRole('textbox')
    await box.fill('my notes')
    await page.getByTestId('composer').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('owner-notes.txt').first()).toBeVisible()
  })

  const files = await test.step('open the Library', async () => {
    const phone = (page.viewportSize()?.width ?? 0) < 768
    if (phone) {
      await page.getByRole('button', { name: 'Library' }).click()
      return page.getByRole('dialog', { name: 'Library' })
    }
    await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
    return page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' })
  })

  await test.step('it opens on what the agent sent: the page and the file in one list', async () => {
    const whose = files.getByRole('radiogroup', { name: 'Whose' })
    await expect(whose.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true')
    await expect(files.getByTestId('sent-file').filter({ hasText: 'agent-summary.md' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      files.locator('[data-testid="sent-file"][data-kind="page"]').filter({ hasText: 'Weekly report' }),
    ).toBeVisible()
    await expect(files.getByTestId('sent-file').filter({ hasText: 'owner-notes.txt' })).toHaveCount(0)
  })

  await test.step('Pages narrows to the page, and it opens full screen', async () => {
    await files.getByRole('radio', { name: 'Pages' }).click()
    await expect(files.getByTestId('sent-file').filter({ hasText: 'agent-summary.md' })).toHaveCount(0)
    await files.locator('[data-kind="page"]').getByText('Weekly report', { exact: true }).click()
    await expect(page.getByTitle('Weekly report (full screen)')).toBeVisible()
    await page.keyboard.press('Escape')
    await files.getByRole('radio', { name: 'All', exact: true }).click()
  })

  await test.step('the switch shows what the owner sent', async () => {
    await files.getByRole('radio', { name: 'From you' }).click()
    await expect(files.getByTestId('sent-file').filter({ hasText: 'owner-notes.txt' })).toBeVisible({ timeout: 30_000 })
    await expect(files.getByTestId('sent-file').filter({ hasText: 'agent-summary.md' })).toHaveCount(0)
  })
})
