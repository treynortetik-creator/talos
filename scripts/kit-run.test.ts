// Tests for the kit script runner itself (scripts/kit-run.ts): a hanging script must be stopped with its children, its partial
// output reported, and its temp folder removed. Also the known-skips list.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifySkips, KNOWN_SKIPS, runScript } from './kit-run.ts'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'kr-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const envFor = (extra: Record<string, string>) => (home: string, tmp: string) => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  TMPDIR: tmp,
  ...extra,
})

describe('runScript', () => {
  it('stops a hanging script and its grandchild, keeps the partial output and removes the temp folder', async () => {
    const dir = scratch()
    const pidFile = join(dir, 'child.pid')
    const script = join(dir, 'hang.sh')
    writeFileSync(script, 'echo partial-output\nsleep 600 &\necho $! > "$PIDFILE"\nwait\n')
    const tmpRoot = scratch()
    const started = Date.now()
    const r = await runScript(script, { cwd: dir, timeoutMs: 1500, env: envFor({ PIDFILE: pidFile }), tmpRoot })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.timedOut).toBe(true)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('partial-output')
    expect(r.out).toContain('killed after')
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(childPid).toBeGreaterThan(1)
    // give the kernel a moment to reap the killed process
    for (let i = 0; i < 20 && alive(childPid); i++) await new Promise((res) => setTimeout(res, 50))
    expect(alive(childPid)).toBe(false)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('removes the temp folder and reports the exit code of a script that fails fast', async () => {
    const dir = scratch()
    const script = join(dir, 'fail.sh')
    writeFileSync(script, 'echo nope\nexit 3\n')
    const tmpRoot = scratch()
    const r = await runScript(script, { cwd: dir, timeoutMs: 5000, env: envFor({}), tmpRoot })
    expect(r).toMatchObject({ code: 3, timedOut: false })
    expect(r.out).toContain('nope')
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('kills a background child a finished script left behind', async () => {
    const dir = scratch()
    const pidFile = join(dir, 'child.pid')
    const script = join(dir, 'leak.sh')
    writeFileSync(script, 'sleep 600 >/dev/null 2>&1 &\necho $! > "$PIDFILE"\nexit 0\n')
    const r = await runScript(script, {
      cwd: dir,
      timeoutMs: 5000,
      env: envFor({ PIDFILE: pidFile }),
      tmpRoot: scratch(),
    })
    expect(r.code).toBe(0)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    for (let i = 0; i < 20 && alive(childPid); i++) await new Promise((res) => setTimeout(res, 50))
    expect(alive(childPid)).toBe(false)
  })
})

describe('known skips', () => {
  it('lists the kit harden skip with its reason', () => {
    const r = classifySkips(
      'test-jobs.sh',
      "  ok   x\n  skip harden test (needs the kit's git history for the 1.1.1 files)\n",
    )
    expect(r).toHaveLength(1)
    expect(r[0]?.reason).toMatch(/git history/)
  })

  it('reports a skip line nobody listed as unlisted, and the same line from another script too', () => {
    expect(classifySkips('test-jobs.sh', '  skip something new\n')[0]?.reason).toBeUndefined()
    expect(
      classifySkips('test-hooks.sh', "  skip harden test (needs the kit's git history)\n")[0]?.reason,
    ).toBeUndefined()
  })

  it('every listed skip names a kit test script that exists', () => {
    const names = readdirSync(join(import.meta.dirname, '../kit/scripts'))
    for (const k of KNOWN_SKIPS) expect(names).toContain(k.script)
  })
})
