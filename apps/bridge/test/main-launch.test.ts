// Review R1-4: Claude Code's own computer use is off on every Main launch path the bridge makes (`talos-app start`, the Linux
// supervisor), the same way the Mac's GuardsSettings.applyingToMain does it: one --settings, first; the owner's own --settings
// kept whole with the deny merged into a copy that takes its place; a miss said in words ending with NOT_DENIED.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withGuardsSettings } from '../src/guards/install.ts'
import { mainLaunchArgs, mainLaunchPath } from '../src/guards/main-launch.ts'
import { supervisorDenyRules } from '../src/guards/rules.ts'
import { mainArgsWithGuards } from '../src/supervisor/worker-policy.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'tml-'))
  dirs.push(d)
  return d
}
const denied = (o: Record<string, unknown>) =>
  ((o.deniedMcpServers as Array<{ serverName?: string }>) ?? []).map((x) => x.serverName)
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

describe('Main launch settings', () => {
  test('no guards, no settings of the owner: the deny rides as settings text, first', () => {
    const h = home()
    const r = mainLaunchArgs(['--x', '--', 'hi'], h)
    expect(r.warnings).toEqual([])
    expect(r.args[0]).toBe('--settings')
    expect(denied(JSON.parse(r.args[1] as string))).toEqual(['computer-use'])
    expect(r.args.slice(2)).toEqual(['--x', '--', 'hi'])
  })

  test('with the guards: their settings plus the deny in a private file beside them', () => {
    const h = home()
    mkdirSync(join(h, 'guards'))
    writeFileSync(join(h, 'guards', 'settings.json'), '{"permissions":{"deny":["Bash(rm:*)"]}}')
    const r = mainLaunchArgs(['--x'], h)
    expect(r).toEqual({ args: ['--settings', mainLaunchPath(h), '--x'], warnings: [] })
    const o = json(mainLaunchPath(h))
    expect(denied(o)).toEqual(['computer-use'])
    // the installed rules first, then the supervisor's files this version guards (an older install lacks them)
    expect((o.permissions as { deny: string[] }).deny).toEqual(['Bash(rm:*)', ...supervisorDenyRules(h)])
    expect(statSync(mainLaunchPath(h)).mode & 0o777).toBe(0o600)
  })

  test('guards installed before the supervisor files were guarded: added at launch, once, never twice (Fable R1-6)', () => {
    const h = home()
    mkdirSync(join(h, 'guards'))
    const fresh = supervisorDenyRules(h)
    expect(fresh).toContain('Bash(*supervisor-control*)')
    // an install that already has some of them: the rest are added, none doubled
    writeFileSync(
      join(h, 'guards', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)', fresh[0], 'Bash(*supervisor-control*)'] } }),
    )
    mainLaunchArgs(['--x'], h)
    const deny = (json(mainLaunchPath(h)).permissions as { deny: string[] }).deny
    expect(new Set(deny).size).toBe(deny.length)
    for (const r of fresh) expect(deny).toContain(r)
  })

  test("the owner's own --settings stays in place; the deny rides as --disallowedTools right before it (R2-4)", () => {
    const h = home()
    const rule = ['--disallowedTools', 'mcp__computer-use']
    let wrote = false
    const io = {
      write: () => {
        wrote = true
      },
    }
    expect(mainLaunchArgs(['--a', '--settings', 'conf/mine.json', '--', 'hi'], h, io)).toEqual({
      args: ['--a', ...rule, '--settings', 'conf/mine.json', '--', 'hi'],
      warnings: [],
    })
    expect(mainLaunchArgs(['--settings={"model":"x"}'], h, io).args).toEqual([...rule, '--settings={"model":"x"}'])
    // a file Talos cannot read is no miss: the rule does not depend on it
    expect(mainLaunchArgs(['--settings', join(h, 'gone.json')], h, io)).toEqual({
      args: [...rule, '--settings', join(h, 'gone.json')],
      warnings: [],
    })
    expect(wrote).toBe(false)
  })
})

describe('a --settings after `--` is the prompt, not a flag (R3-4)', () => {
  test('only the words before the first -- are searched; past it, the deny goes first as settings JSON', () => {
    const h = home()
    const r = mainLaunchArgs(['--x', '--', '--settings', '/y.json'], h)
    expect(r.warnings).toEqual([])
    expect(r.args[0]).toBe('--settings')
    expect(JSON.parse(r.args[1] as string)).toEqual({ deniedMcpServers: [{ serverName: 'computer-use' }] })
    expect(r.args.slice(2)).toEqual(['--x', '--', '--settings', '/y.json'])
    // before the --, theirs is theirs
    expect(mainLaunchArgs(['--settings', '/a.json', '--', '--settings', '/y.json'], h).args).toEqual([
      '--disallowedTools',
      'mcp__computer-use',
      '--settings',
      '/a.json',
      '--',
      '--settings',
      '/y.json',
    ])
  })
})

describe('every bridge start path carries it', () => {
  test('talos-app start (withGuardsSettings): without and with the guards, and with the owner’s own', () => {
    const h = home()
    const plain = withGuardsSettings(['--x'], h)
    expect(plain.flags[0]).toBe('--settings')
    expect(denied(JSON.parse(plain.flags[1] as string))).toEqual(['computer-use'])
    mkdirSync(join(h, 'guards'))
    writeFileSync(join(h, 'guards', 'settings.json'), '{}')
    expect(withGuardsSettings(['--x'], h).flags).toEqual(['--settings', mainLaunchPath(h), '--x'])
    writeFileSync(join(h, 'mine.json'), '{}')
    const own = withGuardsSettings(['--settings', join(h, 'mine.json')], h)
    expect(own.flags).toEqual(['--disallowedTools', 'mcp__computer-use', '--settings', join(h, 'mine.json')])
    expect(own.warning).toContain('NOT active')
  })

  test('the Linux supervisor’s Main (mainArgsWithGuards) matches the Mac', () => {
    const h = home()
    const r = mainArgsWithGuards(['--x'], h)
    expect(r.warning).toBeNull()
    expect(denied(JSON.parse(r.args[1] as string))).toEqual(['computer-use'])
  })
})
