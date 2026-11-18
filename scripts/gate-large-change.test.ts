// scripts/gate.sh on a change of hundreds of files. Planning reads a few command outputs per changed file. Read through
// `done < <(cmd)`, bash 3.2 (the macOS /bin/bash) kept every one of those descriptors open until the whole planning step ended,
// and past descriptor 255 it wrote outside its own table: on a change of about 80 files or more the gate died (abort 134, a bus
// error, a kill) or read empty lists, so tests it should have planned were silently left out (2026-11-13). This builds a
// 300-file change that gives every per-file read something to find (the tests naming a script, in the Vitest projects and the
// bridge; a test listing a script's folder; the tests naming a doc; a feature's specs, on Chromium and WebKit) and checks the
// plan comes out whole, under `bash` on PATH and under /bin/bash when there is one (the Mac's 3.2). Then the plan's second
// count: a gate whose plan is wrong in any way (a test dropped or added, a flag, planning that fails, a check that cannot run)
// refuses instead of running a plan it cannot trust.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
vi.setConfig({ testTimeout: scaled(120_000), hookTimeout: scaled(120_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const env = gateTestEnv({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
})

const num = (i: number) => String(i).padStart(3, '0')
const GATE = readFileSync(join(here, 'gate.sh'), 'utf8')
const PLAN = readFileSync(join(here, 'gate/plan.sh'), 'utf8') // the planning helpers gate.sh sources

/** A change of `n` scripts, `n` docs and `n` web feature modules (3n files), on a base whose tests reach every one of them. */
function change(n: number, { gate, plan: planSh } = { gate: GATE, plan: PLAN }) {
  const T = mkdtempSync(join(tmpdir(), 'gate-big-'))
  dirs.push(T)
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const put = (f: string, t = 'x\n') => {
    mkdirSync(dirname(join(T, f)), { recursive: true })
    writeFileSync(join(T, f), t)
  }
  git('init', '-q', '-b', 'main')
  put('scripts/gate.sh', gate)
  cpSync(join(here, 'talos-machine.sh'), join(T, 'scripts/talos-machine.sh'))
  cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
  put('scripts/gate/plan.sh', planSh)
  put('apps/web/playwright.config.ts', 'export default {}\n')
  put('apps/web/test/foo/foo.spec.ts') // the feature's own browser spec
  const vit: string[] = []
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    put(`scripts/s${num(i)}.test.ts`, `const script = 'scripts/tools/s${num(i)}.sh'\n`) // names one script
    vit.push(`scripts/s${num(i)}.test.ts`)
    names.push(`'d${num(i)}.md'`, `'s${num(i)}.sh'`)
  }
  put('scripts/docs-reader.test.ts', `const docs = [${names.filter((x) => x.includes('.md')).join(', ')}]\n`)
  put('scripts/tools-list.test.ts', "const all = readdirSync('scripts/tools')\n") // lists the scripts' folder
  put('apps/bridge/test/scripts-named.test.ts', `const all = [${names.filter((x) => x.includes('.sh')).join(', ')}]\n`)
  vit.push('scripts/docs-reader.test.ts', 'scripts/tools-list.test.ts')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  for (let i = 0; i < n; i++) {
    put(`scripts/tools/s${num(i)}.sh`, 'echo x\n')
    put(`docs/d${num(i)}.md`, 'words\n')
    put(`apps/web/src/features/foo/m${num(i)}.ts`, 'export const x = 1\n')
    vit.push(`apps/web/src/features/foo/m${num(i)}.ts`)
  }
  git('add', '-A')
  git('commit', '-qm', 'change')
  expect(git('diff', '--name-only', base, 'HEAD').split('\n')).toHaveLength(3 * n)
  const want = [
    ...['typecheck', 'lint', 'personal', 'size', 'vitest'],
    ...vit.sort().map((t) => `\t${t}`),
    ...['bun', '\tapps/bridge/test/scripts-named.test.ts'],
    ...['web-specs', '\ttest/foo/foo.spec.ts', 'web-specs-webkit', '\ttest/foo/foo.spec.ts'],
  ]
  const plan = (sh = 'bash', e: Record<string, string> = {}) =>
    spawnSync(sh, ['scripts/gate.sh', '--plan', '--base', base], { cwd: T, env: { ...env, ...e }, encoding: 'utf8' })
  return { T, want, plan }
}

const shells = ['bash', ...(existsSync('/bin/bash') ? ['/bin/bash'] : [])]

describe('gate.sh plans a change of hundreds of files whole', () => {
  it.each(shells)('under %s: exit 0, and every test the 300 files reach is planned', (sh) => {
    const r = change(100)
    const p = r.plan(sh)
    expect(p.signal, p.stderr).toBeNull()
    expect(p.status, p.stderr).toBe(0)
    expect(p.stdout.trim().split('\n')).toEqual(r.want)
  })
})

describe('the plan fails closed: a second count must agree with it, or the gate refuses', () => {
  /** gate.sh and gate/plan.sh with `from` replaced by `to` (once, in whichever holds it; it must be there). */
  const broken = (from: string, to: string) => {
    expect(GATE.split(from).length + PLAN.split(from).length).toBe(3)
    return GATE.includes(from)
      ? { gate: GATE.replace(from, to), plan: PLAN }
      : { gate: GATE, plan: PLAN.replace(from, to) }
  }
  const refused = (p: ReturnType<ReturnType<typeof change>['plan']>, why: string) => {
    expect(p.status, p.stderr).toBe(1)
    expect(p.stdout).toBe('') // no plan printed: the stamp and the race check get nothing to trust
    expect(p.stderr).toContain(why)
  }
  const END = "    WEBKIT=() # a change that wide is CI's to run on every browser\n  fi\n  return 0\n}\n" // plan_suites' end
  const DIFFER = 'gate: REFUSED: the planned suites differ from a second count of this change'

  it('the gate as it is agrees with the count', () => {
    const r = change(3)
    expect(r.plan().status, r.plan().stderr).toBe(0)
  })

  it('a planned test left out', () => {
    const r = change(3, broken('for r in $VITEST_ROOTS; do case "$f" in "$r"/*) vit+=("$f") ;; esac; done', ':'))
    const p = r.plan()
    refused(p, DIFFER)
    expect(p.stderr).toContain('plan-check: VIT is missing apps/web/src/features/foo/m000.ts')
  })

  it('a test the change does not reach, added', () => {
    const r = change(3, broken('  uniq_into VIT ', '  uniq_into VIT scripts/extra.test.ts '))
    const p = r.plan()
    refused(p, DIFFER)
    expect(p.stderr).toContain('plan-check: VIT has scripts/extra.test.ts, which the second count does not')
  })

  it('a whole-suite flag lost', () => {
    const r = change(3, broken(END, END.replace('  return 0', '  BUN=()\n  return 0')))
    refused(r.plan(), 'plan-check: BUN is missing apps/bridge/test/scripts-named.test.ts')
    const old = change(3, broken(END, END.replace('  return 0', '  OLD=1\n  return 0')))
    refused(old.plan(), 'plan-check: OLD has 1, which the second count does not')
  })

  it('planning that fails', () => {
    refused(
      change(3, broken(END, END.replace('return 0', 'return 3'))).plan(),
      'gate: REFUSED: planning the suites failed (exit 3)',
    )
  })

  it('a second count that cannot run, or answers nothing', () => {
    refused(change(3, broken('node -e "$FAST_CHECK_JS$PLAN_CHECK_JS"', 'node -e ""')).plan(), DIFFER)
    refused(change(3, broken('node -e "$FAST_CHECK_JS$PLAN_CHECK_JS"', 'node -e "process.exit(9)"')).plan(), DIFFER)
  })

  it('no node on PATH', () => {
    const r = change(1)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    // only the tools planning needs, linked one by one: no node among them
    for (const t of [
      'bash',
      'git',
      'grep',
      'sed',
      'sort',
      'find',
      'xargs',
      'tr',
      'dirname',
      'basename',
      'cat',
      'head',
      'uname',
      'sysctl',
      'getconf',
      'nproc',
    ]) {
      const w = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
      if (w.startsWith('/')) symlinkSync(w, join(bin, t))
    }
    refused(r.plan('bash', { PATH: bin }), 'gate: REFUSED: no node on PATH: the plan cannot be checked')
  })
})
