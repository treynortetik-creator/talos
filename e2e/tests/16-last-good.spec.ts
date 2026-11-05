import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Stack, startStack, waitUntil } from '../harness/stack.ts'

// Last-good, end to end: `talos-app install-mcp` writes the agent folder's .mcp.json (with TALOS_AGENT_DIR), the real bridge
// is started the way Claude Code starts it (with that entry's env) and saves the setup after a healthy start, a broken
// .mcp.json is put back by `talos-app restore-last-good --yes`, and that restore can itself be undone.

let stack: Stack
test.beforeEach(async () => {
  stack = await startStack()
})
test.afterEach(async () => {
  await stack.stop()
})

const BROKEN = '{ "mcpServers": { "talos-app": \n'

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cli = stack.cli(args)
  const code = await cli.done(60_000) // a cold bun start of the whole CLI under CI load can pass 15 s
  return { code, out: cli.out, err: cli.err }
}

test('16. last-good: a start saves the setup, restore-last-good puts back a broken .mcp.json, and the restore can be undone', async () => {
  const agentDir = join(stack.root, 'agent')
  mkdirSync(join(agentDir, '.claude'), { recursive: true })
  writeFileSync(
    join(agentDir, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: ['Read(./notes/**)'] } }, null, 2)}\n`,
  )

  // The Mac-side install, by the real command. It records the agent folder in the entry's env.
  const installed = await run(['install-mcp', '--agent-dir', agentDir])
  expect(installed.code).toBe(0)
  const mcpPath = join(agentDir, '.mcp.json')
  const good = readFileSync(mcpPath, 'utf8')
  const entry = (JSON.parse(good) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers[
    'talos-app'
  ]
  expect(entry?.env.TALOS_AGENT_DIR).toBe(agentDir)

  // Claude Code starts the bridge with exactly the env of that entry.
  await stack.startBridge({ env: { TALOS_AGENT_DIR: entry?.env.TALOS_AGENT_DIR as string } })
  const saved = join(stack.home, 'last-good')
  await waitUntil(() => {
    try {
      return readdirSync(saved).some((n) => /^\d{8}T\d{9}Z$/.test(n))
    } catch {
      return false // the folder is made by the first save
    }
  }, 'the start to save a version')
  const versions = (await run(['restore-last-good', '--list'])).out
  expect(versions).toMatch(/^\s*1\.\s/m)
  expect(versions).toContain('.mcp.json, .claude/settings.json')
  expect(versions).toContain(`from ${agentDir}`)

  // The setup breaks (the file no longer parses), and a restart would not save it as a good one.
  writeFileSync(mcpPath, BROKEN)
  const restored = await run(['restore-last-good', '--yes'])
  expect(restored).toMatchObject({ code: 0 })
  expect(restored.out).toContain('wrote 1 file: .mcp.json')
  expect(restored.out).toContain('Restart the agent to use the restored ones.')
  expect(readFileSync(mcpPath, 'utf8')).toBe(good)

  // The broken file was kept as version 1, so the restore can be undone.
  const listed = (await run(['restore-last-good', '--list'])).out
  expect(listed).toContain('(the files a restore replaced)')
  const undone = await run(['restore-last-good', '--version', '1', '--yes'])
  expect(undone).toMatchObject({ code: 0 })
  expect(undone.out).toContain('wrote 1 file: .mcp.json')
  expect(readFileSync(mcpPath, 'utf8')).toBe(BROKEN)

  // The settings file was never touched by either step, and a plain restore after the undo brings the saved setup back again.
  expect(JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf8'))).toEqual({
    permissions: { allow: ['Read(./notes/**)'] },
  })
  expect((await run(['restore-last-good', '--yes'])).out).toContain('wrote 1 file: .mcp.json')
  expect(readFileSync(mcpPath, 'utf8')).toBe(good)
})
