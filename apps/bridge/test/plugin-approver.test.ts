// Which enabled plugins can approve tool calls without asking the phone (a PermissionRequest or PreToolUse hook), for the Settings plugin list.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { approvingPlugins } from '../src/plugins/agent-plugins.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const put = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(v))
}
const entry = [{ hooks: [{ type: 'command', command: 'true' }] }]

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pa'))
  dirs.push(dir)
  const rec = (n: string) => [{ scope: 'user', installPath: join(dir, 'plugins', 'cache', 'm', n), version: '1' }]
  put(join(dir, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'approver@m': rec('approver'), 'quiet@m': rec('quiet'), 'off@m': rec('off') },
  })
  put(join(dir, 'settings.json'), { enabledPlugins: { 'approver@m': true, 'quiet@m': true, 'off@m': false } })
  put(join(dir, 'plugins', 'cache', 'm', 'approver', 'hooks', 'hooks.json'), { hooks: { PermissionRequest: entry } })
  put(join(dir, 'plugins', 'cache', 'm', 'quiet', 'hooks', 'hooks.json'), { hooks: { SessionStart: entry } })
  put(join(dir, 'plugins', 'cache', 'm', 'off', 'hooks', 'hooks.json'), { hooks: { PreToolUse: entry } })
  return dir
}

describe('approvingPlugins', () => {
  test('the enabled plugins with a PermissionRequest or PreToolUse hook (keys); not one with other hooks, one that is off, or hooks that cannot be read are flagged too', () => {
    const dir = setup()
    put(join(dir, 'plugins', 'cache', 'm', 'quiet', 'hooks', 'hooks.json'), { hooks: { SessionStart: entry } })
    expect(approvingPlugins(() => dir)()).toEqual(['approver@m'])
    // hooks that are there and cannot be read: may approve
    writeFileSync(join(dir, 'plugins', 'cache', 'm', 'quiet', 'hooks', 'hooks.json'), '{ not json')
    expect(approvingPlugins(() => dir)().sort()).toEqual(['approver@m', 'quiet@m'])
  })

  test('the answer is kept until the plugin files change (their times), then read again', async () => {
    const dir = setup()
    const read = approvingPlugins(() => dir)
    const first = read()
    expect(read()).toBe(first) // the same array: not read again
    await new Promise((r) => setTimeout(r, 20))
    put(join(dir, 'settings.json'), { enabledPlugins: { 'approver@m': false, 'quiet@m': true, 'off@m': false } })
    expect(read()).toEqual([])
  })

  test('a config folder with no plugins, or one that cannot be read: none, never a throw', () => {
    expect(approvingPlugins(() => join(tmpdir(), 'no-such-claude-dir'))()).toEqual([])
  })
})
