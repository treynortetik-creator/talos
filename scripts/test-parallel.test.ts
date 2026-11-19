// apps/bridge/scripts/test-parallel.ts: the runner that splits `bun test` over several processes. CI trusts its exit code, so
// these tests are about what must never come out green: a failing file, a file that dies at load, a file with no tests, and
// a file the runner did not find.
// The ci-requires guard and the file-finding check below read the bridge's test files by folder, so the gate runs this file
// when one changes (scripts/gate.sh, guards_reading):
// gate-reads: apps/bridge/*.test.* apps/bridge/*_test.* apps/bridge/*.spec.* apps/bridge/*_spec.*
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { exitWithin, requires, shard, treeEnded } from '../apps/bridge/scripts/test-parallel.ts'

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
  return runEnv({}, dir, ...args)
}
function runEnv(env: Record<string, string>, dir: string, ...args: string[]) {
  const r = spawnSync('bun', ['run', runner, ...args, dir], { encoding: 'utf8', env: { ...process.env, ...env } })
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

  it('a file that hangs inside one call is killed with its children, named, and the other files still run', () => {
    // Atomics.wait blocks the whole process, so bun's own --timeout can never fire. The fixture writes the ids of itself and
    // of a child it started, then waits 40 s: far longer than the 5 s file limit, short enough that a runner without the
    // kill comes back (green, wrongly) and fails the checks below instead of leaving the process behind for good.
    const ids = mkdtempSync(join(tmpdir(), 'tp-hang-'))
    dirs.push(ids)
    const [selfPid, kidPid] = [join(ids, 'self.pid'), join(ids, 'kid.pid')]
    const hangs = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test } from 'bun:test'
test('blocks the process', () => {
  const kid = spawn('sleep', ['60'], { stdio: 'ignore' })
  writeFileSync(${JSON.stringify(kidPid)}, String(kid.pid))
  writeFileSync(${JSON.stringify(selfPid)}, String(process.pid))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40_000)
})
`
    // Running: the process exists and is not a zombie. A SIGKILLed child reparented to init stays a zombie until init reaps
    // it, and kill(pid, 0) succeeds on a zombie: on a loaded Mac that read the killed `sleep` as alive (Delphi, 2026-11-19;
    // the same test as scripts/verify/interrupt.test.ts, 772ca8e2). Looked at once, right after the runner returns, with no
    // wait: the runner waits for the whole tree itself (test-parallel.ts treeEnded), so a child still running here is a real
    // "killed with its children" failure, not a slow reaper.
    const alive = (file: string) => {
      const pid = Number(readFileSync(file, 'utf8'))
      try {
        process.kill(pid, 0)
      } catch {
        return false
      }
      // running only with a state that is not Z: a zombie reaped between the kill(0) and this ps prints nothing, and is gone
      return /^[^Z]/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
    }
    try {
      const r = run(
        suite({ 'a.test.ts': PASS, 'hang.test.ts': hangs, 'c.test.ts': PASS }),
        '--jobs',
        '2',
        '--file-timeout',
        '5',
      )
      expect(r.code).toBe(1)
      expect(r.out).toContain('hang.test.ts: killed, it ran past the file limit of 5 s')
      expect(r.out).toContain('FAILED (1 of 3)')
      expect(r.out).toContain('- hang.test.ts')
      expect(r.out).toContain('Ran 4 tests across 3 files.') // the two other files ran to the end
      expect(alive(selfPid)).toBe(false)
      expect(alive(kidPid)).toBe(false)
    } finally {
      for (const f of [selfPid, kidPid])
        try {
          process.kill(Number(readFileSync(f, 'utf8')), 'SIGKILL') // by its id, so nothing is left behind
        } catch {}
    }
  }, 60_000)

  it('the file limit comes from --file-timeout or BUN_TEST_FILE_TIMEOUT, and a bad value is refused', () => {
    const d = suite({ 'a.test.ts': PASS })
    expect(run(d, '--file-timeout', '0').code).toBe(64)
    expect(run(d, '--file-timeout', 'soon').code).toBe(64)
    const env = (v: string) =>
      spawnSync('bun', ['run', runner, d], { encoding: 'utf8', env: { ...process.env, BUN_TEST_FILE_TIMEOUT: v } })
    expect(env('-3').status).toBe(64)
    expect(env('120').status).toBe(0)
    // above 2147483 s setTimeout overflows and fires at once, which would kill every file after 1 ms
    expect(run(d, '--file-timeout', '2147484').code).toBe(64)
    expect(run(d, '--file-timeout', '2147483').code).toBe(0)
    expect(
      spawnSync('bun', ['run', runner, '--file-timeout', '120', d], {
        encoding: 'utf8',
        env: { ...process.env, BUN_TEST_FILE_TIMEOUT: 'x' },
      }).status,
    ).toBe(0) // the flag wins
  })

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

  it('--files runs only the files it names; a name that is not a test file here, or no name, is refused', () => {
    const d = suite({ 'x/a.test.ts': PASS, 'x/b.test.ts': PASS, 'y/c.test.ts': PASS })
    const list = join(d, 'list.txt')
    writeFileSync(list, 'x/a.test.ts\ny/c.test.ts\n')
    expect(run(d, '--files', list).out).toContain('Ran 4 tests across 2 files.')
    writeFileSync(list, 'x/a.test.ts\nx/gone.test.ts\n')
    const bad = run(d, '--files', list)
    expect(bad.code).toBe(64)
    expect(bad.out).toContain('x/gone.test.ts')
    writeFileSync(list, '')
    expect(run(d, '--files', list).code).toBe(64)
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

describe('test-parallel --retry-failed: a failed file is run once more, and a pass then is green but logged as a flake', () => {
  // Fails on its first run in a folder and passes on the next: each run appends a line to the marker file.
  const flips = (mark: string) => `import { appendFileSync, existsSync } from 'node:fs'
import { expect, test } from 'bun:test'
test('steady', () => {})
test('flips once', () => {
  const first = !existsSync(${JSON.stringify(mark)})
  appendFileSync(${JSON.stringify(mark)}, 'run\\n')
  expect(first).toBe(false)
})
`
  const setup = () => {
    const t = mkdtempSync(join(tmpdir(), 'tp-retry-'))
    dirs.push(t)
    return { mark: join(t, 'mark'), flakes: join(t, 'flakes') }
  }
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [])

  it('a file that fails once and then passes is green, says so, and its failed test is written to CI_FLAKE_FILE', () => {
    const { mark, flakes } = setup()
    const r = runEnv(
      { CI_FLAKE_FILE: flakes },
      suite({ 'a.test.ts': PASS, 'f.test.ts': flips(mark) }),
      '--retry-failed',
    )
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('f.test.ts: failed, then passed on retry')
    expect(lines(mark)).toHaveLength(2)
    expect(lines(flakes)).toEqual(['flips once\tf.test.ts'])
  })

  it('a file that fails twice stays red, and nothing is logged as a flake', () => {
    const { flakes } = setup()
    const fails = `import { expect, test } from 'bun:test'\ntest('no', () => expect(1).toBe(2))\n`
    const r = runEnv({ CI_FLAKE_FILE: flakes }, suite({ 'a.test.ts': PASS, 'b.test.ts': fails }), '--retry-failed')
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAILED (1 of 2)')
    expect(r.out).toContain('b.test.ts: failed again on retry')
    expect(lines(flakes)).toEqual([])
  })

  it("a rerun that exits 0 without reporting its tests is red: the first run's output is not read again", () => {
    const { mark, flakes } = setup()
    // fails with a full report the first time; the second time it quits before bun says anything
    const quitsOnRerun = `import { appendFileSync, existsSync } from 'node:fs'
import { expect, test } from 'bun:test'
if (existsSync(${JSON.stringify(mark)})) process.exit(0)
appendFileSync(${JSON.stringify(mark)}, 'run\\n')
test('no', () => expect(1).toBe(2))
`
    const r = runEnv({ CI_FLAKE_FILE: flakes }, suite({ 'q.test.ts': quitsOnRerun }), '--retry-failed')
    expect(r.code, r.out).toBe(1)
    expect(lines(flakes)).toEqual([])
  })

  it('without the flag a failed file is not run again', () => {
    const { mark, flakes } = setup()
    const r = runEnv({ CI_FLAKE_FILE: flakes }, suite({ 'f.test.ts': flips(mark) }))
    expect(r.code).toBe(1)
    expect(lines(mark)).toHaveLength(1)
  })

  it('a file killed at the file limit is not run again: a hang is not a flake, and a second one would cost the limit twice', () => {
    const { mark, flakes } = setup()
    const hangs = `import { appendFileSync } from 'node:fs'
import { test } from 'bun:test'
test('blocks', () => {
  appendFileSync(${JSON.stringify(mark)}, 'run\\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000)
})
`
    const r = runEnv({ CI_FLAKE_FILE: flakes }, suite({ 'h.test.ts': hangs }), '--retry-failed', '--file-timeout', '2')
    expect(r.code).toBe(1)
    expect(lines(mark)).toHaveLength(1)
    expect(lines(flakes)).toEqual([])
  }, 60_000)
})

describe('--shard K/N: the same files dealt into N piles, biggest first, each to the lightest pile so far', () => {
  it('piles are disjoint, together are every file, and the same on every machine', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let round = 0; round < 50; round++) {
      const files = Array.from({ length: 1 + (rnd() % 40) }, (_, i) => ({ name: `t${i}.test.ts`, size: rnd() % 5000 }))
      for (const n of [1, 2, 3, 4]) {
        const piles = Array.from({ length: n }, (_, k) => shard(files, k + 1, n))
        const all = piles.flat()
        expect(new Set(all).size, 'disjoint').toBe(all.length)
        expect([...all].sort()).toEqual(files.map((f) => f.name).sort())
        // the same input in another order deals the same piles
        expect(shard([...files].reverse(), 1, n)).toEqual(piles[0])
      }
    }
  })

  it('greedy by size: each file goes to the lightest pile so far, a tie to the first pile', () => {
    const files = [
      { name: 'a.test.ts', size: 100 },
      { name: 'b.test.ts', size: 60 },
      { name: 'c.test.ts', size: 50 },
      { name: 'd.test.ts', size: 40 },
    ]
    expect(shard(files, 1, 2)).toEqual(['a.test.ts', 'd.test.ts'])
    expect(shard(files, 2, 2)).toEqual(['b.test.ts', 'c.test.ts'])
    // equal sizes: name order breaks the tie, so every machine agrees
    const same = ['z.test.ts', 'y.test.ts', 'x.test.ts'].map((name) => ({ name, size: 10 }))
    expect(shard(same, 1, 2)).toEqual(['x.test.ts', 'z.test.ts'])
    expect(shard(same, 2, 2)).toEqual(['y.test.ts'])
  })

  it('the runner runs its shard only, after --only and --skip, and the two shards cover the whole run', () => {
    const big = `import { test } from 'bun:test'\n${Array.from({ length: 30 }, (_, i) => `test('t${i}', () => {})`).join('\n')}\n`
    const d = suite({ 'a.test.ts': big, 'b.test.ts': PASS, 'c.test.ts': PASS, 'skip/s.test.ts': PASS })
    const one = run(d, '--skip', 'skip/', '--shard', '1/2')
    const two = run(d, '--skip', 'skip/', '--shard', '2/2')
    expect(one.code, one.out).toBe(0)
    expect(two.code, two.out).toBe(0)
    expect(one.out).toContain('Ran 30 tests across 1 file.') // the biggest file alone
    expect(two.out).toContain('Ran 4 tests across 2 files.')
    expect(one.out + two.out).not.toContain('skip/s.test.ts')
  })

  it('an empty shard (more piles than files) runs nothing and is green; a bad --shard is refused', () => {
    const d = suite({ 'a.test.ts': PASS })
    const empty = run(d, '--shard', '2/2')
    expect(empty.code, empty.out).toBe(0)
    expect(empty.out).toContain('shard 2/2 has no files')
    for (const bad of ['0/2', '3/2', '1/0', 'x', '1/2/3', '1.5/2']) expect(run(d, '--shard', bad).code, bad).toBe(64)
    // a flag given without its value is refused, not read as "no flag" (which would run every file, or skip nothing)
    // (last on the line, so nothing after it can be taken for its value)
    for (const f of ['--shard', '--skip', '--only', '--jobs', '--file-timeout'])
      expect(spawnSync('bun', ['run', runner, d, f], { encoding: 'utf8' }).status, f).toBe(64)
    // it says which pile of how many it runs, so the piles can be checked to add up
    expect(run(suite({ 'a.test.ts': PASS, 'b.test.ts': PASS }), '--shard', '1/2').out).toContain(
      'shard 1/2: 1 of 2 files',
    )
  })
})

// Tool-aware dealing (docs/CI-MACHINES.md, "Tools a test file needs"): a file says what it needs in a `// ci-requires:` line
// near its top, and with --pile-tools each pile has the tools of the machine that runs it. A file that needs a tool goes only
// to a pile that has it; the rest are dealt as before. The same input deals the same piles on every machine.
describe('ci-requires and --pile-tools: a file that needs a tool goes only to a pile whose machine has it', () => {
  const T = `// ci-requires: tmux\nimport { test } from 'bun:test'\ntest('t', () => {})\n`
  it('the header: a comma list in the first 20 lines; later lines do not count; an unknown tool is an error', () => {
    expect(requires('// ci-requires: tmux\nx')).toEqual(['tmux'])
    expect(requires('// header\n//   ci-requires:  tmux ,\nx')).toEqual(['tmux'])
    expect(requires(`${'x\n'.repeat(20)}// ci-requires: tmux\n`)).toEqual([])
    expect(requires('no header here')).toEqual([])
    expect(() => requires('// ci-requires: tmuxx')).toThrow(/tmuxx/)
    expect(() => requires('// ci-requires:')).toThrow(/ci-requires/)
  })

  it('needing files go only to piles with the tool; the rest as before; disjoint and complete; the same everywhere', () => {
    let seed = 11
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let round = 0; round < 50; round++) {
      const files = Array.from({ length: 2 + (rnd() % 30) }, (_, i) => ({
        name: `t${i}.test.ts`,
        size: rnd() % 5000,
        needs: rnd() % 4 === 0 ? ['tmux'] : [],
      }))
      const tools = [['tmux'], []]
      const piles = [1, 2].map((k) => shard(files, k, 2, tools))
      const all = piles.flat()
      expect(new Set(all).size).toBe(all.length)
      expect([...all].sort()).toEqual(files.map((f) => f.name).sort())
      for (const f of files.filter((f) => f.needs.length > 0)) expect(piles[0], f.name).toContain(f.name)
      expect(shard([...files].reverse(), 2, 2, tools)).toEqual(piles[1])
    }
  })

  it('without pile tools, or when every pile has the tool, the piles are exactly today', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((n, i) => ({
      name: `${n}.test.ts`,
      size: 100 - i * 10,
      needs: i % 2 ? ['tmux'] : [],
    }))
    for (const k of [1, 2]) {
      const today = shard(files, k, 2)
      expect(shard(files, k, 2, [['tmux'], ['tmux']])).toEqual(today)
    }
  })

  it('a needing file that no pile can take is still dealt (to the lightest pile), so the run never loses it', () => {
    const files = [
      { name: 'a.test.ts', size: 100, needs: [] },
      { name: 't.test.ts', size: 10, needs: ['tmux'] },
    ]
    const piles = [1, 2].map((k) => shard(files, k, 2, [[], []]))
    expect(piles.flat().sort()).toEqual(['a.test.ts', 't.test.ts'])
  })

  it('the runner: --pile-tools deals by tool; --needs prints what its pile needs and runs nothing; bad input is refused', () => {
    const big = `import { test } from 'bun:test'\n${Array.from({ length: 30 }, (_, i) => `test('t${i}', () => {})`).join('\n')}\n`
    const d = suite({ 'big.test.ts': big, 'tm.test.ts': T, 'c.test.ts': PASS })
    // without tools the tmux file would go to pile 2 (big alone in pile 1); with them it goes to pile 1, which has tmux
    expect(run(d, '--shard', '2/2').out).toContain('Ran 1 test across 1 file.')
    const one = run(d, '--shard', '1/2', '--pile-tools', 'tmux|')
    const two = run(d, '--shard', '2/2', '--pile-tools', 'tmux|')
    expect(one.code, one.out).toBe(0)
    expect(two.code, two.out).toBe(0)
    expect(one.out).toContain('Ran 31 tests across 2 files.')
    expect(two.out).toContain('Ran 2 tests across 1 file.')
    const needs = (k: number, tools: string) =>
      spawnSync('bun', ['run', runner, '--shard', `${k}/2`, '--pile-tools', tools, '--needs', d], { encoding: 'utf8' })
    expect(needs(1, 'tmux|').stdout.trim()).toBe('tmux')
    expect(needs(1, 'tmux|').stdout).not.toContain('Ran ')
    expect(needs(2, 'tmux|').stdout.trim()).toBe('')
    // a pile list that does not match N, or an unknown tool in it, is refused
    for (const bad of ['tmux', 'tmux|x|', 'tmuxx|'])
      expect(run(d, '--shard', '1/2', '--pile-tools', bad).code, bad).toBe(64)
    // a file with an unknown tool in its header is refused, by name
    const typo = suite({ 'a.test.ts': `// ci-requires: tmx\n${PASS}` })
    const r = run(typo)
    expect(r.code).toBe(64)
    expect(r.out).toContain('a.test.ts')
  })
})

