// scripts/gate-flakes.sh and scripts/known-flakes.txt: a test step of the gate that fails ONLY on tests the list names (path, test,
// a named owner, an expiry) gets each of them run once again, alone; when every one passes alone the step passes and says so.
// Anything else refuses as it always did: another failure, a mix, an expired or malformed entry, a flake that fails alone too,
// a failure list the gate cannot read. The real gate.sh runs here in a temp repo, with fake bun and pnpm that print the
// runners' own failure lists and answer each rerun as the test says (RERUN_RCS: one exit code per rerun, in order).
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

const UNDO = 'undo points before delivery > a bridge that stops while the message waits gets it again on restart'
const UNDO_FILE = 'apps/bridge/test/undo-delivery.test.ts'
const ENROLL =
  'enrollment (Mac side) > after y the live bridge pins from the file watch, without a manual poll and before its 10 s fallback poll'
const ENROLL_FILE = 'apps/bridge/test/enroll.test.ts'
const BURN = 'cpu-burn.sh: burners never outlive it > a TERM stops the command and every burner (exit 143)'
const BURN2 = 'cpu-burn.sh: burners never outlive it > a normal end and a failing command both stop every burner'
const BURN_FILE = 'scripts/cpu-burn.test.ts'
const OTHER_FILE = 'apps/bridge/test/other.test.ts' // a bridge test the change edits, with no tie to the flaky ones
const FUTURE = '2999-01-01'
const entry = (path: string, name: string, owner = 'Lemnos', until = FUTURE) => `${path}\t${name}\t${owner}\t${until}\n`

/** The bun fake's first run: `bun test <file>` printing its failures (a runner's plain output). */
const bunFails = (file: string, names: string[]) =>
  [
    'bun test v1.4.4',
    '',
    `${file.replace('apps/bridge/', '')}:`,
    ...names.map((n) => `(fail) ${n} [30001.00ms]`),
    '',
    ` 3 pass\n ${names.length} fail`,
    `Ran ${3 + names.length} tests across 1 file. [31.00s]`,
  ].join('\n')

/** test-parallel's output for the whole bridge suite: each failing file's block, its totals, then its failed-files list. */
const parallelFails = (file: string, names: string[]) =>
  [
    '',
    `${file.replace('apps/bridge/', '')}: exit 1`,
    'bun test v1.4.4',
    ...names.map((n) => `(fail) ${n} [30001.00ms]`),
    `\n 3 pass\n ${names.length} fail`,
    `\n 40 pass\n ${names.length} fail`,
    'Ran 43 tests across 9 files. [9.00s]',
    `test-parallel: FAILED (1 of 9):`,
    `- ${file.replace('apps/bridge/', '')}`,
  ].join('\n')

/** Vitest's plain output for failing tests (the gate's own form, with the project label). */
const vitestFails = (names: string[]) =>
  [
    ...names.map((n) => ` FAIL  |scripts| ${BURN_FILE.replace('scripts/', '')} > ${n}`),
    ' Test Files  1 failed | 3 passed (4)',
    `      Tests  ${names.length} failed | 9 passed (10)`,
  ].join('\n')

