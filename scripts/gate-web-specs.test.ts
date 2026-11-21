// A change's own web browser specs (apps/web/test/**/*.spec.ts) run in the gate on every Playwright project they belong to
// (apps/web/playwright.config.ts): the fast gate runs the changed spec files themselves, the planned gate also runs its own specs
// on pixel. The plan prints the projects on stderr ("web projects: <spec> -> <projects>"); stdout stays the plan the other
// tests pin. Every --plan here goes through both counts (bash and node), which must agree or the gate refuses.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
vi.setConfig({ testTimeout: scaled(30_000), hookTimeout: scaled(30_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CACHE = mkdtempSync(join(tmpdir(), 'gate-web-cache-'))
dirs.push(CACHE)
const env = gateTestEnv({
  TALOS_CI_CACHE: CACHE,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
})
const CHECKS = ['typecheck', 'lint', 'personal', 'size', 'timing']
const SPEC = 'apps/web/test/threads/x.spec.ts'

function repo() {
  const T = mkdtempSync(join(tmpdir(), 'gate-web-'))
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
  mkdirSync(join(T, 'scripts'))
  for (const f of [
    'gate.sh',
    'gate-fast.sh',
    'talos-machine.sh',
    'gate-inputs.txt',
    'gate-fast-keepout.txt',
    'check-no-personal.sh',
    'denylist.generic.txt',
  ])
    cpSync(join(here, f), join(T, 'scripts', f))
  cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
  put('docs/protected-paths.txt', 'apps/bridge/src/keys.ts\n')
  put('docs/a.md')
  put('apps/web/playwright.config.ts', 'export default {}\n')
  put('apps/web/test/threads/threads.spec.ts') // the smoke set
  put('apps/web/test/threads/old.spec.ts')
  put('apps/web/test/cards/permission-sheet.spec.ts')
  put('apps/web/src/a.ts')
  put('apps/web/src/features/threads/Thread.tsx')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const commit = (files: Record<string, string | null>) => {
    for (const [f, t] of Object.entries(files)) {
      if (t === null) git('rm', '-q', f)
      else put(f, t)
    }
    git('add', '-A')
    git('commit', '-qm', 'change')
  }
  const plan = (...a: string[]) => {
    const r = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base, ...a], { cwd: T, env, encoding: 'utf8' })
    expect(r.stderr).not.toContain('plan-check:') // the second count agreed
    expect(r.status, r.stderr).toBe(0)
    const projects = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('web projects: '))
      .map((l) => l.slice('web projects: '.length))
    return { lines: r.stdout.trim().split('\n'), projects, err: r.stderr }
  }
  return { T, git, put, commit, plan, base }
}