// The guard: a bridge test file that runs tmux says so (`// ci-requires: tmux`), and one that says so runs it, so the dealing
// above can rely on the headers. "Runs tmux" is what the files do to find or start it; the exceptions say why each is one.
describe('the ci-requires guard: every bridge test that runs tmux declares it, and none declares it without', () => {
  // looks for tmux, or starts it: through the TMUX path a test resolved, the literal name as the command (spawn('tmux', …) or
  // Bun.spawn(['tmux', …])), or the real host (new TmuxPtyHost). Not: a test that only builds tmux's arguments.
  const USES_TMUX =
    /\bhaveTmux\b|command -v tmux|Bun\.which\(\s*['"]tmux['"]\s*\)|\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*(?:TMUX\b|['"]tmux['"])|\bBun\.spawn(?:Sync)?\(\s*\[\s*['"]tmux['"]|\bnew TmuxPtyHost\(/
  const EXCEPTIONS: Record<string, string> = {
    // only with TALOS_REAL_CLAUDE=1 (a real claude and tmux on the owner's machine); CI never sets it, so it never needs tmux there
    'test/real-claude-permission-hook.test.ts': 'runs tmux only with TALOS_REAL_CLAUDE=1, which CI never sets',
  }
  it('"runs tmux" covers every way a test looks for or starts it, and not a test that only builds its arguments', () => {
    for (const runs of [
      'const haveTmux = true',
      "spawnSync('sh', ['-c', 'command -v tmux'])",
      "Bun.which('tmux')",
      'spawnSync(TMUX, ["-V"])',
      'execFileSync(TMUX, ["kill-server"])',
      "Bun.spawnSync(['tmux', '-L', s, 'kill-server'])",
      "Bun.spawn([ 'tmux', 'new' ])",
      "spawn('tmux', ['-V'])",
      'execFileSync("tmux", ["-V"])',
      "spawnSync('tmux', ['-V'])",
      'new TmuxPtyHost({ tmux: TMUX })',
    ])
      expect(USES_TMUX.test(runs), runs).toBe(true)
    for (const builds of [
      "new TmuxCommands('tmux', '/dev/null', 't-trip', 'x')",
      "host: 'tmux'",
      '// the tmux server is stopped by name',
      "'attach', '--print'",
    ])
      expect(USES_TMUX.test(builds), builds).toBe(false)
  })

  it('no file runs tmux without the header, and no file has the header without running tmux', () => {
    const walk = (dir: string, rel = ''): string[] =>
      readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() && e.name !== 'node_modules'
          ? walk(dir, join(rel, e.name))
          : /\.test\.ts$/.test(e.name)
            ? [join(rel, e.name)]
            : [],
      )
    const files = walk(bridge, 'test')
    expect(files.length).toBeGreaterThan(50)
    const wrong: string[] = []
    for (const f of files) {
      if (f in EXCEPTIONS) continue
      const text = readFileSync(join(bridge, f), 'utf8')
      const uses = USES_TMUX.test(text)
      const declared = requires(text).includes('tmux')
      if (uses && !declared) wrong.push(`${f}: runs tmux, has no "// ci-requires: tmux"`)
      if (declared && !uses) wrong.push(`${f}: says "ci-requires: tmux" but never runs tmux`)
    }
    expect(wrong).toEqual([])
    // every exception is still a file, so the list cannot go stale
    for (const f of Object.keys(EXCEPTIONS)) expect(existsSync(join(bridge, f)), f).toBe(true)
  })
})

describe('exitWithin', () => {
  it('gives the exit code when the process ends in time, 0 included', async () => {
    expect(await exitWithin(Promise.resolve(0), 1000)).toBe(0)
    expect(await exitWithin(Promise.resolve(137), 1000)).toBe(137)
  })

  it('gives null when the process never ends, so a kernel wait SIGKILL cannot break does not hold a worker slot', async () => {
    const start = Date.now()
    expect(await exitWithin(new Promise<number>(() => {}), 50)).toBeNull()
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

// After a kill the runner waits for the whole tree, not only the root (a killed file's own `sleep` was still there, or a zombie,
// when the runner had already said the file was killed): a process still running after the grace is named; one that is gone,
// or a zombie (ended, waiting for its parent to read its exit), is not.
describe('treeEnded', () => {
  it('names a process that is still running once the grace is over, and only that one', async () => {
    const live = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      const start = Date.now()
      expect(await treeEnded([live.pid as number, 2 ** 22 + 7], 150)).toEqual([live.pid]) // the second id is no process
      expect(Date.now() - start).toBeGreaterThanOrEqual(140)
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('a zombie has ended: it is not waited for', async () => {
    // a parent that never reads its child's exit (the shell becomes a plain sleep), so the killed child stays a zombie
    const parent = spawn('sh', ['-c', 'sleep 30 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const kid = Number(await new Promise<string>((r) => parent.stdout?.once('data', (b) => r(String(b).trim()))))
      process.kill(kid, 'SIGKILL')
      const start = Date.now()
      expect(await treeEnded([kid], 5000)).toEqual([])
      expect(Date.now() - start).toBeLessThan(2000) // ended at once, not after the grace
      // and it really is a zombie, which kill(pid, 0) still calls alive: the race this is for
      expect(spawnSync('ps', ['-o', 'stat=', '-p', String(kid)], { encoding: 'utf8' }).stdout.trim()).toMatch(/^Z/)
    } finally {
      parent.kill('SIGKILL')
    }
  })
})
