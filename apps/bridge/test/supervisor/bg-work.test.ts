// Background work under a thread session's pane (bg-work.ts; the Mac's BackgroundWorkFoundTests). The table is a real session's,
// read with `ps -o pid,ppid,ucomm,command` on 2026-11-15 (Claude Code 2.1.325, native install), the home folder replaced.
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  command,
  cutLine,
  evalCommand,
  found,
  isClaude,
  isVersionName,
  NO_BG,
  offenders,
  type Proc,
  procTable,
} from '../../src/supervisor/bg-work.ts'

const REAL: Proc[] = [
  { pid: 43682, ppid: 2326, name: '2.1.325', argv: ['/home/alex/.local/bin/claude', '--settings', '{}'] },
  { pid: 28796, ppid: 43682, name: 'caffeinate' },
  { pid: 43857, ppid: 43682, name: 'python3.12' },
  { pid: 43858, ppid: 43682, name: 'node', argv: ['/home/alex/.nvm/versions/node/v24.22.2/bin/node', 'mcp.js'] },
  {
    pid: 43859,
    ppid: 43682,
    name: 'bun',
    argv: ['/opt/homebrew/bin/bun', 'run', '--cwd', '/home/alex/talos/apps/bridge'],
  },
]
const WAITER = `source /home/alex/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'until grep -q "h20 exit=" /tmp/claude-501/tasks/bwd5h811r.output 2>/dev/null; do sleep 15; done' < /dev/null && pwd -P >| /tmp/claude-bdd8-cwd`
const BUSY: Proc[] = [
  ...REAL,
  { pid: 12726, ppid: 43682, name: 'zsh', argv: ['/bin/zsh', '-c', WAITER] },
  { pid: 66235, ppid: 12726, name: 'sleep' },
]

describe('background work under a session (bg-work.ts)', () => {
  it('the native install is claude: its servers and caffeinate are not work', () => {
    expect(isClaude(REAL[0] as Proc)).toBe(true)
    expect(found(REAL, 43682, () => null)).toEqual(NO_BG)
  })
  it('a background Bash command is work, counted once, its command shown (60 characters)', () => {
    const f = found(BUSY, 43682, () => null)
    expect(f.count).toBe(1)
    expect(f.first).toBe(
      'until grep -q "h20 exit=" /tmp/claude-501/tasks/bwd5h811r.output 2>/dev/null; do sleep 15; done'.slice(0, 60),
    )
    expect(cutLine(f)).toBe(`Parked while 1 background task(s) were running: ${f.first}.`)
    expect(offenders(BUSY, 999)).toEqual([]) // a pane that is gone gives none
  })
  it('a version name alone is not claude', () => {
    expect(isClaude({ pid: 5, ppid: 1, name: '2.1.325', argv: ['/opt/tool/2.1.325'] })).toBe(false)
    expect(isClaude({ pid: 5, ppid: 1, name: '2.1.325', argv: null })).toBe(false)
    expect(
      isClaude({ pid: 5, ppid: 1, name: '2.1.325', argv: ['/home/alex/.local/share/claude/versions/2.1.325'] }),
    ).toBe(true)
    for (const n of ['2', '2.', '.1', '2.x.3', 'v2.1.3', '２.1']) expect(isVersionName(n)).toBe(false)
  })
  it('the command line: the eval’d text, a -c script, an argv, hostile text made one short line', () => {
    expect(evalCommand(`source x || true && eval 'echo '"'"'hi'"'"'' < /dev/null`)).toBe("echo 'hi'")
    expect(evalCommand('echo no eval')).toBeNull()
    expect(command(['/bin/bash', '-c', 'make test'], 'bash')).toBe('make test')
    expect(command(['/usr/bin/python3', 'serve.py'], 'python3')).toBe('/usr/bin/python3 serve.py')
    expect(command(null, 'zsh')).toBe('zsh')
    expect(command(['/bin/sh', '-c', 'a\nb\u001b[2Jc\td'], 'sh')).toBe('a b [2Jc d')
    expect([...command(['/bin/sh', '-c', 'é'.repeat(200)], 'sh')].length).toBe(60)
    expect(command(['/bin/sh', '-c', '   '], 'sh')).toBe('sh')
  })
})

describe('the /proc reader', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const fakeProc = (entries: Record<string, { stat: string; cmdline?: string }>) => {
    const root = mkdtempSync(join(tmpdir(), 'talos-proc-'))
    dirs.push(root)
    for (const [pid, e] of Object.entries(entries)) {
      mkdirSync(join(root, pid))
      writeFileSync(join(root, pid, 'stat'), e.stat)
      if (e.cmdline !== undefined) writeFileSync(join(root, pid, 'cmdline'), e.cmdline)
    }
    mkdirSync(join(root, 'self'))
    return root
  }
  it('reads pid, parent and name (one with spaces and parentheses), and argv only for a name that may be claude', () => {
    const root = fakeProc({
      '10': { stat: '10 (2.1.325) S 1 10 10 0 -1', cmdline: '/home/alex/.local/bin/claude\0--resume\0' },
      '11': { stat: '11 (a (b) c) S 10 10 10 0 -1', cmdline: 'never read\0' },
      '12': { stat: 'garbage' },
    })
    const t = procTable(root)
    expect(t).not.toBeNull()
    const byPid = new Map((t ?? []).map((p) => [p.pid, p]))
    expect(byPid.get(10)).toMatchObject({
      ppid: 1,
      name: '2.1.325',
      argv: ['/home/alex/.local/bin/claude', '--resume'],
    })
    expect(isClaude(byPid.get(10) as Proc)).toBe(true)
    expect(byPid.get(11)).toMatchObject({ ppid: 10, name: 'a (b) c', argv: null })
    expect(byPid.has(12)).toBe(false)
  })
  it('a /proc that cannot be listed is unknown (null), never an empty table', () => {
    expect(procTable(join(tmpdir(), 'talos-no-such-proc-dir'))).toBeNull()
  })
})
