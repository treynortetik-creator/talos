// The wait-for-a-file loop a stub uses (scripts/wait-loop.ts) ends on the file, on its folder going, and on a cap; and no test
// stub in scripts/ has a loop that waits for ever.
// gate-reads: scripts/*.test.ts scripts/*-test.sh scripts/*-tests.sh apps/bridge/test/*
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { waitForever, waitForFile } from './wait-loop.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wait-loop-'))
  dirs.push(d)
  return d
}

/** A script that has begun waiting: `turned` is true once the loop has gone round (it is told by a file made on each turn). */
function waiting(shell: string, d: string, wait: (turns: string) => string, after = 'echo after') {
  const turns = join(d, 'turns')
  // the mark is made with a command that fails quietly when the folder is gone, so a folder taken away between two looks ends the
  // loop by the folder check and not by the mark
  const c = spawn(shell, ['-c', `${wait(`{ true >> "${turns}" || true; } 2>/dev/null`)}; ${after}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  c.stdout.on('data', (x) => {
    out += x
  })
  c.stderr.on('data', (x) => {
    err += x
  })
  const done = new Promise<number | null>((r) => c.on('close', r))
  const turned = () => vi.waitUntil(() => existsSync(turns), { timeout: scaled(10_000), interval: 10 })
  return { c, done, turned, out: () => out, err: () => err }
}

// every shell the loop must work in: the POSIX sh, the bash 3.2 macOS ships, and whichever bash is first on the PATH
const SHELLS = ['/bin/sh', '/bin/bash', 'bash']

describe.each(SHELLS)('waitForFile in %s', (shell) => {
  // a loop that does not end is stopped here, so the test fails instead of blocking its worker
  const run = (script: string) => spawnSync(shell, ['-c', script], { encoding: 'utf8', timeout: scaled(20_000) })

  it('goes on at once when the file is there, and runs what follows', () => {
    const d = tmp()
    writeFileSync(join(d, 'go'), '')
    const r = run(`${waitForFile(join(d, 'go'))}; echo after`)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('after\n')
  })

  it('ends when the file shows up while it waits: it has gone round before the file is made', async () => {
    const d = tmp()
    const w = waiting(shell, d, (turns) => waitForFile(join(d, 'go'), { keepWhile: turns }))
    await w.turned() // it is waiting, the file is not there
    expect(w.c.exitCode).toBeNull()
    writeFileSync(join(d, 'go'), '')
    expect(await w.done).toBe(0)
    expect(w.out()).toBe('after\n')
  })

  it('gives up, non-zero and without running what follows, when its folder is gone', () => {
    const d = tmp()
    const script = `${waitForFile(join(d, 'sub', 'go'), { cap: 600 })}; echo after`
    rmSync(d, { recursive: true, force: true })
    const r = run(script)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('its folder is gone')
  })

  it('gives up, non-zero and without running what follows, after the cap', () => {
    const d = tmp()
    const r = run(`${waitForFile(join(d, 'never'), { cap: 0.2, step: 0.05 })}; echo after`)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('gave up waiting')
  })

  it('waits for a file whose folder is made later when given an older folder, and gives up when that one is gone', async () => {
    const d = tmp()
    const later = join(d, 'later')
    const w = waiting(shell, d, (turns) => waitForFile(join(later, 'go'), { folder: d, keepWhile: turns }))
    await w.turned() // waiting, and its own folder does not exist yet
    expect(w.c.exitCode).toBeNull()
    mkdirSync(later)
    writeFileSync(join(later, 'go'), '')
    expect(await w.done).toBe(0)
    expect(w.out()).toBe('after\n')

    const script = `${waitForFile(join(later, 'go2'), { folder: d })}; echo after`
    rmSync(d, { recursive: true, force: true })
    const r = run(script)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('keepWhile that fails ends the loop quietly, as if the file were there; one that holds does not', async () => {
    const d = tmp()
    const r = run(`${waitForFile(join(d, 'never'), { keepWhile: 'false' })}; echo after`)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('after\n')
    // keepWhile reads a file the test removes: it waits while the file is there
    const alive = join(d, 'alive')
    writeFileSync(alive, '')
    const w = waiting(shell, d, (turns) =>
      waitForFile(join(d, 'never'), { keepWhile: `[ -e "${alive}" ] && ${turns}` }),
    )
    await w.turned()
    expect(w.c.exitCode).toBeNull()
    rmSync(alive)
    expect(await w.done).toBe(0)
    expect(w.out()).toBe('after\n')
  })

  it('waitForever runs on while its folder is there, and ends non-zero when the folder goes', async () => {
    const d = tmp()
    const w = waiting(shell, d, (turns) => waitForever(d, { keepWhile: turns }))
    await w.turned()
    expect(w.c.exitCode).toBeNull() // nothing ends it: no file is ever made
    rmSync(join(d, 'turns'))
    expect(w.c.exitCode).toBeNull()
    const gone = `${d}-gone`
    renameSync(d, gone)
    dirs.push(gone)
    expect(await w.done).toBe(1)
    expect(w.out()).toBe('')
    expect(w.err()).toContain('its folder is gone')
  })

  it('waitForever gives up after the cap', () => {
    const d = tmp()
    const r = run(`${waitForever(d, { cap: 0.2 })}; echo after`)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('gave up waiting')
  })

  it('expands $HOME in the path, and waits for what the test says (-e, -d)', () => {
    const d = tmp()
    writeFileSync(join(d, 'go'), '')
    const r = spawnSync(shell, ['-c', `${waitForFile('$HOME/go')}; ${waitForFile('$HOME', { test: 'd' })}; echo ok`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: d },
    })
    expect(r.stdout).toBe('ok\n')
  })
})

describe('waitForFile text', () => {
  it('has no single quote, so it fits in sh -c with single quotes', () => {
    expect(waitForFile('/x/y')).not.toContain("'")
  })

  it('refuses a path the double quotes cannot hold', () => {
    expect(() => waitForFile('/x/"y')).toThrow('not a plain path')
    expect(() => waitForFile('/x/`y`')).toThrow('not a plain path')
  })

  it('scales its cap by the time factor', () => {
    const before = process.env.TALOS_TEST_TIME_FACTOR
    try {
      process.env.TALOS_TEST_TIME_FACTOR = '1'
      const one = waitForFile('/x/y', { cap: 10, step: 0.5 })
      process.env.TALOS_TEST_TIME_FACTOR = '3'
      const three = waitForFile('/x/y', { cap: 10, step: 0.5 })
      expect(one).toContain('-ge 20 ]')
      expect(three).toContain('-ge 60 ]')
    } finally {
      if (before === undefined) delete process.env.TALOS_TEST_TIME_FACTOR
      else process.env.TALOS_TEST_TIME_FACTOR = before
    }
  })
})

/**
 * The loops in `text` that wait for ever: a `while` or `until` whose body sleeps, with no counter in it. A loop that reads input
 * or runs through arguments has no sleep in it, and a bounded one counts (`n=$((n + 1))` against `-lt`, `-le` or `-ge`).
 */
function unboundedSleepLoops(text: string): string[] {
  const lines = text.split('\n')
  const found: string[] = []
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // a comment about a loop
    // a loop may run over a few lines of a script in a template string
    const span = lines.slice(i, i + 6).join('\n')
    for (const m of span.matchAll(
      /\b(?:while|until)\s+(?:\[|:|true\b|false\b|!|test\b|grep\b|kill\b|pgrep\b|ls\b|\()[\s\S]*?[;\n]\s*do\b([\s\S]*?)\bdone\b/g,
    )) {
      if (span.slice(0, m.index).includes('\n')) continue // it starts on a later line: that line reports it
      if (!/\bsleep\s+["'0-9$.]/.test(m[1])) continue
      if (/\$\(\(/.test(m[0]) && /-(?:lt|le|ge|gt)\b/.test(m[0])) continue
      found.push(`${i + 1}: ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  })
  return found
}