function setup(known: string | null) {
  const T = mkdtempSync(join(tmpdir(), 'gate-flakes-'))
  dirs.push(T)
  const cache = join(T, 'cache')
  const calls = join(T, 'calls')
  const bin = join(T, 'bin')
  const env = gateTestEnv({ ...gitEnv, TALOS_CI_CACHE: cache, TALOS_TEST_TIME_FACTOR: '2', CALLS: calls })
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const put = (f: string, t = 'x\n') => {
    mkdirSync(dirname(join(T, f)), { recursive: true })
    writeFileSync(join(T, f), t)
  }
  const stub = (f: string, body: string) => {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, `#!/bin/sh\n${body}\n`)
    chmodSync(f, 0o755)
  }
  git('init', '-q', '-b', 'main')
  for (const f of [
    'gate.sh',
    'gate-excuse.sh',
    'gate-fast.sh',
    'gate-excuse.pl',
    'ci-alert-tests.pl',
    'gate-flakes.sh',
    'talos-machine.sh',
    'gate-inputs.txt',
    'check-no-personal.sh',
    'denylist.generic.txt',
  ]) {
    mkdirSync(join(T, 'scripts'), { recursive: true })
    if (existsSync(join(here, f))) cpSync(join(here, f), join(T, 'scripts', f))
  }
  cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
  if (known !== null) put('scripts/known-flakes.txt', known)
  put('docs/a.md')
  put('apps/bridge/src/a.ts')
  put(UNDO_FILE, "import { a } from '../src/a.ts'\n")
  put(ENROLL_FILE, "import { a } from '../src/a.ts'\n")
  put(BURN_FILE)
  put('apps/bridge/src/b.ts')
  put(OTHER_FILE, "import { b } from '../src/b.ts'\n")
  put('scripts/other.test.ts')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  stub(join(T, 'node_modules/.bin/biome'), 'exit 0')
  // pnpm: everything passes, except the vitest steps, which print the test's own output
  stub(
    join(bin, 'pnpm'),
    `echo "pnpm [$(basename "$PWD")] $*" >> "$CALLS"
case "$*" in
  "exec vitest run --project scripts scripts/size-budget.test.ts") exit 0 ;;
  "exec vitest related"*) [ -n "$FIRST_OUT" ] && { printf '%s\\n' "$FIRST_OUT"; exit 1; }; exit 0 ;;
  "exec vitest run"*)
    n=$(cat "$CALLS.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$CALLS.n"
    rc=$(echo "\${RERUN_RCS:-0 0 0 0}" | cut -d' ' -f$n)
    if [ -n "$RERUN_TEXT" ]; then printf '%s\\n' "$RERUN_TEXT"
    elif [ "$rc" = 0 ]; then echo '      Tests  1 passed | 9 skipped (10)'
    else echo '      Tests  1 failed | 9 skipped (10)'; fi
    exit "$rc" ;;
esac
exit 0`,
  )
  // bun: the first run (no -t) prints FIRST_OUT and fails; a rerun (-t) answers from RERUN_RCS, in order
  stub(
    join(bin, 'bun'),
    `case "$1" in --version) echo 1.4.5; exit 0 ;; -e) echo 3.45.0; exit 0 ;; esac
echo "bun [$(basename "$PWD")] $*" >> "$CALLS"
case " $* " in
  *" -t "*)
    n=$(cat "$CALLS.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$CALLS.n"
    rc=$(echo "\${RERUN_RCS:-0 0 0 0}" | cut -d' ' -f$n)
    if [ -n "$RERUN_TEXT" ]; then printf '%s\\n' "$RERUN_TEXT"
    elif [ "$rc" = 0 ]; then printf ' 1 pass\\n 0 fail\\n'
    else printf ' 0 pass\\n 1 fail\\n'; fi
    exit "$rc" ;;
esac
printf '%s\\n' "$FIRST_OUT"
exit 1`,
  )
  const change = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) put(f, t)
    git('add', '-A')
    git('commit', '-qm', 'change')
  }
  const gate = (extra: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/gate.sh', '--base', base], {
      cwd: T,
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, ...extra },
      encoding: 'utf8',
    })
  const callLog = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [])
  const reruns = () => callLog().filter((l) => / -t /.test(l))
  const rerunLog = () => {
    const f = join(cache, 'logs/flake-reruns.tsv')
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t'))
      : []
  }
  return { T, change, gate, callLog, reruns, rerunLog }
}

/**
 * A repo whose change makes the gate run its bridge files (the step "tests (bridge files)", plain `bun test`): it edits a bridge
 * test of its own, and touches neither the flaky tests nor the code they name.
 */
const bridgeChange = (r: ReturnType<typeof setup>) =>
  r.change({ [OTHER_FILE]: "import { b } from '../src/b.ts'\n// 2\n" })