describe('the fast gate runs the change’s own browser specs on every project that takes them', () => {
  it('a changed spec: web-specs and web-specs-webkit, on desktop, iphone and pixel', () => {
    const r = repo()
    r.commit({ [SPEC]: 'y\n' })
    const p = r.plan('--fast')
    expect(p.lines).toEqual([
      'fast',
      ...CHECKS,
      'vitest',
      `\t${SPEC}`,
      'web-specs',
      '\ttest/threads/x.spec.ts',
      'web-specs-webkit',
      '\ttest/threads/x.spec.ts',
    ])
    expect(p.projects).toEqual(['test/threads/x.spec.ts -> desktop iphone pixel'])
  })

  it('the permission sheet spec also runs on iphone-se, the one project whose testMatch names it', () => {
    const r = repo()
    r.commit({ 'apps/web/test/cards/permission-sheet.spec.ts': 'y\n' })
    expect(r.plan('--fast').projects).toEqual(['test/cards/permission-sheet.spec.ts -> desktop iphone iphone-se pixel'])
  })

  it('a changed source file, a support file or a helper brings no spec into the fast gate', () => {
    const r = repo()
    r.commit({
      'apps/web/src/a.ts': 'y\n',
      'apps/web/src/features/threads/Thread.tsx': 'y\n',
      'apps/web/test/helpers/fixtures.ts': 'y\n',
      'apps/web/test/threads/support.ts': 'y\n',
    })
    const p = r.plan('--fast')
    expect(p.lines).not.toContain('web-specs')
    expect(p.lines).not.toContain('web-specs-webkit')
    expect(p.projects).toEqual([])
    // the planned gate for the same change does run them
    expect(r.plan().lines).toContain('web-specs')
  })

  it('a deleted spec runs nothing and refuses nothing', () => {
    const r = repo()
    r.commit({ 'apps/web/test/threads/old.spec.ts': null })
    const p = r.plan('--fast')
    expect(p.lines[0]).toBe('fast')
    expect(p.lines).not.toContain('web-specs')
    expect(p.projects).toEqual([])
  })

  it('a spec beside a bridge change: both run, the bridge by import, the spec itself', () => {
    const r = repo()
    r.put('apps/bridge/src/b.ts', 'export const b = 1\n')
    r.put('apps/bridge/test/b.test.ts', "import { b } from '../src/b.ts'\n")
    r.git('add', '-A')
    r.git('commit', '-qm', 'bridge')
    const base = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 2\n', [SPEC]: 'y\n' })
    const q = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', base], {
      cwd: r.T,
      env,
      encoding: 'utf8',
    })
    expect(q.stderr).not.toContain('plan-check:')
    expect(q.stdout).toContain('bun\n\tapps/bridge/test/b.test.ts')
    expect(q.stdout).toContain('web-specs\n\ttest/threads/x.spec.ts')
  })

  it('more changed specs than WEB_SPECS_MAX is the full gate, which names its own smoke-set cap; never a silent drop', () => {
    const r = repo()
    r.commit({ [SPEC]: 'y\n', 'apps/web/test/threads/y.spec.ts': 'y\n', 'apps/web/test/threads/z.spec.ts': 'y\n' })
    const w = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', r.base], {
      cwd: r.T,
      env: { ...env, WEB_SPECS_MAX: '2' },
      encoding: 'utf8',
    })
    expect(w.stderr).not.toContain('plan-check:')
    expect(w.status).toBe(0)
    expect(w.stdout.split('\n')[0]).toMatch(/^full-gate: it changes 3 browser specs, more than 2 /)
  })

  it('--checks-only plans no browser spec', () => {
    const r = repo()
    r.commit({ [SPEC]: 'y\n' })
    expect(r.plan('--fast', '--checks-only').lines).toEqual(CHECKS)
  })
})

describe('the planned gate runs the change’s own specs on pixel too', () => {
  it('the own specs: iphone and pixel; the smoke set and the rest: Chromium desktop only', () => {
    const r = repo()
    r.commit({ [SPEC]: 'y\n' })
    const p = r.plan()
    expect(p.lines).toContain('web-specs-webkit') // the plan's key keeps its name
    expect(p.projects).toEqual(['test/threads/x.spec.ts -> desktop iphone pixel'])
    const s = repo()
    s.commit({ 'apps/web/src/a.ts': 'y\n' }) // shared code: the smoke set
    expect(s.plan().projects).toEqual(['test/threads/threads.spec.ts -> desktop'])
  })
})

describe('the planned gate: names Playwright would read as patterns', () => {
  it('a spec whose path holds a regular-expression character is refused by name, in the fast and the planned gate', () => {
    for (const name of ['a+b', 'x(1)', 'a[1]', 'a$b', 'a{2}', 'a|b', 'a^b', 'a?b', 'a*b', 'a\\b']) {
      const r = repo()
      const file = `apps/web/test/threads/${name}.spec.ts`
      r.commit({ [file]: 'y\n' })
      for (const extra of [[], ['--fast']]) {
        const q = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', r.base, ...extra], {
          cwd: r.T,
          env,
          encoding: 'utf8',
        })
        expect(q.status, q.stderr).toBe(1)
        expect(q.stderr).toContain('REFUSED')
        expect(q.stderr).toContain(`test/threads/${name}.spec.ts`)
      }
    }
  })

  it('an end-to-end spec with a regular-expression character is refused too (e2e passes its specs to Playwright the same way)', () => {
    const r = repo()
    r.commit({ 'e2e/tests/a(1).spec.ts': 'y\n' })
    const q = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', r.base], { cwd: r.T, env, encoding: 'utf8' })
    expect(q.status, q.stderr).toBe(1)
    expect(q.stderr).toContain('REFUSED')
    expect(q.stderr).toContain('tests/a(1).spec.ts')
  })
})

