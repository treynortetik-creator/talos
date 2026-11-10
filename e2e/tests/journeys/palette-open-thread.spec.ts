// Journey: Cmd+K, type a thread name, Enter, and that thread opens (real relay and bridge, the palette reads the live thread list).
import { expect, signedIn, test } from '../../harness/fixtures.ts'

test('palette: Ctrl+K, type a thread name, Enter opens the thread, and nothing was answered or sent', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const made = await stack.claude.callTool('create_thread', { name: 'Errands' })
  expect(made.isError).toBeFalsy()
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Errands/i })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.getByRole('combobox').fill('Errands')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/t\/errands/)
  await expect(page.getByTestId('thread-screen').getByRole('heading', { level: 1, name: /^Errands/i })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
})