describe('gate.sh: a known flaky test that fails alone gets one rerun, alone', () => {
  it('the only failure is a listed flake and it passes alone: the gate passes, says so, and logs the rerun', () => {
    const r = setup(entry(UNDO_FILE, UNDO))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
    expect(g.status, g.stderr).toBe(0)
    expect(g.stderr).toContain(`gate: known flake ${UNDO} (owner Lemnos) failed, passed alone on rerun`)
    expect(g.stderr).toContain(
      'gate: tests (bridge files) failed only on known flaky tests (1), each passed alone on rerun: the step passes',
    )
    expect(g.stderr).not.toContain('REFUSED')
    expect(g.stderr).toMatch(/gate: passed\n$/)
    // one rerun, in apps/bridge, of that one file and that one test (anchored, regex-escaped), with the test time factor
    const pat =
      '^undo points before delivery( > | )a bridge that stops while the message waits gets it again on restart$'
    expect(r.reruns()).toEqual([`bun [bridge] test --timeout=10000 ./test/undo-delivery.test.ts -t ${pat}`])
    const rows = r.rerunLog()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.slice(2)).toEqual(['tests (bridge files)', UNDO_FILE, UNDO, 'Lemnos', 'passed-alone'])
    expect(rows[0]?.[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  })

  it('the name is regex-escaped for the rerun (parentheses, dots, plus signs)', () => {
    const r = setup(entry(ENROLL_FILE, ENROLL))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(ENROLL_FILE, [ENROLL]) })
    expect(g.status, g.stderr).toBe(0)
    expect(r.reruns()[0]).toContain('-t ^enrollment \\(Mac side\\)( > | )after y the live bridge pins')
  })

  it('the whole bridge suite (test-parallel): its failure list is read the same way', () => {
    const r = setup(entry(UNDO_FILE, UNDO))
    r.change({ 'apps/bridge/src/b.ts': 'export const b = 2\n' })
    const g = r.gate({ FIRST_OUT: parallelFails(UNDO_FILE, [UNDO]) })
    expect(g.status, g.stderr).toBe(0)
    expect(g.stderr).toContain(`gate: known flake ${UNDO} (owner Lemnos) failed, passed alone on rerun`)
    expect(r.reruns()).toHaveLength(1)
    // the whole suite's own per-test limit (test-parallel's 20 s) x the factor, not the bridge-files step's 5 s
    expect(r.reruns()[0]).toContain('test --timeout=40000 ./test/undo-delivery.test.ts')
  })

  it('a Vitest flake (vitest related): rerun alone in its project, and it passes', () => {
    const r = setup(entry(BURN_FILE, BURN))
    r.change({ 'scripts/other.test.ts': 'y\n' })
    const g = r.gate({ FIRST_OUT: vitestFails([BURN]) })
    expect(g.status, g.stderr).toBe(0)
    expect(g.stderr).toContain(`gate: known flake ${BURN} (owner Lemnos) failed, passed alone on rerun`)
    expect(r.reruns()).toHaveLength(1)
    expect(r.reruns()[0]).toMatch(
      /^pnpm \[.+\] exec vitest run --project scripts scripts\/cpu-burn\.test\.ts -t \^cpu-burn\\\.sh: burners never outlive it\( > \| \)a TERM stops the command and every burner \\\(exit 143\\\)\$$/,
    )
  })

  it('two flakes, each rerun alone, in order, each passing: the gate passes', () => {
    const r = setup(entry(UNDO_FILE, UNDO) + entry(ENROLL_FILE, ENROLL))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: `${bunFails(UNDO_FILE, [UNDO])}\n${bunFails(ENROLL_FILE, [ENROLL])}\n 2 fail` })
    expect(g.status, g.stderr).toBe(0)
    expect(r.reruns()).toHaveLength(2)
    expect(r.rerunLog().map((x) => x[3])).toEqual([UNDO_FILE, ENROLL_FILE])
  })
})

