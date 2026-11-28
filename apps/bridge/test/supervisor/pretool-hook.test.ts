// The PreToolUse hook of a thread session (kit/hooks/permission-pre.sh as a command, no sealed copy): the same code as the kit file, run in
// a clean environment with only the supervisor's fixed values, registered next to the permission hook in a thread's settings, and not on a
// Talos distro (rooted), whose settings allow exactly one hook. (`touch probe-1` is only a synthetic hook input.)
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PRE_TOOL_SCRIPT, preToolHookCommand, preToolInto } from '../../src/supervisor/pretool-hook.ts'
import { type HookFixed, withPermissionHook } from '../../src/supervisor/worker-spec.ts'

const KIT_PRE = resolve(import.meta.dir, '..', '..', '..', '..', 'kit', 'hooks', 'permission-pre.sh')
const tmps: string[] = []
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ptk-')))
  tmps.push(d)
  return d
}
const fixedIn = (talosHome: string, home: string, extra: Partial<HookFixed> = {}): HookFixed => ({
  talosHome,
  home,
  thread: 'trip',
  folder: '/srv/proj',
  folderHooksCount: true,
  ...extra,
})
const SID = '9a7c1e52-0b3d-4f6a-8c21-5d4e3f2a1b00'
const stdin = JSON.stringify({
  session_id: SID,
  cwd: '/srv/proj',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'touch probe-1' },
  tool_use_id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA',
})

describe('the thread session command is the kit script', () => {
  test('the embedded text is the kit file’s code, line for line (comments and blank lines aside)', () => {
    const code = readFileSync(KIT_PRE, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
      .join('\n')
    expect(PRE_TOOL_SCRIPT).toBe(code)
  })

  test('run through sh, in a hostile environment: the record goes to the FIXED Talos home, never to the session’s', () => {
    const talos = tmp()
    mkdirSync(join(talos, 'run'), { recursive: true })
    const evil = tmp()
    const cmd = preToolHookCommand(fixedIn(talos, '/nonexistent'))
    const r = Bun.spawnSync(['sh', '-c', cmd], {
      env: {
        PATH: process.env.PATH ?? '',
        TALOS_APP_HOME: evil,
        HOME: evil,
        LD_PRELOAD: '/nonexistent.so',
        BASH_ENV: '/nonexistent',
      },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(readdirSync(join(talos, 'run', 'pretool')).filter((n) => !n.startsWith('.'))).toHaveLength(1)
    expect(existsSync(join(evil, 'run'))).toBe(false)
  })

  test('a name with a quote in the Talos home is quoted safely', () => {
    const base = tmp()
    const talos = join(base, "it's here")
    mkdirSync(join(talos, 'run'), { recursive: true })
    const r = Bun.spawnSync(['sh', '-c', preToolHookCommand(fixedIn(talos, '/nonexistent'))], {
      env: { PATH: process.env.PATH ?? '' },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(0)
    expect(readdirSync(join(talos, 'run', 'pretool')).filter((n) => !n.startsWith('.'))).toHaveLength(1)
  })
})

describe('registered next to the permission hook', () => {
  const settings = {}
  test('a thread session gets a PreToolUse entry for every tool, with a short timeout, and the permission hook is still there', () => {
    const out = withPermissionHook(
      settings,
      '/x/permission-relay.py',
      '/usr/bin/python3',
      fixedIn('/home/alex/talos', '/home/alex'),
    ) as {
      hooks: {
        PermissionRequest: unknown[]
        PreToolUse: { matcher?: string; hooks: { type: string; timeout: number; command: string }[] }[]
      }
    }
    expect(out.hooks.PermissionRequest).toHaveLength(1)
    expect(out.hooks.PreToolUse).toHaveLength(1)
    const e = out.hooks.PreToolUse[0] as {
      matcher?: string
      hooks: { type: string; timeout: number; command: string }[]
    }
    expect(e.matcher).toBeUndefined() // every tool
    expect(e.hooks).toHaveLength(1)
    expect(e.hooks[0]).toMatchObject({ type: 'command', timeout: 5 })
    expect(e.hooks[0]?.command).toBe(preToolHookCommand(fixedIn('/home/alex/talos', '/home/alex')))
  })

  test('the hooks already there are kept, in order', () => {
    const had = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
        Stop: [{ hooks: [] }],
      },
    }
    const out = withPermissionHook(had, '/x/p.py', '/usr/bin/python3', fixedIn('/t', '/h')) as {
      hooks: { PreToolUse: unknown[]; Stop: unknown[] }
    }
    expect(out.hooks.PreToolUse).toHaveLength(2)
    expect((out.hooks.PreToolUse[0] as { matcher: string }).matcher).toBe('Bash')
    expect(out.hooks.Stop).toHaveLength(1)
  })

  test('a Talos distro (rooted) gets none: its settings allow exactly one hook', () => {
    const out = withPermissionHook(settings, '/x/p.py', '/usr/bin/python3', fixedIn('/t', '/h', { rooted: true })) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(out.hooks)).toEqual(['PermissionRequest'])
  })

  test('a hooks shape that is not a list of entries is left alone', () => {
    const hooks: Record<string, unknown> = { PreToolUse: 'nope' }
    preToolInto(hooks, { talosHome: '/t', home: '/h' })
    expect(hooks.PreToolUse).toBe('nope')
  })
})
