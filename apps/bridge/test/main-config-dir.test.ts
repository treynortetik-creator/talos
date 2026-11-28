// Where Main reads its plugins from, for the bridge: the login shell's environment is read once and kept for a while (each read runs the owner's shell
// profile, up to 5 s), and it is read at bridge start, so the Settings flag looks in Main's folder before the first plugin request.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mainClaudeDir } from '../src/claude-dir.ts'
import { AgentPlugins, approvingPlugins } from '../src/plugins/agent-plugins.ts'
import { MainClaudeDir } from '../src/plugins/main-config-dir.ts'
import { processEnv } from '../src/supervisor/launch-env.ts'
import { type Harness, startHarness } from './helpers.ts'

const dirs: string[] = []
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}

describe('MainClaudeDir', () => {
  test('two reads within the TTL spawn the shell ONCE; after the TTL it is read again; reads at the same moment share one spawn', async () => {
    let spawned = 0
    let clock = 1_000
    const m = new MainClaudeDir(
      tmp('h'),
      tmp('u'),
      async () => {
        spawned++
        return { CLAUDE_CONFIG_DIR: '/main/cfg' }
      },
      () => clock,
    )
    const [a, b] = await Promise.all([m.resolve(), m.resolve()])
    expect(spawned).toBe(1)
    expect(a).toEqual({ dir: '/main/cfg', set: true })
    expect(b).toEqual(a)
    clock += 4 * 60_000
    await m.resolve()
    expect(spawned).toBe(1) // still inside the five minutes
    clock += 2 * 60_000
    await m.resolve()
    expect(spawned).toBe(2)
  })

  test('a shell that cannot be read falls back to this process’s environment and is not asked again at once', async () => {
    let spawned = 0
    const m = new MainClaudeDir(
      tmp('h'),
      '/home/alex',
      async () => {
        spawned++
        return null
      },
      () => 5,
    )
    expect((await m.resolve()).dir).toBe(mainClaudeDir(processEnv(), '/home/alex')) // whatever this process's own variable says
    await m.resolve()
    expect(spawned).toBe(1)
  })

  test('before any read, sync() is this process’s environment; after one it is Main’s', async () => {
    const m = new MainClaudeDir(tmp('h'), '/home/alex', async () => ({ CLAUDE_CONFIG_DIR: '/main/cfg' }))
    expect(m.sync().dir).not.toBe('/main/cfg')
    await m.resolve()
    expect(m.sync()).toEqual({ dir: '/main/cfg', set: true })
  })
})

describe('at bridge start', () => {
  test('the service reads Main’s folder once when it is made (no request needed), so the Settings flag reads Main’s plugins first', async () => {
    h = await startHarness({})
    const cfg = tmp('main')
    const put = (path: string, v: unknown) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(v))
    }
    put(join(cfg, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'approver@m': [{ scope: 'user', installPath: join(cfg, 'plugins', 'cache', 'approver'), version: '1' }],
      },
    })
    put(join(cfg, 'settings.json'), { enabledPlugins: { 'approver@m': true } })
    put(join(cfg, 'plugins', 'cache', 'approver', 'hooks', 'hooks.json'), {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    })
    let spawned = 0
    const dirsOf = new MainClaudeDir(
      tmp('h'),
      tmp('u'),
      async () => {
        spawned++
        return { CLAUDE_CONFIG_DIR: cfg }
      },
      () => 1,
    )
    const flag = approvingPlugins(() => dirsOf.sync().dir)
    expect(flag()).toEqual([]) // before the service exists: this process's folder, which has nothing
    new AgentPlugins(h.bridge.ctx, undefined, dirsOf)
    await new Promise((r) => setTimeout(r, 50)) // timing-ok: the one start-up read finishes in the background
    expect(spawned).toBe(1)
    expect(flag()).toEqual(['approver@m'])
  })
})