describe('gate.sh: everything else refuses as it always did', () => {
  it('a listed flake that fails alone too: refused, and the log says it failed alone', () => {
    const r = setup(entry(UNDO_FILE, UNDO))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]), RERUN_RCS: '1' })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
    expect(g.stderr).toContain(`known flake ${UNDO} (owner Lemnos) failed again alone`)
    expect(g.stderr).not.toContain('passed alone on rerun')
    expect(r.reruns()).toHaveLength(1)
    expect(r.rerunLog()[0]?.[6]).toBe('failed-alone')
  })

  it('two flakes, the first passes alone and the second fails alone: refused', () => {
    const r = setup(entry(UNDO_FILE, UNDO) + entry(ENROLL_FILE, ENROLL))
    bridgeChange(r)
    const g = r.gate({
      FIRST_OUT: `${bunFails(UNDO_FILE, [UNDO])}\n${bunFails(ENROLL_FILE, [ENROLL])}\n 2 fail`,
      RERUN_RCS: '0 1',
    })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
    expect(g.stderr).toContain(`known flake ${ENROLL} (owner Lemnos) failed again alone`)
  })

  it('a rerun that exits 0 but ran no test (the name drifted) is not a pass', () => {
    const r = setup(entry(BURN_FILE, BURN))
    r.change({ 'scripts/other.test.ts': 'y\n' })
    const g = r.gate({ FIRST_OUT: vitestFails([BURN]), RERUN_TEXT: '      Tests  10 skipped (10)' })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (vitest related) failed (above)')
    expect(g.stderr).not.toContain('passed alone on rerun')
  })

  it('an unlisted failure: refused, nothing rerun', () => {
    const r = setup(entry(UNDO_FILE, UNDO))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, ['undo points before delivery > a different test']) })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
    expect(r.reruns()).toEqual([])
    expect(r.rerunLog()).toEqual([])
  })

  it('a listed flake named for another file is not that flake', () => {
    const r = setup(entry(ENROLL_FILE, UNDO))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
    expect(g.status, g.stderr).toBe(1)
    expect(r.reruns()).toEqual([])
  })

  it('a listed flake together with an unlisted failure: refused without any rerun', () => {
    const r = setup(entry(UNDO_FILE, UNDO))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO, 'undo points before delivery > a real bug']) })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
    expect(g.stderr).toContain('undo points before delivery > a real bug is not a known flake')
    expect(r.reruns()).toEqual([])
    expect(r.rerunLog()).toEqual([])
  })

  it('an expired entry gets no rerun: refused, saying it expired', () => {
    const r = setup(entry(UNDO_FILE, UNDO, 'Lemnos', '2020-01-01'))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
    expect(g.stderr).toContain('expired 2020-01-01')
    expect(r.reruns()).toEqual([])
  })

  it('an entry with no owner, a placeholder owner, or a date that is not one is no entry', () => {
    for (const line of [
      entry(UNDO_FILE, UNDO, ''),
      entry(UNDO_FILE, UNDO, 'unknown'),
      entry(UNDO_FILE, UNDO, 'Lemnos', 'soon'),
      entry(UNDO_FILE, UNDO, 'Lemnos', ''),
      `${UNDO_FILE}\t${UNDO}\n`,
    ]) {
      const r = setup(line)
      bridgeChange(r)
      const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
      expect(g.status, g.stderr).toBe(1)
      expect(r.reruns(), line).toEqual([])
    }
  })

  it('an unreadable failure list refuses: a count no name accounts for, an error outside a test, a file that failed to load', () => {
    const named = bunFails(UNDO_FILE, [UNDO])
    for (const out of [
      named.replace(' 1 fail', ' 2 fail'), // the runner counts two failures, one is named
      `${named}\n# Unhandled error between tests\n`,
      `${named}\ntest-parallel: FAILED (2 of 9):\n- test/other.test.ts`, // a failed file with no test of it named
      'error: something broke',
      '',
    ]) {
      const r = setup(entry(UNDO_FILE, UNDO))
      bridgeChange(r)
      const g = r.gate({ FIRST_OUT: out })
      expect(g.status, `${out}\n${g.stderr}`).toBe(1)
      expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
      expect(r.reruns(), out).toEqual([])
    }
  })

  it('a change cannot add its own flake: the list is read from the base, so its new entry gets no rerun', () => {
    for (const base of [null, entry(ENROLL_FILE, ENROLL)]) {
      const r = setup(base)
      // the change adds the entry for the very test that fails in it (and touches nothing that test reaches)
      const list = `${base ?? ''}${entry(UNDO_FILE, UNDO)}`
      r.change({ 'scripts/known-flakes.txt': list, [OTHER_FILE]: "import { b } from '../src/b.ts'\n// 2\n" })
      const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
      expect(g.status, g.stderr).toBe(1)
      expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
      expect(g.stderr).not.toContain('passed alone on rerun')
      expect(r.reruns()).toEqual([])
    }
  })

  it('a change that edits the flaky test, or the code it names, gets no rerun: a real slowdown there would pass alone', () => {
    const cases: Array<[string, Record<string, string>, string, string]> = [
      [
        'the test file itself',
        { [UNDO_FILE]: "import { a } from '../src/a.ts'\n// 2\n" },
        bunFails(UNDO_FILE, [UNDO]),
        `this change changes ${UNDO_FILE}`,
      ],
      [
        'a file it names (the whole suite runs)',
        { 'apps/bridge/src/a.ts': 'export const a = 2\n' },
        parallelFails(UNDO_FILE, [UNDO]),
        `this change changes apps/bridge/src/a.ts, which ${UNDO_FILE} names`,
      ],
    ]
    for (const [what, files, out, why] of cases) {
      const r = setup(entry(UNDO_FILE, UNDO))
      r.change(files)
      const g = r.gate({ FIRST_OUT: out })
      expect(g.status, `${what}\n${g.stderr}`).toBe(1)
      expect(g.stderr, what).toContain('gate: REFUSED: tests (')
      expect(g.stderr, what).toContain(`${UNDO} (${UNDO_FILE}) is a known flake, but ${why}`)
      expect(r.reruns(), what).toEqual([])
      expect(r.rerunLog(), what).toEqual([])
    }
    // a Vitest flake whose own test file the change edits
    const r = setup(entry(BURN_FILE, BURN))
    r.change({ [BURN_FILE]: 'y\n' })
    const g = r.gate({ FIRST_OUT: vitestFails([BURN]) })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain(`is a known flake, but this change changes ${BURN_FILE}`)
    expect(r.reruns()).toEqual([])
  })

  it('a date that is not a calendar day is no date: refused, no rerun; a real leap day is one', () => {
    for (const until of [
      '2999-99-99',
      '2999-13-01',
      '2999-00-10',
      '2999-02-30',
      '2999-02-29',
      '2999-04-31',
      '0000-01-01',
    ]) {
      const r = setup(entry(UNDO_FILE, UNDO, 'Lemnos', until))
      bridgeChange(r)
      const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
      expect(g.status, `${until}\n${g.stderr}`).toBe(1)
      expect(g.stderr, until).toContain('has an entry with no valid date')
      expect(r.reruns(), until).toEqual([])
    }
    const r = setup(entry(UNDO_FILE, UNDO, 'Lemnos', '2400-02-29'))
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
    expect(g.status, g.stderr).toBe(0)
    expect(r.reruns()).toHaveLength(1)
  })

  it('no list at all: refused as before', () => {
    const r = setup(null)
    bridgeChange(r)
    const g = r.gate({ FIRST_OUT: bunFails(UNDO_FILE, [UNDO]) })
    expect(g.status, g.stderr).toBe(1)
    expect(g.stderr).toContain('gate: REFUSED: tests (bridge files) failed (above)')
    expect(r.reruns()).toEqual([])
  })
})

