// Journey: reporting a bug. Real relay, real bridge (a fake Claude drives it), real browser.
//   open the palette -> Report a bug -> the picture of the screen -> Blur a region -> say what went wrong -> Preview shows the
//   exact payload (the Mac's version, the cleaned log) -> Send -> the relay keeps the report (two encrypted files, a row) and
//   emitted bug.reported; the webhook stayed off.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, signedIn, test, waitUntil } from '../../harness/fixtures.ts'

test.setTimeout(150_000)

test('bug-report: open, annotate, preview, send; the relay keeps it', async ({ stack, page, context }) => {
  await signedIn(stack, page, context)

  await test.step('open the reporter from the palette', async () => {
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox').fill('report a bug')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible()
  })
  const dialog = page.getByRole('dialog', { name: 'Report a bug' })

  await test.step('blur a region of the picture', async () => {
    await dialog.getByRole('button', { name: 'Blur' }).click()
    const canvas = dialog.getByTestId('bug-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas')
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + 160, box.y + 90, { steps: 5 })
    await page.mouse.up()
    await expect(dialog.getByRole('button', { name: 'Undo' })).toBeEnabled()
  })

  await test.step('say what went wrong, then preview the exact payload', async () => {
    await dialog.getByLabel('What went wrong?').fill('The send button did nothing')
    await dialog.getByRole('button', { name: 'Preview everything that will be sent' }).click()
    const preview = dialog.getByTestId('bug-preview')
    await expect(preview).toContainText('The send button did nothing')
    await expect(preview).toContainText('"bridge":')
    await expect(preview).toContainText('image/png')
    await expect(preview).not.toContainText('"messages"') // the thread messages stay off unless asked
  })

  await test.step('send; the relay keeps two files and says so', async () => {
    await dialog.getByRole('button', { name: 'Send report' }).click()
    await expect(dialog.getByText('Sent. Thank you.')).toBeVisible()
    await waitUntil(() => {
      try {
        return readdirSync(join(stack.dataDir, 'bug-reports')).length === 2
      } catch {
        return false
      }
    }, 'the relay to keep the report')
    const event = stack.relayLog.map((l) => JSON.parse(l)).find((l) => l.event === 'bug.reported')
    expect(event).toMatchObject({ webhook: 'off' })
    expect(JSON.stringify(event)).not.toContain('send button')
  })
})
