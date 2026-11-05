// apps/bridge/scripts/test-parallel.ts: the runner that splits `bun test` over several processes. CI trusts its exit code, so
// these tests are about what must never come out green: a failing file, a file that dies at load, a file with no tests, and
// a file the runner did not find.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bridge = join(here, '..', 'apps', 'bridge')
const runner = join(bridge, 'scripts', 'test-parallel.ts')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PASS = `import { test } from 'bun:test'\ntest('a', () => {})\ntest('b', () => {})\n`
function suite(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'tp-'))
  dirs.push(d)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true })
    writeFileSync(join(d, name), text)
  }
  return d
}
function run(dir: string, ...args: string[]) {
  const r = spawnSync('bun', ['run', runner, ...args, dir], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('test-parallel', () => {
  it('runs every file, says so in the words `bun test` uses, and exits 0', () => {
    const d = suite({ 'a.test.ts': PASS, 'sub/b.test.ts': PASS, 'c_test.ts': PASS, 'd.spec.ts': PASS })
    const r = run(d, '--jobs', '2')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Ran 8 tests across 4 files.')
    expect(r.out).toMatch(/^ 8 pass$/m)
    expect(r.out).toMatch(/^ 0 fail$/m)
  })

  it('a test gets 20 s by default, and a test that hangs past it is still red', () => {
    const wait = (ms: number) => `import { test } from 'bun:test'\ntest('w', async () => { await Bun.sleep(${ms}) }`
    expect(run(suite({ 'a.test.ts': `${wait(5300)})\n` })).code).toBe(0)
    const own = run(suite({ 'a.test.ts': `${wait(1000)}, 100)\n` })) // its own timeout is left alone
    expect(own.code).toBe(1)
    expect(own.out).toContain('timed out after 100ms')
  }, 30_000)

  it('a child a test left behind does not hold up the run', () => {
    // The test leaves a child that keeps our stdout open for a minute and writes its process id where we can read it. A
    // runner that waited for the pipe to close would not return until the child was gone. No stopwatch: when run() returns
    // the child is still alive, which a runner that waited for it could not show.
    const pidFile = join(mkdtempSync(join(tmpdir(), 'tp-pid-')), 'child.pid')
    dirs.push(dirname(pidFile))
    const leaves = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test } from 'bun:test'
test('leaves a child with our stdout', () => {
  const kid = spawn('sleep', ['60'], { stdio: 'inherit', detached: true })
  writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid))
  kid.unref()
})
`
    try {
      expect(run(suite({ 'a.test.ts': leaves })).code).toBe(0)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(pid).toBeGreaterThan(1)
      expect(() => process.kill(pid, 0)).not.toThrow() // still running: the run did not wait for it
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL') // by its id, so nothing is left behind
      } catch {}
    }
  }, 90_000)

  it('leaves out what `bun test` leaves out', () => {
    const d = suite({
      'a.test.ts': PASS,
      'helper.ts': 'throw new Error("not a test file")\n',
      'b.vitest.ts': 'throw new Error("not a test file")\n',
      'node_modules/x/c.test.ts': 'throw new Error("a dependency")\n',
    })
    expect(run(d).code).toBe(0)
  })

  it('one failing file is red, and the rest still run', () => {
    const fails = `import { expect, test } from 'bun:test'\ntest('no', () => expect(1).toBe(2))\n`
    const d = suite({ 'a.test.ts': PASS, 'b.test.ts': fails, 'c.test.ts': PASS })
    const r = run(d, '--jobs', '1')
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAILED (1 of 3)')
    expect(r.out).toContain('- b.test.ts')
    expect(r.out).toContain('Ran 5 tests across 3 files.')
  })

  it('a file that exits 0 before reporting anything is red: it did not run its tests', () => {
    const quits = `import { test } from 'bun:test'\nprocess.exit(0)\ntest('never', () => {})\n`
    const r = run(suite({ 'a.test.ts': PASS, 'b.test.ts': quits }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('- b.test.ts')
  })

  it('a file that dies at load is red', () => {
    const r = run(suite({ 'a.test.ts': PASS, 'b.test.ts': 'throw new Error("boom")\n' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('- b.test.ts')
  })

  it('a file with no tests is red, so a test file cannot quietly lose them all', () => {
    const r = run(suite({ 'a.test.ts': PASS, 'b.test.ts': 'export {}\n' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('- b.test.ts')
  })

  it('a directory with no test files at all is red, not an empty success', () => {
    const r = run(suite({ 'notes.txt': 'nothing here\n' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('no test files')
  })

  it('--only and --skip with one prefix split the files between them, with nothing lost', () => {
    const d = suite({ 'x/a.test.ts': PASS, 'x/b.test.ts': PASS, 'y/c.test.ts': PASS, 'd.test.ts': PASS })
    expect(run(d, '--only', 'x/').out).toContain('Ran 4 tests across 2 files.')
    expect(run(d, '--skip', 'x/').out).toContain('Ran 4 tests across 2 files.')
    expect(run(d, '--only', 'gone/').code).toBe(1) // a prefix that matches nothing is red, not an empty pass
  })

  it('refuses a bad --jobs', () => {
    expect(run(suite({ 'a.test.ts': PASS }), '--jobs', '0').code).toBe(64)
  })

  it('finds exactly the files `bun test` finds in the bridge package', () => {
    // Asks bun itself: a name filter that matches nothing still loads every file it would have run.
    const d = suite({})
    const xml = join(d, 'all.xml')
    spawnSync('bun', ['test', '-t', '^no test has this name$', '--reporter=junit', `--reporter-outfile=${xml}`], {
      cwd: bridge,
      encoding: 'utf8',
    })
    const bun = [...readFileSync(xml, 'utf8').matchAll(/<testsuite name="[^"]*" file="([^"]+)"/g)].map((m) => m[1])
    const ours = spawnSync(
      'bun',
      [
        '-e',
        `import { findTestFiles } from ${JSON.stringify(runner)}; console.log(findTestFiles(${JSON.stringify(bridge)}).join('\\n'))`,
      ],
      { encoding: 'utf8' },
    ).stdout
    expect(new Set(bun).size).toBeGreaterThan(50)
    expect([...new Set(bun)].sort()).toEqual(ours.trim().split('\n'))
  }, 60_000)
})
