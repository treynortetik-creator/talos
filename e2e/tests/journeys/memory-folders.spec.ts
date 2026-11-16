// Journey: picking Memory's folders in Settings. Real relay, real bridge, real browser. The Mac has an agent folder with two
// folders and Memory switched off; the owner ticks one in Settings > Memory folders and saves. memory.json now names it,
// Memory browsing is on, and the Memory screen lists its note (owner, 2026-11-15: before, only `talos-app memory init` in a
// terminal could do this).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, signedIn, test } from '../../harness/fixtures.ts'

test.setTimeout(150_000)

test('memory-folders: pick a folder in Settings; Memory turns on and lists its note', async ({
  stack,
  page,
  context,
}) => {
  const agentDir = join(stack.root, 'agent')
  mkdirSync(join(agentDir, 'notes'), { recursive: true })
  mkdirSync(join(agentDir, 'journal'), { recursive: true })
  writeFileSync(join(agentDir, 'notes', 'hello.md'), '# Hello note\n\nA note the phone may read.\n')
  writeFileSync(join(agentDir, 'journal', 'day.md'), '# A day\n')
  writeFileSync(
    join(stack.home, 'memory.json'),
    JSON.stringify({ version: 1, enabled: false, agent_dir: agentDir, roots: [], max_file_kb: 512 }),
    { mode: 0o600 },
  )
  await signedIn(stack, page, context)

  const section = page.getByTestId('memory-folders')
  await test.step('Settings lists the agent folder’s folders, none picked', async () => {
    await expect(async () => {
      await page.goto(`${stack.origin}/settings/memory-folders`)
      await expect(section.getByRole('checkbox')).toHaveCount(2, { timeout: 5000 })
    }).toPass({ timeout: 45_000 })
    await expect(section.getByRole('checkbox', { name: /^notes/ })).not.toBeChecked()
  })

  await test.step('tick notes and save: the Mac says saved', async () => {
    await section.getByRole('checkbox', { name: /^notes/ }).check()
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 20_000 })
    const cfg = JSON.parse(readFileSync(join(stack.home, 'memory.json'), 'utf8'))
    expect(cfg).toMatchObject({ enabled: true, roots: [{ path: 'notes' }] })
    expect(JSON.parse(readFileSync(join(stack.home, 'config.json'), 'utf8')).memory_browser).toBe(true)
  })

  await test.step('Memory lists the note from the picked folder', async () => {
    await expect(async () => {
      await page.goto(`${stack.origin}/memory`)
      await expect(page.getByRole('button', { name: /^Hello note/ })).toBeVisible({ timeout: 4000 })
    }).toPass({ timeout: 45_000 })
  })
})