describe('scripts/known-flakes.txt, the list itself', () => {
  const rows = readFileSync(join(here, 'known-flakes.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'))

  it('every line is <path> TAB <test> TAB <owner> TAB <until YYYY-MM-DD>, the file exists and its test name is in it', () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const [path = '', name = '', owner = '', until = ''] of rows) {
      expect(`${path}\t${name}`).toMatch(/^\S+\t\S/)
      expect(owner, name).toMatch(/\S/)
      expect(until, name).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
      const file = join(here, '..', path)
      expect(existsSync(file), path).toBe(true)
      // the test's own title is in the file (the last part of "describe > test"): a rename that leaves the list behind shows here
      const leaf = name.split(' > ').pop() ?? ''
      expect(readFileSync(file, 'utf8'), name).toContain(leaf)
    }
  })

  it('seeds the known flakes, each with an owner and an expiry', () => {
    const seeded = rows.map((x) => `${x[0]}\t${x[1]}`)
    // not undo-delivery's "gets it again on restart": that one is a real message-loss bug, so it must refuse, never rerun
    expect(seeded).not.toContain(entry(UNDO_FILE, UNDO).split('\t').slice(0, 2).join('\t'))
    for (const e of [entry(ENROLL_FILE, ENROLL), entry(BURN_FILE, BURN), entry(BURN_FILE, BURN2)]) {
      expect(seeded).toContain(e.split('\t').slice(0, 2).join('\t'))
    }
    expect(
      seeded.some((s) =>
        s.startsWith('scripts/test-parallel.test.ts\ttest-parallel > a file that hangs inside one call'),
      ),
    ).toBe(true)
    expect(rows.every((x) => x[2] === 'Lemnos' && x[3] === '2026-11-23')).toBe(true)
  })
})