// A loop that waits for ever and may stay, with the reason: a loop that is only text in a test's data and never runs.
const ALLOWED: Record<string, string[]> = {
  // a sample of another process's command line, the data of the parking logic
  'apps/bridge/test/supervisor/bg-work.test.ts': [
    'until grep -q "h20 exit=" /tmp/claude-501/tasks/bwd5h811r.output 2>/dev/null; do sleep 15; done',
  ],
  // the same: a listed process's command line, and the sentence the supervisor says about it
  'apps/bridge/test/supervisor/workers.test.ts': [
    'until [ -f /tmp/${id}.done ]; do sleep 15; done',
    'until [ -f /tmp/t.done ]; do sleep 15; done',
  ],
}

describe('no stub in a test waits for ever', () => {
  it('finds a loop that sleeps with nothing to end it', () => {
    expect(unboundedSleepLoops('x = `while [ ! -f "${go}" ]; do sleep 0.05; done`')).toHaveLength(1)
    expect(unboundedSleepLoops('a; until [ -f "$HOME/go" ]; do sleep 0.02; done; b')).toHaveLength(1)
    expect(unboundedSleepLoops('trap x TERM; while :; do sleep 1; done')).toHaveLength(1)
    expect(unboundedSleepLoops('echo ran\nwhile [ ! -f go ]; do\n  sleep 0.1\ndone')).toHaveLength(1)
    expect(unboundedSleepLoops('while [ ! -f go ]\ndo\n  sleep 0.1\ndone')).toHaveLength(1) // do on its own line
    expect(unboundedSleepLoops('until [ -f go ]; do sleep .1; done')).toHaveLength(1)
    expect(unboundedSleepLoops('while :; do sleep "$step"; done')).toHaveLength(1)
    expect(unboundedSleepLoops('while :; do sleep $step; done')).toHaveLength(1)
  })

  it('lets a loop with a counter, a loop with no sleep and a comment through', () => {
    expect(unboundedSleepLoops('n=0; while [ ! -f go ] && [ $n -lt 80 ]; do sleep 0.05; n=$((n + 1)); done')).toEqual(
      [],
    )
    expect(unboundedSleepLoops('while [ $# -gt 0 ]; do shift; done')).toEqual([])
    expect(unboundedSleepLoops('while read -r line; do echo "$line"; done')).toEqual([])
    expect(unboundedSleepLoops('// a loop: while true; do sleep 1; done')).toEqual([])
    expect(unboundedSleepLoops('${waitForFile(`${cache}/go`)}')).toEqual([])
  })

  // every test file of scripts/ at any depth, and everything the bridge's tests have (fixtures too); this file's own samples of
  // loops are not stubs
  const root = join(here, '..')
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.name === 'node_modules' || e.name === '__snapshots__'
        ? []
        : e.isDirectory()
          ? walk(join(dir, e.name))
          : [join(dir, e.name)],
    )
  const files = [
    ...walk(here).filter((f) => /\.test\.ts$|-tests?\.sh$/.test(f)),
    ...walk(join(root, 'apps/bridge/test')).filter((f) => /\.(ts|sh)$/.test(f)),
  ]
    .filter((f) => f !== join(here, 'wait-loop.test.ts'))
    .map((f) => relative(root, f))
  it('looks at the test files of scripts/ and the bridge', () => {
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain('apps/bridge/test/supervisor/main.test.ts')
    expect(files.some((f) => f.startsWith('scripts/') && f.split('/').length > 2)).toBe(true) // a nested one
  })

  it.each(files)('%s has none', (file) => {
    const loops = unboundedSleepLoops(readFileSync(join(root, file), 'utf8')).filter(
      (l) => !(ALLOWED[file] ?? []).includes(l.slice(l.indexOf(': ') + 2)),
    )
    expect(loops, `use waitForFile (scripts/wait-loop.ts) or count the turns:\n${loops.join('\n')}`).toEqual([])
  })
})
