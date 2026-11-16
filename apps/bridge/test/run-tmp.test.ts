// #161: a bridge test run keeps every temp folder in one of its own and removes it at the end (test/run-tmp.ts).
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempHome } from './helpers.ts'
import { RUN_PREFIX, runTmp } from './run-tmp.ts'

const preload = join(import.meta.dir, 'run-tmp.ts')

/** A whole `bun test` run of one file that runs `body`, with this run-tmp as its preload and TMPDIR at `outer`. */
function testRun(outer: string, body: string) {
  const dir = mkdtempSync(join(runTmp, 'fixture-'))
  writeFileSync(
    join(dir, 'leak.test.ts'),
    `import { test } from 'bun:test'\ntest('makes folders', () => {\n${body}\n})\n`,
  )
  const r = Bun.spawnSync(['bun', 'test', '--preload', preload, join(dir, 'leak.test.ts')], {
    cwd: dir,
    env: { ...process.env, TMPDIR: outer },
  })
  rmSync(dir, { recursive: true, force: true })
  expect(r.exitCode).toBe(0)
  return `${r.stdout}${r.stderr}`
}

describe('one temp folder per test run', () => {
  test("this run's tmpdir() is its own folder, and a child given this environment uses it too", () => {
    expect(tmpdir()).toBe(runTmp)
    expect(runTmp.split('/').at(-1)?.startsWith(RUN_PREFIX)).toBe(true)
    const child = Bun.spawnSync(['sh', '-c', 'printf %s "$TMPDIR"'], { env: { ...process.env } })
    expect(child.stdout.toString()).toBe(runTmp)
  })

  test("a test home's hub socket path fits in a unix socket address", () => {
    const home = tempHome()
    const sock = join(home, 'run', 'hub.sock')
    rmSync(home, { recursive: true, force: true })
    // sun_path is 104 bytes on macOS and 108 on Linux, the last one the terminating NUL; past it the hub cannot listen
    expect(Buffer.byteLength(sock)).toBeLessThan(process.platform === 'darwin' ? 104 : 108)
  })

  test('the folder and everything a test put in it is gone when the run ends', () => {
    const outer = mkdtempSync(join(runTmp, 'outer-'))
    testRun(
      outer,
      `const fs = require('node:fs'), os = require('node:os'), p = require('node:path')
       for (let i = 0; i < 3; i++) {
         const d = fs.mkdtempSync(p.join(os.tmpdir(), 'talos-bridge-test-'))
         fs.writeFileSync(p.join(d, 'big'), 'x'.repeat(4096))
       }
       if (!os.tmpdir().startsWith(${JSON.stringify(join(outer, RUN_PREFIX))})) throw new Error('not in the run folder')`,
    )
    expect(readdirSync(outer)).toEqual([])
    rmSync(outer, { recursive: true, force: true })
  })

  test('a run folder made before bun started is adopted, so even a child given no environment writes into it', () => {
    const outer = mkdtempSync(join(runTmp, 'outer-'))
    const made = mkdtempSync(join(outer, RUN_PREFIX)) // what the `test` script and test-parallel.ts do
    testRun(
      made,
      `const os = require('node:os')
       if (os.tmpdir() !== ${JSON.stringify(made)}) throw new Error('nested: ' + os.tmpdir())
       const r = Bun.spawnSync(['sh', '-c', 'mktemp -d "$TMPDIR/child-XXXXXX"'])
       if (!r.stdout.toString().startsWith(${JSON.stringify(made)})) throw new Error('child outside: ' + r.stdout)`,
    )
    expect(readdirSync(outer)).toEqual([])
    rmSync(outer, { recursive: true, force: true })
  })

  test("a killed run's folder is removed by a later run once it is a day old, and a fresh one is left alone", () => {
    const outer = mkdtempSync(join(runTmp, 'outer-'))
    mkdirSync(join(outer, `${RUN_PREFIX}old`))
    mkdirSync(join(outer, `${RUN_PREFIX}recent`))
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(join(outer, `${RUN_PREFIX}old`), twoDaysAgo, twoDaysAgo)
    testRun(outer, '')
    expect(readdirSync(outer)).toEqual([`${RUN_PREFIX}recent`])
    rmSync(outer, { recursive: true, force: true })
  })
})