describe('gate.sh run: the browser step, its checks and the heavy lock', () => {
  /** A repo whose gate can reach the suites: stand-in tools, a fake Playwright with the browsers named by `have`. */
  function runnable(have: { chromium: boolean; webkit: boolean }, opts: { passThrough?: boolean; pnpm?: string } = {}) {
    const r = repo()
    r.put('node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
    chmodSync(join(r.T, 'node_modules/.bin/biome'), 0o755)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), opts.pnpm ?? '#!/bin/sh\necho "pnpm $*" >> "$0.log"\nexit 0\n', { mode: 0o755 })
    // refusing (exit 75, the lock was not had), or a stand-in that takes the slot for free and really runs the inner gate
    r.put(
      'scripts/heavy-lock.sh',
      opts.passThrough
        ? 'echo "lock: $*" >> "$(dirname "$0")/../lock.log"\ncase "$1" in\n  run) shift; while [ "$1" != -- ]; do shift; done; shift; exec "$@" ;;\n  held) exit 1 ;;\nesac\nexit 0\n'
        : 'echo called > "$(dirname "$0")/../lock.log"\nexit 75\n',
    )
    r.put('apps/web/node_modules/@playwright/test/package.json', '{"name":"@playwright/test","main":"index.js"}\n')
    r.put(
      'apps/web/node_modules/@playwright/test/index.js',
      `exports.chromium = { executablePath: () => ${have.chromium ? "'/bin/sh'" : "'/nonexistent/chromium'"} }\n` +
        `exports.webkit = { executablePath: () => ${have.webkit ? "'/bin/sh'" : "'/nonexistent/webkit'"} }\n`,
    )
    r.put('.gitignore', 'node_modules\nbin\nlock.log\n')
    r.git('add', '-A')
    r.git('commit', '-qm', 'tools')
    const base = r.git('rev-parse', 'HEAD')
    const path = [bin, ...(process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, 'bun')))].join(':')
    const gate = (...a: string[]) =>
      spawnSync('bash', ['scripts/gate.sh', '--fast', '--base', base, ...a], {
        cwd: r.T,
        env: { ...env, PATH: path },
        encoding: 'utf8',
      })
    return { ...r, base, gate, lock: join(r.T, 'lock.log'), pnpmLog: join(bin, 'pnpm.log') }
  }

  it('a fast gate with a spec takes the heavy lock (here refused it); one with no spec never calls it', () => {
    const r = runnable({ chromium: true, webkit: true })
    r.commit({ [SPEC]: 'y\n' })
    const p = r.gate()
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('the tests could not get the heavy lock')
    expect(existsSync(r.lock)).toBe(true)
    const q = runnable({ chromium: true, webkit: true })
    q.commit({ 'apps/web/src/a.ts': 'y\n' })
    const g = q.gate()
    expect(g.status, g.stderr).toBe(0)
    expect(g.stderr).toContain('no heavy lock')
    expect(existsSync(q.lock)).toBe(false)
  })

  it('a missing Chromium or WebKit refuses the fast gate before any step: a spec that cannot run is not a pass', () => {
    const noChromium = runnable({ chromium: false, webkit: true })
    noChromium.commit({ [SPEC]: 'y\n' })
    const a = noChromium.gate()
    expect(a.status).toBe(1)
    expect(a.stderr).toContain('Chromium is not installed')
    expect(existsSync(noChromium.pnpmLog)).toBe(false)
    const noWebkit = runnable({ chromium: true, webkit: false })
    noWebkit.commit({ [SPEC]: 'y\n' })
    const b = noWebkit.gate()
    expect(b.status).toBe(1)
    expect(b.stderr).toContain('WebKit is not installed')
  })

  /** The `playwright test` command lines the gate ran, as the stand-in pnpm logged them. */
  const playwrightCalls = (log: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter((l) => l.startsWith('pnpm exec playwright test'))

  it('the real run (a lock that passes through): desktop for every spec, iphone, iphone-se and pixel for the rest', () => {
    const r = runnable({ chromium: true, webkit: true }, { passThrough: true })
    r.commit({
      'apps/web/src/a.ts': 'y\n', // shared code: the planned gate would add the smoke set; the fast gate inside the lock must not
      [SPEC]: 'y\n',
      'apps/web/test/cards/permission-sheet.spec.ts': 'y\n',
    })
    const p = r.gate()
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain('gate: passed')
    expect(readFileSync(r.lock, 'utf8')).toContain('lock: run gate') // the inner gate really ran inside the lock
    expect(p.stderr).toContain('tests (web browser specs, Chromium)')
    const files = 'test/cards/permission-sheet.spec.ts test/threads/x.spec.ts'
    expect(playwrightCalls(r.pnpmLog)).toEqual([
      `pnpm exec playwright test --project=desktop --forbid-only --workers=2 ${files}`,
      `pnpm exec playwright test --project=iphone --project=iphone-se --project=pixel --forbid-only --workers=2 ${files}`,
    ])
    // the plan said the same projects the run used (the same change, in a repo without the stand-in tools)
    const same = repo()
    same.commit({
      'apps/web/src/a.ts': 'y\n',
      [SPEC]: 'y\n',
      'apps/web/test/cards/permission-sheet.spec.ts': 'y\n',
    })
    expect(same.plan('--fast').projects).toEqual([
      'test/cards/permission-sheet.spec.ts -> desktop iphone iphone-se pixel',
      'test/threads/x.spec.ts -> desktop iphone pixel',
    ])
  })

  it('without the permission sheet there is no iphone-se', () => {
    const r = runnable({ chromium: true, webkit: true }, { passThrough: true })
    r.commit({ [SPEC]: 'y\n' })
    expect(r.gate().status).toBe(0)
    expect(playwrightCalls(r.pnpmLog)).toEqual([
      'pnpm exec playwright test --project=desktop --forbid-only --workers=2 test/threads/x.spec.ts',
      'pnpm exec playwright test --project=iphone --project=pixel --forbid-only --workers=2 test/threads/x.spec.ts',
    ])
  })

  it('a failing pixel run fails the outer gate, which never says passed', () => {
    const pnpm = '#!/bin/sh\necho "pnpm $*" >> "$0.log"\ncase "$*" in *--project=pixel*) exit 1 ;; esac\nexit 0\n'
    const r = runnable({ chromium: true, webkit: true }, { passThrough: true, pnpm })
    r.commit({ [SPEC]: 'y\n' })
    const p = r.gate()
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('REFUSED')
    expect(p.stderr).not.toContain('gate: passed')
    expect(playwrightCalls(r.pnpmLog)).toHaveLength(2) // the pixel run was reached, and failed
  })

  it('the run steps name the projects: Chromium step desktop, the own specs iphone, pixel and iphone-se', () => {
    const src = readFileSync(join(here, 'gate.sh'), 'utf8')
    expect(src).toContain('web_specs_run "$WEB_LIMIT" desktop --')
    expect(src).toContain('web_specs_run "$WEB_LIMIT" "${WK_PROJECTS[@]}" -- "${WEBKIT[@]}"')
    expect(readFileSync(join(here, 'gate/plan.sh'), 'utf8')).toContain('p="iphone iphone-se pixel"')
  })

  it("the project names and match rules the gate uses are the playwright config's: iphone-se's one spec", () => {
    const cfg = readFileSync(join(here, '../apps/web/playwright.config.ts'), 'utf8')
    for (const name of ['iphone', 'iphone-se', 'pixel', 'desktop']) expect(cfg).toContain(`name: '${name}'`)
    expect(cfg).toContain("testMatch: '**/cards/permission-sheet.spec.ts'") // iphone-se takes only this one
  })
})
