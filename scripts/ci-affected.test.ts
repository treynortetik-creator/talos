// scripts/ci-affected.sh: which of the six CI jobs a change can affect, and which commit it is compared with. Two layers:
//   `jobs <base> <head>`  pure git, one throwaway repo: every path class, the unknown path, renames, deletes, odd names
//   `plan <repo> <head>`  per job, the base is the last commit where THAT job passed (a fake `gh` answers the statuses)
// and, at the end, scripts/ci-local.sh itself with stub jobs: what it runs, what it posts for a job it skips, and that the
// verdict reader accepts that post. Nothing here touches a real repository, runner, cache or simulator.
// One check reads the install and kit tests for what they import, so the gate runs this file when one changes (scripts/gate.sh,
// guards_reading):
// gate-reads: scripts/root-install*.test.ts scripts/kit-tests.test.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const affected = join(here, 'ci-affected.sh')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
const ALL = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
// check, mod and image are cheap and not named by any path rule, so they always run.
const BASE_JOBS = ['check', 'mod', 'image']
const only = (...extra: string[]) => ALL.filter((j) => [...BASE_JOBS, ...extra].includes(j))

function work() {
  const T = tmp('cia-')
  const dir = join(T, 'repo')
  mkdirSync(dir)
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()
  git('init', '-q', '-b', 'main')
  const put = (files: Record<string, string | null>) => {
    for (const [p, c] of Object.entries(files)) {
      if (c === null) rmSync(join(dir, p))
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true })
        writeFileSync(join(dir, p), c)
      }
    }
    git('add', '-A')
  }
  const commit = (files: Record<string, string | null>, msg = 'c') => {
    put(files)
    git('commit', '-q', '--allow-empty', '-m', msg)
    return git('rev-parse', 'HEAD')
  }
  return { T, dir, git, put, commit }
}
const jobs = (dir: string, base: string, head: string) => {
  const r = spawnSync('bash', [affected, 'jobs', base, head], { cwd: dir, encoding: 'utf8', env: cleanEnv() })
  return { code: r.status, out: r.stdout.trim() ? r.stdout.trim().split(/\s+/) : [], err: r.stderr }
}

describe('ci-affected.sh jobs: a path class decides the jobs', () => {
  // Every file of the base commit exists, so a change is a change and a deletion is a deletion.
  const seed = {
    'apps/web/src/a.ts': 'a',
    'apps/bridge/src/a.ts': 'a',
    'apps/relay/src/a.ts': 'a',
    'apps/desktop/Sources/a.swift': 'a',
    'apps/mobile/ios/a.swift': 'a',
    'packages/protocol/src/a.ts': 'a',
    'packages/testkit/src/a.ts': 'a',
    'docs/a.md': 'a',
    'CHANGELOG.md': 'a',
    'scripts/a.sh': 'a',
    'pnpm-lock.yaml': 'a',
    'package.json': '{}',
    'biome.json': '{}',
    'tsconfig.base.json': '{}',
    'README.md': 'a',
  }
  const change = (paths: string[]) => {
    const w = work()
    const base = w.commit(seed, 'base')
    const head = w.commit(Object.fromEntries(paths.map((p) => [p, `changed ${p}`])), 'change')
    return jobs(w.dir, base, head)
  }

  it('apps/web, docs or CHANGELOG: check and browser; desktop and mobile are skipped', () => {
    for (const p of [
      'apps/web/src/a.ts',
      'apps/web/src/new/deep/file.tsx',
      'docs/a.md',
      'docs/new/x.md',
      'CHANGELOG.md',
    ]) {
      expect(change([p]).out, p).toEqual(only('browser'))
    }
  })

  it('apps/bridge or apps/relay: check and the browser job that uses them; desktop and mobile are skipped', () => {
    for (const p of ['apps/bridge/src/a.ts', 'apps/relay/src/a.ts', 'apps/relay/migrations/0001.sql']) {
      expect(change([p]).out, p).toEqual(only('browser'))
    }
  })

  it('only apps/desktop: desktop and check, and no browser', () => {
    expect(change(['apps/desktop/Sources/a.swift']).out).toEqual(only('desktop'))
  })

  it('only apps/mobile: mobile and check, and no browser', () => {
    expect(change(['apps/mobile/ios/a.swift', 'apps/mobile/new.ts']).out).toEqual(only('mobile'))
  })

  it('protocol, testkit, scripts, the lockfile and root config run everything', () => {
    for (const p of [
      'packages/protocol/src/a.ts',
      'packages/testkit/src/a.ts',
      'scripts/a.sh',
      'scripts/ci-local.sh',
      'pnpm-lock.yaml',
      'package.json',
      'biome.json',
      'tsconfig.base.json',
      '.github/workflows/ci-runner.yml',
    ]) {
      expect(change([p]).out, p).toEqual(ALL)
    }
  })

  it('an unknown path runs everything: a new top-level folder, a file in an unlisted package, a root file', () => {
    for (const p of [
      'brand-new-folder/file.txt',
      'packages/integrations/src/a.ts',
      'plugins/talos-app-mod/a.json',
      'e2e/tests/a.spec.ts',
      'README.md',
      'AGENTS.md',
      '.env.example',
    ]) {
      expect(change([p]).out, p).toEqual(ALL)
    }
  })

  it('a name that only starts like a known path is unknown: apps/web-extra, docs-private, CHANGELOG.md.bak, apps/desktop2', () => {
    for (const p of [
      'apps/web-extra/a.ts',
      'apps/webby.ts',
      'docs-private/a.md',
      'CHANGELOG.md.bak',
      'apps/desktop2/a.swift',
      'apps/mobile.ts',
    ]) {
      expect(change([p]).out, p).toEqual(ALL)
    }
  })

  it('one unknown path among known ones runs everything', () => {
    expect(change(['apps/web/src/a.ts', 'docs/a.md', 'somewhere/else.txt']).out).toEqual(ALL)
  })

  it('a change to web and to desktop together is the union of both', () => {
    expect(change(['apps/web/src/a.ts', 'apps/desktop/Sources/a.swift']).out).toEqual(only('browser', 'desktop'))
    expect(change(['apps/mobile/ios/a.swift', 'docs/a.md']).out).toEqual(only('browser', 'mobile'))
    expect(change(['apps/desktop/Sources/a.swift', 'apps/mobile/ios/a.swift']).out).toEqual(only('desktop', 'mobile'))
    expect(
      change(['apps/web/src/a.ts', 'apps/bridge/src/a.ts', 'apps/desktop/Sources/a.swift', 'apps/mobile/ios/a.swift'])
        .out,
    ).toEqual(ALL)
  })

  it('a rename counts both paths: out of a class, into one, and between two', () => {
    const w = work()
    const base = w.commit(seed, 'base')
    // desktop file moved into web: the desktop side changed too
    w.git('mv', 'apps/desktop/Sources/a.swift', 'apps/web/src/moved.swift')
    w.git('commit', '-qm', 'move')
    expect(jobs(w.dir, base, w.git('rev-parse', 'HEAD')).out).toEqual(only('browser', 'desktop'))
    // web file moved to protocol: the unknown/everything side counts
    const w2 = work()
    const base2 = w2.commit(seed, 'base')
    w2.git('mv', 'apps/web/src/a.ts', 'packages/protocol/src/b.ts')
    w2.git('commit', '-qm', 'move')
    expect(jobs(w2.dir, base2, w2.git('rev-parse', 'HEAD')).out).toEqual(ALL)
    // web file moved into mobile, and mobile into web: the class it left counts as much as the one it entered
    const w4 = work()
    const base4 = w4.commit(seed, 'base')
    w4.git('mv', 'apps/web/src/a.ts', 'apps/mobile/ios/from-web.ts')
    w4.git('commit', '-qm', 'move')
    expect(jobs(w4.dir, base4, w4.git('rev-parse', 'HEAD')).out).toEqual(only('browser', 'mobile'))
    const w5 = work()
    const base5 = w5.commit(seed, 'base')
    w5.git('mv', 'apps/mobile/ios/a.swift', 'docs/from-mobile.swift')
    w5.git('commit', '-qm', 'move')
    expect(jobs(w5.dir, base5, w5.git('rev-parse', 'HEAD')).out).toEqual(only('browser', 'mobile'))
    // a pure rename inside mobile, with the same content
    const w3 = work()
    const base3 = w3.commit(seed, 'base')
    w3.git('mv', 'apps/mobile/ios/a.swift', 'apps/mobile/ios/b.swift')
    w3.git('commit', '-qm', 'move')
    expect(jobs(w3.dir, base3, w3.git('rev-parse', 'HEAD')).out).toEqual(only('mobile'))
  })

  it('a deleted file counts as a change in its class', () => {
    for (const [p, expected] of [
      ['apps/mobile/ios/a.swift', only('mobile')],
      ['apps/desktop/Sources/a.swift', only('desktop')],
      ['apps/web/src/a.ts', only('browser')],
      ['packages/protocol/src/a.ts', ALL],
    ] as const) {
      const w = work()
      const base = w.commit(seed, 'base')
      const head = w.commit({ [p]: null }, 'delete')
      expect(jobs(w.dir, base, head).out, p).toEqual(expected)
    }
  })

  it('odd file names: spaces, a newline, a quote and non-ASCII are read whole, never mistaken for another path', () => {
    for (const [p, expected] of [
      ['apps/web/src/with space.ts', only('browser')],
      ['apps/web/src/line\nbreak.ts', only('browser')],
      ['apps/web/src/quote"d.ts', only('browser')],
      ['apps/desktop/Sources/café.swift', only('desktop')],
      ['zzz\napps/web/src/a.ts', ALL], // one unknown name that merely holds a known path on its second line
    ] as const) {
      expect(change([p]).out, JSON.stringify(p)).toEqual(expected)
    }
  })

  it('no change at all still runs check (and the always-on jobs)', () => {
    const w = work()
    const base = w.commit(seed, 'base')
    const head = w.commit({}, 'empty')
    expect(jobs(w.dir, base, head).out).toEqual(only())
  })

  it('a base git cannot find is an error with no job list, never a skip', () => {
    const w = work()
    w.commit(seed, 'base')
    const r = jobs(w.dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'HEAD')
    expect(r.code).toBe(2)
    expect(r.out).toEqual([])
    expect(jobs(w.dir, '', 'HEAD').code).toBe(2)
  })

  it('desktop is decided by the desktop gate, not by the path table: the gate can add or drop it for a change outside apps/desktop', () => {
    // The gate is the one list of desktop paths. Run ci-affected.sh beside a gate of our own and change only apps/web: the
    // table alone would never run desktop for that, so desktop shows up only if the gate said "run" (0) or failed (2).
    const gateDir = tmp('cia-gate-')
    writeFileSync(join(gateDir, 'ci-affected.sh'), readFileSync(affected))
    const gate = join(gateDir, 'ci-desktop-gate.sh')
    const w = work()
    const base = w.commit(seed, 'base')
    const head = w.commit({ 'apps/web/src/a.ts': 'changed' }, 'web only')
    for (const [rc, expected] of [
      [0, only('browser', 'desktop')], // the gate says a watched path changed: run
      [1, only('browser')], // the gate's one skip
      [2, only('browser', 'desktop')], // the gate errored: never a skip
    ] as const) {
      writeFileSync(gate, `#!/usr/bin/env bash\nexit ${rc}\n`)
      const r = spawnSync('bash', [join(gateDir, 'ci-affected.sh'), 'jobs', base, head], {
        cwd: w.dir,
        encoding: 'utf8',
        env: cleanEnv(),
      })
      expect(r.stdout.trim().split(/\s+/), `gate exit ${rc}`).toEqual(expected)
    }
  })
})

describe('scripts/ci-desktop-gate.sh itself', () => {
  // job_desktop lives in scripts/ci-local/jobs-swift.sh, which ci-local.sh sources: a change there is a change to the desktop
  // job's CI, as a change to ci-local.sh is, so the desktop job runs
  it('a change to ci-local.sh or to the parts it sources (scripts/ci-local/) runs desktop; a docs change alone does not', () => {
    const gate = join(here, 'ci-desktop-gate.sh')
    const w = work()
    const base = w.commit(
      { 'apps/web/src/a.ts': 'a', 'scripts/ci-local.sh': 'a', 'scripts/ci-local/jobs-swift.sh': 'a', 'docs/x.md': 'a' },
      'base',
    )
    const rc = (head: string) => spawnSync('bash', [gate, base, head], { cwd: w.dir, env: cleanEnv() }).status
    for (const f of ['scripts/ci-local.sh', 'scripts/ci-local/jobs-swift.sh', 'scripts/ci-local/locks.sh']) {
      w.git('reset', '-q', '--hard', base)
      expect(rc(w.commit({ [f]: 'changed' }, f)), f).toBe(0)
    }
    w.git('reset', '-q', '--hard', base)
    expect(rc(w.commit({ 'docs/x.md': 'changed' }, 'docs'))).toBe(1)
  })
})

// ---------- the install and kit tests: only when what they run changed ----------
const kit = (dir: string, base: string, head: string) =>
  spawnSync('bash', [affected, 'kit', base, head], { cwd: dir, encoding: 'utf8', env: cleanEnv() }).status
// What root-install.test.ts and kit-tests.test.ts run: install.sh, kit/, the plugin, the bridge CLI and its packages, the
// lockfile and root config, and the two tests with the helpers they import.
const KIT_INPUTS = [
  'install.sh',
  'kit/scripts/test-hooks.sh',
  'kit/install.sh',
  'plugins/talos-app-mod/plugin.json',
  'apps/bridge/src/cli.ts',
  'packages/protocol/src/models.ts',
  'pnpm-lock.yaml',
  'package.json',
  'vitest.config.ts',
  'scripts/root-install.test.ts',
  'scripts/root-install-flags.test.ts',
  'scripts/root-install-harness.ts',
  'scripts/root-install-v1-gate.test.ts',
  'scripts/v1-agent-fixture.sh',
  'scripts/kit-tests.test.ts',
  'scripts/kit-run.ts',
  'scripts/size-report.ts',
  'brand-new-folder/file.txt',
]
const NOT_KIT_INPUTS = [
  'apps/web/src/a.ts',
  'apps/relay/src/a.ts',
  'apps/mobile/ios/a.swift',
  'apps/desktop/Sources/a.swift',
  'docs/a.md',
  'CHANGELOG.md',
  'scripts/ci-local.sh',
  'scripts/kit-run.test.ts',
]

describe('ci-affected.sh kit: the install and kit tests run only when what they run changed', () => {
  it('each input alone runs them (exit 0), and so does a path nobody listed', () => {
    for (const p of KIT_INPUTS) {
      const w = work()
      const base = w.commit({ 'apps/web/src/a.ts': 'a' }, 'base')
      expect(kit(w.dir, base, w.commit({ [p]: 'changed' })), p).toBe(0)
    }
  })

  it('a change of only other paths skips them (exit 1); one input among them runs them', () => {
    const w = work()
    const base = w.commit({ 'apps/web/src/a.ts': 'a' }, 'base')
    const head = w.commit(Object.fromEntries(NOT_KIT_INPUTS.map((p) => [p, `changed ${p}`])), 'no inputs')
    expect(kit(w.dir, base, head)).toBe(1)
    expect(kit(w.dir, base, w.commit({ 'kit/VERSION': 'x' }, 'one input'))).toBe(0)
  })

  it('a deleted input and a rename out of kit/ count as changes', () => {
    const w = work()
    const base = w.commit({ 'kit/a.sh': 'a', 'docs/keep.md': 'a' }, 'base')
    w.git('mv', 'kit/a.sh', 'docs/a.sh')
    w.git('commit', '-qm', 'move')
    expect(kit(w.dir, base, w.git('rev-parse', 'HEAD'))).toBe(0)
    const w2 = work()
    const base2 = w2.commit({ 'install.sh': 'a' }, 'base')
    expect(kit(w2.dir, base2, w2.commit({ 'install.sh': null }, 'delete'))).toBe(0)
  })

  it('every file the install and kit tests import, however deep, is one of their inputs', () => {
    // A helper they start importing must run them when it changes: this fails until ci-affected.sh lists it.
    const tests = readdirSync(here).filter((f) => /^(root-install.*|kit-tests)\.test\.ts$/.test(f))
    expect(tests).toContain('root-install.test.ts')
    expect(tests).toContain('kit-tests.test.ts')
    const seen = new Set<string>()
    const walk = (f: string) => {
      if (seen.has(f)) return
      seen.add(f)
      for (const m of readFileSync(join(here, f), 'utf8').matchAll(/(?:from|import)\s*\(?'\.\/([^']+)'/g))
        walk(m[1] as string)
    }
    for (const t of tests) walk(t)
    expect(seen.size).toBeGreaterThan(tests.length) // they do import helpers
    for (const f of seen) {
      const w = work()
      const base = w.commit({ 'apps/web/src/a.ts': 'a' }, 'base')
      expect(kit(w.dir, base, w.commit({ [`scripts/${f}`]: 'changed' })), f).toBe(0)
    }
  })

  it('no kit script reads the paths that skip them (docs, scripts, the web, relay, mobile or desktop app)', () => {
    const r = spawnSync(
      'git',
      ['grep', '-nE', 'KIT"?/\\.\\./(docs|scripts|apps/(web|relay|mobile|desktop))', '--', 'kit'],
      {
        cwd: join(here, '..'),
        encoding: 'utf8',
      },
    )
    expect(r.status, r.stdout).toBe(1) // git grep: 1 is no match
  })

  it('a base git cannot find is an error (exit 2), never a skip', () => {
    const w = work()
    w.commit({ 'apps/web/src/a.ts': 'a' }, 'base')
    expect(kit(w.dir, 'f'.repeat(40), 'HEAD')).toBe(2)
    expect(kit(w.dir, '', 'HEAD')).toBe(2)
  })
})

// ---------- the base: the last green commit ----------
const ok = (c: string) => `local-ci/${c}\tsuccess\tpassed on ci-runner in 40s`
const skippedOk = (c: string) => `local-ci/${c}\tsuccess\tskipped: no affected files`
const greenRows = ALL.map(ok)
const fakeGh = (bin: string) => {
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/bash
case "$1" in
  repo) exit 1 ;;
  api)
    shift
    if [ "$1" = -X ]; then echo "$*" >> "$GH_LOG"; exit 0; fi
    pg=0 p=""
    for a in "$@"; do case "$a" in --paginate) pg=1 ;; repos/*) p="$a" ;; esac; done
    sha="\${p#*commits/}"; sha="\${sha%%/*}"
    [ "\${GH_FAIL_SHA:-}" != "$sha" ] || exit 1
    kind=status; case "$p" in *"/$sha/statuses"*) kind=statuses ;; esac
    echo "GET $sha $kind" >> "$GH_READS"
    # like GitHub: a page holds per_page rows (30 when not asked); --paginate follows every page
    n=30; case "$p" in *per_page=*) n="\${p#*per_page=}"; n="\${n%%&*}" ;; esac
    if [ "$pg" = 1 ]; then cat "$GH_STATUS_DIR/$sha" 2>/dev/null; else head -n "$n" "$GH_STATUS_DIR/$sha" 2>/dev/null; fi
    exit 0 ;;
esac
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
}

function world() {
  const w = work()
  const origin = join(w.T, 'origin.git')
  const bin = join(w.T, 'bin')
  const statusDir = join(w.T, 'statuses')
  mkdirSync(bin)
  mkdirSync(statusDir)
  fakeGh(bin)
  const status = (sha: string, rows: string[]) => writeFileSync(join(statusDir, sha), `${rows.join('\n')}\n`)
  const env = {
    ...cleanEnv(),
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: join(w.T, 'gh.log'),
    GH_READS: join(w.T, 'gh.reads'),
    GH_STATUS_DIR: statusDir,
  }
  // origin/main is whatever was pushed: call publish() after the commits that main has
  const publish = () => {
    rmSync(origin, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', '--bare', w.dir, origin])
    if (w.git('remote').split('\n').includes('origin')) w.git('remote', 'remove', 'origin')
    w.git('remote', 'add', 'origin', origin)
    w.git('fetch', '-q', 'origin')
  }
  const plan = (head: string, extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [affected, 'plan', 'owner/repo', head], {
      cwd: w.dir,
      encoding: 'utf8',
      env: { ...env, ...extra },
    })
    const [line = '', ...rest] = r.stdout.split('\n')
    return {
      code: r.status,
      jobs: line.trim().split(/\s+/).filter(Boolean),
      why: rest.join('\n').trim(),
      // lines 4 on: "skip <job> <sha of the commit where that job last passed>", and "base <job> <sha>" for every job with one
      skips: rest.filter((l) => l.startsWith('skip ')).map((l) => l.slice(5)),
      bases: rest.filter((l) => l.startsWith('base ')).map((l) => l.slice(5)),
      err: r.stderr,
    }
  }
  return { ...w, status, publish, plan, env }
}
const seedFiles = {
  'apps/web/src/a.ts': 'a',
  'apps/desktop/Sources/a.swift': 'a',
  'apps/mobile/ios/a.swift': 'a',
  'apps/bridge/src/a.ts': 'a',
}
const web = (n = 1) => ({ 'apps/web/src/a.ts': `web ${n}` })

describe("ci-affected.sh plan: each job is compared with the last commit where that job passed, whatever main's colour", () => {
  it('a green parent is the base: a web-only change skips desktop and mobile', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const head = w.commit(web(), 'web')
    w.publish()
    const r = w.plan(head)
    expect(r.jobs).toEqual(only('browser'))
    expect(r.skips).toEqual([`desktop ${g}`, `mobile ${g}`])
    // every job's base is listed too (report-ci/fast runs the unit tests the change since check's base can reach)
    expect(r.bases).toEqual(ALL.map((j) => `${j} ${g}`))
  })

  it('inner commits that never got a status are passed over, and what they changed counts', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    w.commit({ 'apps/desktop/Sources/a.swift': 'inner desktop change' }, 'inner 1 (no status)')
    w.commit({ 'apps/mobile/ios/a.swift': 'inner mobile change' }, 'inner 2 (no status)')
    const head = w.commit(web(), 'tip: web only')
    w.publish()
    // the tip alone touches only web; the push as a whole touched desktop and mobile too
    expect(w.plan(head).jobs).toEqual(only('browser', 'desktop', 'mobile'))
  })

  it('a job that failed on the nearest commit runs; a job that passed there is compared with it, though main is red', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const red = w.commit({ 'apps/desktop/Sources/a.swift': 'broken' }, 'red')
    w.status(
      red,
      greenRows.map((l) => (l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tfailure\tfailed on ci-runner' : l)),
    )
    const head = w.commit(web(), 'web only, on top of a red base')
    w.publish()
    const r = w.plan(head)
    // desktop failed at red, so it runs; mobile passed at red and nothing it reads changed since, so it skips
    expect(r.jobs).toEqual(only('browser', 'desktop'))
    expect(r.skips).toEqual([`mobile ${red}`])
  })

  it("the nearest commit with a result for a job decides that job: a red check there does not stop the others' skips", () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const red = w.commit(web(2), 'red')
    w.status(
      red,
      greenRows.map((l) => (l.startsWith('local-ci/check\t') ? 'local-ci/check\tfailure\tx' : l)),
    )
    w.commit({}, 'untested')
    const head = w.commit(web(3), 'tip')
    w.publish()
    const r = w.plan(head)
    expect(r.jobs).toEqual(only('browser'))
    expect(r.skips).toEqual([`desktop ${red}`, `mobile ${red}`])
  })

  it('only a final pass is a base: a pending, failed or errored job runs; a skipped or missing one is walked past', () => {
    const at = (job: string, row: string) => greenRows.map((l) => (l.startsWith(`local-ci/${job}\t`) ? row : l))
    const cases: Record<string, { rows: string[]; jobs: string[] }> = {
      pending: {
        rows: at('desktop', 'local-ci/desktop\tpending\trunning on ci-runner'),
        jobs: only('browser', 'desktop'),
      },
      failure: { rows: at('mobile', 'local-ci/mobile\tfailure\tfailed on ci-runner'), jobs: only('browser', 'mobile') },
      error: { rows: at('desktop', 'local-ci/desktop\terror\tcancelled'), jobs: only('browser', 'desktop') },
      // no older commit to walk to, so a job with no result here has no base
      partial: { rows: greenRows.slice(0, 3), jobs: ALL },
      'old skip text': {
        rows: at('desktop', 'local-ci/desktop\tsuccess\tskipped (no desktop changes)'),
        jobs: only('browser', 'desktop'),
      },
    }
    for (const [name, { rows, jobs }] of Object.entries(cases)) {
      const w = world()
      const g = w.commit(seedFiles, 'base')
      w.status(g, rows)
      const head = w.commit(web(), 'web')
      w.publish()
      expect(w.plan(head).jobs, name).toEqual(jobs)
    }
  })

  it('"passed on retry" is a pass: it is a base like any other', () => {
    const w = world()
    const g = w.commit(seedFiles, 'base')
    w.status(
      g,
      greenRows.map((l) =>
        l.startsWith('local-ci/mobile\t') ? `${l}, passed on retry (1 flaky test, see flakes.tsv)` : l,
      ),
    )
    const head = w.commit(web(), 'web')
    w.publish()
    expect(w.plan(head).skips).toEqual([`desktop ${g}`, `mobile ${g}`])
  })

  it('a skipped job is walked past to the commit where it last passed, and what changed since counts: a chain of web changes', () => {
    const w = world()
    const g = w.commit(seedFiles, 'real run')
    w.status(g, greenRows)
    const s = w.commit(web(1), 'web, desktop and mobile skipped')
    w.status(
      s,
      ALL.map((j) => (j === 'desktop' || j === 'mobile' ? skippedOk(j) : ok(j))),
    )
    const head = w.commit(web(2), 'web again')
    w.publish()
    const r = w.plan(head)
    expect(r.jobs).toEqual(only('browser'))
    expect(r.skips).toEqual([`desktop ${g}`, `mobile ${g}`]) // g, where they last ran and passed, not s
    // and a skip in the new words is walked past the same way
    const w2 = world()
    const g2 = w2.commit(seedFiles, 'real run')
    w2.status(g2, greenRows)
    const s2 = w2.commit(web(1), 'skipped in the new words')
    w2.status(
      s2,
      ALL.map((j) =>
        j === 'mobile' ? `local-ci/mobile\tsuccess\tskipped: no mobile inputs changed since ${g2.slice(0, 7)}` : ok(j),
      ),
    )
    const head2 = w2.commit(web(2), 'web again')
    w2.publish()
    // mobile is compared with g2 (s2 only skipped it), desktop with s2 (where it passed): two bases in one plan
    expect(w2.plan(head2).skips).toEqual([`desktop ${s2}`, `mobile ${g2}`])
  })

  it('jobs with different bases are each diffed from their own: a change behind one base and not the other', () => {
    const w = world()
    const g = w.commit(seedFiles, 'all ran')
    w.status(g, greenRows)
    w.commit({ 'apps/desktop/Sources/a.swift': 'desktop change' }, 'inner, never tested')
    const x = w.commit(web(1), 'desktop skipped here (wrongly, say), browser passed')
    w.status(
      x,
      ALL.map((j) =>
        j === 'desktop' ? 'local-ci/desktop\tsuccess\tskipped: no desktop inputs changed since 0000000' : ok(j),
      ),
    )
    const head = w.commit(web(2), 'web again')
    w.publish()
    const r = w.plan(head)
    // desktop's base is g, and the desktop change after g is in its diff, so it runs; mobile's base is x and skips
    expect(r.jobs).toEqual(only('browser', 'desktop'))
    expect(r.skips).toEqual([`mobile ${x}`])
  })

  it('a failure row is read however many statuses the commit has: a long list does not lose it to a closed pipe', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const red = w.commit({}, 'red, then a very long list of other contexts')
    const filler = Array.from({ length: 2500 }, (_, i) => `ci/other-${i}\tsuccess\t${'x'.repeat(80)}`)
    w.status(red, ['local-ci/mobile\tfailure\tfailed on ci-runner', ...greenRows.slice(0, 5), ...filler])
    const head = w.commit(web(), 'web')
    w.publish()
    expect(w.plan(head).jobs).toEqual(only('browser', 'mobile'))
  })

  it('line 2 says why a job has no base: failed or pending where, or none in reach', () => {
    const w = world()
    const g = w.commit(seedFiles, 'base')
    w.status(
      g,
      ALL.map((j) =>
        j === 'desktop' ? 'local-ci/desktop\tfailure\tx' : j === 'mobile' ? 'local-ci/mobile\tpending\trunning' : ok(j),
      ),
    )
    const head = w.commit(web(), 'web')
    w.publish()
    const why = w.plan(head).why
    expect(why).toContain(`desktop: failure at ${g.slice(0, 7)}`)
    expect(why).toContain(`mobile: pending at ${g.slice(0, 7)}`)
  })

  it('no status anywhere in reach and a missing repo are both "run everything"', () => {
    const w = world()
    w.commit(seedFiles, 'a')
    w.commit({}, 'b')
    const head = w.commit(web(), 'c')
    w.publish()
    expect(w.plan(head).jobs).toEqual(ALL)
    const none = spawnSync('bash', [affected, 'plan', '', head], { cwd: w.dir, encoding: 'utf8', env: w.env })
    expect(none.stdout.split('\n')[0]?.trim().split(/\s+/)).toEqual(ALL)
  })

  it('a status read that fails is not "no status": nothing is skipped, even with a green commit further back', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const mid = w.commit({}, 'its statuses cannot be read')
    const head = w.commit(web(), 'web')
    w.publish()
    expect(w.plan(head).jobs).toEqual(only('browser')) // control: with mid readable (and untested) the walk reaches g
    expect(w.plan(head, { GH_FAIL_SHA: mid }).jobs).toEqual(ALL) // the nearest commit fails; g must not be taken instead
    expect(w.plan(head, { GH_FAIL_SHA: head }).jobs).toEqual(ALL) // the head's own statuses
  })

  it('a base that is the root commit, or a head with no parent, runs everything', () => {
    const w = world()
    const head = w.commit(seedFiles, 'root')
    w.publish()
    expect(w.plan(head).jobs).toEqual(ALL)
  })

  it('a PR is compared with the last green commit of main before it was cut, not with newer main commits it does not contain', () => {
    const w = world()
    const m1 = w.commit(seedFiles, 'main 1')
    w.status(m1, greenRows)
    w.git('checkout', '-q', '-b', 'pr')
    const head = w.commit(web(1), 'pr: web only')
    w.git('checkout', '-q', 'main')
    const m2 = w.commit({ 'apps/desktop/Sources/a.swift': 'later main change' }, 'main 2 (red, not in the PR)')
    w.status(
      m2,
      greenRows.map((l) => (l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tfailure\tx' : l)),
    )
    w.publish()
    const r = w.plan(head)
    expect(r.jobs).toEqual(only('browser'))
    expect(r.why).toContain(m1.slice(0, 7))
  })

  it('a PR cut from a main commit with no status walks back to the green one, and counts what lies between', () => {
    const w = world()
    const m1 = w.commit(seedFiles, 'main 1')
    w.status(m1, greenRows)
    w.commit({ 'apps/mobile/ios/a.swift': 'main 2 untested' }, 'main 2 (no status)')
    w.git('checkout', '-q', '-b', 'pr')
    const head = w.commit(web(), 'pr')
    w.git('checkout', '-q', 'main')
    w.publish()
    expect(w.plan(head).jobs).toEqual(only('browser', 'mobile'))
  })

  it('a commit that already has a local-ci status is a rerun: it runs everything, even where its change would skip jobs', () => {
    const w = world()
    const m1 = w.commit(seedFiles, 'main 1')
    w.status(m1, greenRows)
    const m2 = w.commit(web(), 'main 2')
    w.publish()
    expect(w.plan(m2).jobs).toEqual(only('browser')) // control: no status of its own yet, so desktop and mobile skip
    // desktop failed on m2 (a skippable job: the web change cannot reach it); the base has since gone green
    w.status(
      m2,
      greenRows.map((l) => (l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tfailure\tx' : l)),
    )
    const r = w.plan(m2)
    expect(r.jobs).toEqual(ALL)
    expect(r.why).toContain('already has')
    // any one status counts, a pending one too
    w.status(m2, ['local-ci/check\tpending\trunning on ci-runner'])
    expect(w.plan(m2).jobs).toEqual(ALL)
  })

  // docs/CI-MACHINES.md, "The rerun rule and this attempt": the statuses this workflow attempt posted itself (another machine
  // of the same attempt can post before Lemnos plans) are not an earlier run; every other run's or attempt's are.
  describe("the rerun rule leaves out this attempt's own statuses", () => {
    const RUN = 'https://github.com/owner/repo/actions/runs/7'
    const A2 = `${RUN}/attempts/2#`
    const setup = () => {
      const w = world()
      const m1 = w.commit(seedFiles, 'main 1')
      w.status(m1, greenRows)
      const m2 = w.commit(web(), 'main 2')
      w.publish()
      return { w, m2 }
    }
    const skipsNormally = only('browser') // a web-only change on a green base: desktop and mobile skip

    it("1. this attempt's part, report-only and local-ci statuses are not an earlier run", () => {
      const { w, m2 } = setup()
      w.status(m2, [
        `ci-part/vitest\tpending\trunning on delphi\t${A2}delphi`,
        `ci-part/bridge-shard-2\tfailure\tfailed on cyclops\t${A2}cyclops`,
        `report-ci/linux\tsuccess\tpassed on hestia in 9s\t${A2}hestia`,
        `local-ci/image\tpending\trunning on titan\t${A2}titan`,
      ])
      const r = w.plan(m2, { CI_ATTEMPT_URL: A2 })
      expect(r.jobs).toEqual(skipsNormally)
      expect(r.why).not.toContain('already has')
    })

    it("2. a part's or report-only status of an earlier attempt or another run is an earlier run", () => {
      const { w, m2 } = setup()
      for (const [ctx, url] of [
        ['ci-part/vitest', `${RUN}/attempts/1#delphi`],
        ['ci-part/bridge-shard-1', `${RUN}/attempts/20#delphi`], // attempts/2# must not take attempts/20#
        ['report-ci/linux', 'https://github.com/owner/repo/actions/runs/6/attempts/1#hestia'],
        ['report-ci/fast', RUN], // a run link, with no attempt: never this attempt's
        ['local-ci/check', ''],
      ]) {
        w.status(m2, [`${ctx}\tfailure\tx\t${url}`])
        const r = w.plan(m2, { CI_ATTEMPT_URL: A2 })
        expect(r.jobs, `${ctx} ${url}`).toEqual(ALL)
        expect(r.why, `${ctx} ${url}`).toContain('already has')
      }
    })

    it('3. "Re-run failed jobs": attempt 2 of the same run, with attempt 1\'s statuses there, runs everything', () => {
      const { w, m2 } = setup()
      // attempt 1 with the split on (attempt links), and attempt 2's own part already pending: still a rerun
      w.status(m2, [
        `ci-part/vitest\tpending\trunning on delphi\t${A2}delphi`,
        ...ALL.map((j) => `local-ci/${j}\t${j === 'desktop' ? 'failure' : 'success'}\tx\t${RUN}/attempts/1#lemnos`),
      ])
      expect(w.plan(m2, { CI_ATTEMPT_URL: A2 }).jobs).toEqual(ALL)
      // only attempt 1's part answered (Lemnos's statuses not in yet when it was re-run): a rerun too
      w.status(m2, [`ci-part/vitest\tfailure\tx\t${RUN}/attempts/1#delphi`, `ci-part/vitest\tpending\tx\t${A2}delphi`])
      expect(w.plan(m2, { CI_ATTEMPT_URL: A2 }).jobs).toEqual(ALL)
      // every switch off: attempt 1's statuses link to the run and the attempt link is not set; a rerun, as today
      w.status(
        m2,
        ALL.map((j) => `local-ci/${j}\tsuccess\tx\t${RUN}`),
      )
      expect(w.plan(m2).jobs).toEqual(ALL)
    })

    it("3b. the full status list is read, not the combined status: this attempt's newer status does not hide an earlier one", () => {
      const { w, m2 } = setup()
      // the same context twice: attempt 2's (newest first, as GitHub lists them) over attempt 1's
      w.status(m2, [
        `local-ci/image\tpending\trunning on titan\t${A2}titan`,
        `local-ci/image\tfailure\tx\t${RUN}/attempts/1#titan`,
      ])
      expect(w.plan(m2, { CI_ATTEMPT_URL: A2 }).jobs).toEqual(ALL)
      expect(readFileSync(w.env.GH_READS as string, 'utf8')).toContain(`GET ${m2} statuses`)
    })

    it('4. every switch off (no attempt link): exactly as before; no status is left out', () => {
      const { w, m2 } = setup()
      expect(w.plan(m2).jobs).toEqual(skipsNormally)
      w.status(m2, [`local-ci/check\tpending\trunning on ci-runner\t${RUN}`])
      expect(w.plan(m2).jobs).toEqual(ALL)
      w.status(m2, [`local-ci/check\tpending\trunning on ci-runner\t${A2}lemnos`])
      expect(w.plan(m2).jobs).toEqual(ALL) // without CI_ATTEMPT_URL nothing is this attempt's
    })
  })

  it('more than 30 statuses on a commit are all read: a red local-ci row past the first page is not hidden', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const red = w.commit({}, 'red behind 30 other contexts')
    const filler = Array.from({ length: 35 }, (_, i) => `ci/other-${i}\tsuccess\tfine`)
    w.status(red, [...filler, 'local-ci/mobile\tfailure\tfailed on ci-runner'])
    const head = w.commit(web(), 'web')
    w.publish()
    const r = w.plan(head)
    // mobile failed at red, so it runs. A 30-row read sees no mobile status there, walks on to g and skips it
    expect(r.jobs).toEqual(only('browser', 'mobile'))
  })

  it('it stops looking after a bounded number of commits and then runs everything', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    for (let i = 0; i < 40; i++) w.commit({}, `empty ${i}`)
    const head = w.commit(web(), 'tip')
    w.publish()
    expect(w.plan(head).jobs).toEqual(ALL)
    const reads = readFileSync(w.env.GH_READS as string, 'utf8')
      .trim()
      .split('\n').length
    expect(reads).toBeLessThanOrEqual(31) // 30 commits of the walk, and the head's own statuses before it
  })
})

describe('ci-affected.sh plan: line 3 says whether the install and kit tests run', () => {
  const line3 = (r: { why: string }) => r.why.split('\n')[1]
  it('a web-only change on a green base skips them; a kit change runs them', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const head = w.commit(web(), 'web')
    w.publish()
    expect(line3(w.plan(head))).toBe('kit-tests: skip')
    const w2 = world()
    const g2 = w2.commit(seedFiles, 'green')
    w2.status(g2, greenRows)
    const head2 = w2.commit({ 'kit/install.sh': 'changed' }, 'kit')
    w2.publish()
    expect(line3(w2.plan(head2))).toBe('kit-tests: run')
  })

  it("check's own pass is their base: another job's red there does not stop the skip", () => {
    const w = world()
    const g = w.commit(seedFiles, 'check passed, desktop failed')
    w.status(
      g,
      greenRows.map((l) => (l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tfailure\tx' : l)),
    )
    const head = w.commit(web(), 'web')
    w.publish()
    expect(line3(w.plan(head))).toBe('kit-tests: skip')
  })

  it("a check that failed on the nearest commit runs them, even for a web-only change: they are compared with check's own last pass", () => {
    const w = world()
    const g = w.commit(seedFiles, 'red')
    w.status(
      g,
      greenRows.map((l) => (l.startsWith('local-ci/check\t') ? 'local-ci/check\tfailure\tfailed on ci-runner' : l)),
    )
    const head = w.commit(web(), 'web')
    w.publish()
    expect(line3(w.plan(head))).toBe('kit-tests: run')
  })
})

// ---------- ci-local.sh with stub jobs ----------
describe('ci-local.sh: it runs the jobs the change can affect and answers honestly for the rest', () => {
  const stubs = ALL.map((j) => `job_${j}() { echo ${j} >> "$CALLS"; }`).join('\n')

  function run(opts: { affectedScript?: boolean } = {}) {
    const w = world()
    const g0 = w.commit(seedFiles, 'seed')
    const origin = join(w.T, 'origin.git')
    w.publish()
    const clone = join(w.T, 'clone')
    execFileSync('git', ['clone', '-q', origin, clone])
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        cwd: clone,
        encoding: 'utf8',
      }).trim()
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    writeFileSync(join(clone, '.git/info/exclude'), '/scripts/\n') // the scripts under test (the root folder only) are not part of any commit
    const text = readFileSync(join(here, 'ci-local.sh'), 'utf8').replace('\ncd "$WT"\n', `\n${stubs}\ncd "$WT"\n`)
    writeFileSync(join(clone, 'scripts/ci-local.sh'), text)
    copyCiLocalParts(join(clone, 'scripts')) // the parts ci-local.sh sources in place
    const names = ['ci-runner.sh', 'ci-desktop-gate.sh', ...(opts.affectedScript === false ? [] : ['ci-affected.sh'])]
    for (const n of names) writeFileSync(join(clone, 'scripts', n), readFileSync(join(here, n), 'utf8'))
    const home = join(w.T, 'home')
    mkdirSync(home)
    for (const t of ['pnpm', 'bun']) {
      writeFileSync(join(w.T, 'bin', t), '#!/bin/bash\nexit 0\n')
      chmodSync(join(w.T, 'bin', t), 0o755)
    }
    const calls = join(w.T, 'calls')
    const env: Record<string, string> = {
      ...w.env,
      CI_REPO: 'owner/repo',
      CI_MAX_LOAD: '0',
      CI_POLL: '0.05',
      CI_LOCK_TIMEOUT: '30',
      TALOS_CI_NESTED: '0',
      CI_SLOTS: '1',
      HOME: home,
      CALLS: calls,
      TMPDIR: w.T,
    }
    // commit in the clone and publish to origin/main, as a push to main leaves it
    const land = (files: Record<string, string | null>, msg: string) => {
      for (const [p, c] of Object.entries(files)) {
        if (c === null) rmSync(join(clone, p))
        else {
          mkdirSync(dirname(join(clone, p)), { recursive: true })
          writeFileSync(join(clone, p), c)
        }
      }
      git('add', '-A')
      git('commit', '-q', '--allow-empty', '-m', msg)
      git('push', '-q', 'origin', 'HEAD:main')
      return git('rev-parse', 'HEAD')
    }
    const start = (args: string[] = ['--ref', 'HEAD']) =>
      spawnSync('bash', [join(clone, 'scripts/ci-local.sh'), ...args], {
        cwd: clone,
        env,
        encoding: 'utf8',
        timeout: 90_000,
        killSignal: 'SIGKILL', // ci-local holds off TERM while a child runs, so a hung run would outlive the timeout
      })
    const ran = () =>
      (() => {
        try {
          return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).sort()
        } catch {
          return []
        }
      })()
    const posts = () => {
      try {
        return readFileSync(env.GH_LOG as string, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
      } catch {
        return []
      }
    }
    const post = (job: string, state?: string) =>
      posts().filter(
        (l) => l.includes(`context=local-ci/${job} `) && (state === undefined || l.includes(`state=${state} `)),
      )
    return { ...w, g0, clone, land, start, ran, posts, post, env }
  }
  const sorted = (...j: string[]) => [...j].sort()
  // a skip names the commit where the job last passed: here the seed commit, g0
  const SKIP = (r: { g0: string }, j: string) => `description=skipped: no ${j} inputs changed since ${r.g0.slice(0, 7)}`

  it('a web-only change on a green base: check, mod, browser and image run; desktop and mobile are skipped and say so', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land(web(), 'web only')
    const out = r.start()
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'browser', 'image'))
    for (const j of ['desktop', 'mobile']) {
      const p = r.post(j)
      expect(p, j).toHaveLength(1) // one answer, success: never a pending first
      expect(p[0], j).toContain('state=success')
      expect(p[0], j).toContain(SKIP(r, j))
      expect(p[0], j).not.toContain('passed on')
    }
    for (const j of ['check', 'mod', 'browser', 'image'])
      expect(r.post(j, 'success').join('\n'), j).toContain('passed on')
    expect(out.stdout).toContain('desktop skipped: no desktop inputs changed since')
  })

  it("ci-local.sh hands the plan this attempt's link: another machine's status of the same attempt does not stop the skips", () => {
    const r = run()
    r.status(r.g0, greenRows)
    const head = r.land(web(), 'web only')
    const A = 'https://github.com/owner/repo/actions/runs/7/attempts/1#'
    r.status(head, [
      `ci-part/vitest\tpending\trunning on delphi\t${A}delphi`,
      `local-ci/image\tpending\trunning on titan\t${A}titan`,
    ])
    r.env.CI_ATTEMPT_URL = A
    const out = r.start()
    delete r.env.CI_ATTEMPT_URL
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).not.toContain('already has')
    for (const j of ['desktop', 'mobile']) expect(r.post(j)[0], j).toContain(SKIP(r, j))
    // without the link (every switch off) the same statuses are an earlier run, as today
    rmSync(r.env.GH_LOG as string, { force: true })
    expect(r.start().stdout).toContain('already has')
  })

  it("Hestia on alone (no attempt link in Lemnos's env): the run's own attempt, from GitHub's run variables, is still left out", () => {
    const r = run()
    r.status(r.g0, greenRows)
    const head = r.land(web(), 'web only')
    r.status(head, [
      'report-ci/linux\tpending\trunning on hestia\thttps://github.com/owner/repo/actions/runs/7/attempts/3#hestia',
    ])
    const gh = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '7' }
    Object.assign(r.env, { ...gh, GITHUB_RUN_ATTEMPT: '3' })
    const out = r.start()
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).not.toContain('already has')
    for (const j of ['desktop', 'mobile']) expect(r.post(j)[0], j).toContain(SKIP(r, j))
    // attempt 4 of the same run (a re-run): attempt 3's report is an earlier run
    rmSync(r.env.GH_LOG as string, { force: true })
    r.env.GITHUB_RUN_ATTEMPT = '4'
    expect(r.start().stdout).toContain('already has')
    for (const k of [...Object.keys(gh), 'GITHUB_RUN_ATTEMPT']) delete r.env[k]
  })

  it('an attempt link without its closing # is not used (attempts/2 would also match attempts/20): every status counts', () => {
    const w = world()
    const m1 = w.commit(seedFiles, 'main 1')
    w.status(m1, greenRows)
    const m2 = w.commit(web(), 'main 2')
    w.publish()
    w.status(m2, ['ci-part/vitest\tfailure\tx\thttps://github.com/owner/repo/actions/runs/7/attempts/20#delphi'])
    expect(w.plan(m2, { CI_ATTEMPT_URL: 'https://github.com/owner/repo/actions/runs/7/attempts/2' }).jobs).toEqual(ALL)
  })

  it('the verdict reader takes those statuses for a green commit, and the next run can use it as its base', () => {
    const r = run()
    r.status(r.g0, greenRows)
    const head = r.land(web(), 'web only')
    expect(r.start().status).toBe(0)
    // the last post per context, as GitHub would show it
    const last = new Map<string, string>()
    for (const l of r.posts()) {
      const m = /state=(\S+) -f context=(local-ci\/\S+) -f description=(.*?)( -f target_url=.*)?$/.exec(l)
      if (m) last.set(m[2] as string, `${m[2]}\t${m[1]}\t${m[3]}`)
    }
    expect([...last.keys()].sort()).toEqual(ALL.map((j) => `local-ci/${j}`).sort())
    const cls = spawnSync('bash', ['-c', `. "${join(here, 'ci-runner.sh')}"; ci_classify`], {
      input: `${[...last.values()].join('\n')}\n`,
      encoding: 'utf8',
    })
    expect(cls.stdout, [...last.values()].join('\n')).toMatch(/^green\t/)
    expect(cls.stdout).toContain('skipped, no affected files: desktop mobile')
    // and a following web-only commit is compared with this one
    r.status(head, [...last.values()])
    r.land(web(2), 'web again')
    expect(r.start().status).toBe(0)
    expect(readFileSync(r.env.GH_READS as string, 'utf8')).toContain(`GET ${head}`)
  })

  it('only desktop changed: desktop and check run; browser and mobile are skipped', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'apps/desktop/Sources/a.swift': 'changed' }, 'desktop')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'image', 'desktop'))
    expect(r.post('browser')[0]).toContain(SKIP(r, 'browser'))
    expect(r.post('mobile')[0]).toContain(SKIP(r, 'mobile'))
  })

  it('only mobile changed: mobile and check run; browser and desktop are skipped', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'apps/mobile/ios/a.swift': 'changed' }, 'mobile')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'image', 'mobile'))
    expect(r.post('browser')[0]).toContain(SKIP(r, 'browser'))
    expect(r.post('desktop')[0]).toContain(SKIP(r, 'desktop'))
  })

  it('bridge only: check and the browser job; desktop and mobile are skipped', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'apps/bridge/src/a.ts': 'changed' }, 'bridge')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'image', 'browser'))
  })

  it('a push that changes web and desktop (two commits, one tested) runs the union', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'apps/desktop/Sources/a.swift': 'changed' }, 'inner: desktop, never tested')
    r.land(web(), 'tip: web')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'image', 'browser', 'desktop'))
    expect(r.post('mobile')[0]).toContain(SKIP(r, 'mobile'))
  })

  it('an unknown path runs all six jobs and skips nothing', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'brand-new-folder/file.txt': 'x' }, 'unknown')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted(...ALL))
    expect(r.posts().join('\n')).not.toContain('skipped')
  })

  it('a job that failed on the base runs, even for a web-only change; a job that passed there still skips', () => {
    const r = run()
    r.status(
      r.g0,
      greenRows.map((l) => (l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tfailure\tfailed on ci-runner' : l)),
    )
    r.land(web(), 'web only, base red')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'image', 'browser', 'desktop'))
    expect(r.post('mobile')[0]).toContain(SKIP(r, 'mobile'))
  })

  it('no green base in reach, or GitHub unreadable, runs everything', () => {
    const none = run()
    none.land(web(), 'web only, no statuses at all')
    expect(none.start().status).toBe(0)
    expect(none.ran()).toEqual(sorted(...ALL))
    const down = run()
    down.status(down.g0, greenRows)
    const mid = down.land({}, 'its statuses cannot be read')
    down.land(web(), 'web only')
    down.env.GH_FAIL_SHA = mid // only the nearest commit fails; the older one answers green and must not be taken as the base
    expect(down.start().status).toBe(0)
    expect(down.ran()).toEqual(sorted(...ALL))
  })

  it('--full runs every job on a change that would skip, and so does --no-status; --jobs runs exactly what it names', () => {
    const full = run()
    full.status(full.g0, greenRows)
    full.land(web(), 'web only')
    expect(full.start(['--ref', 'HEAD', '--full']).status).toBe(0)
    expect(full.ran()).toEqual(sorted(...ALL))

    const quiet = run()
    quiet.status(quiet.g0, greenRows)
    quiet.land(web(), 'web only')
    expect(quiet.start(['--ref', 'HEAD', '--no-status']).status).toBe(0)
    expect(quiet.ran()).toEqual(sorted(...ALL))

    const named = run()
    named.status(named.g0, greenRows)
    named.land(web(), 'web only')
    expect(named.start(['--ref', 'HEAD', '--jobs', 'desktop,check']).status).toBe(0)
    expect(named.ran()).toEqual(sorted('check', 'desktop'))
    expect(named.posts().join('\n')).not.toContain('skipped')
  })

  it('TALOS_GUI_TESTS or TALOS_CI_FORCE_DESKTOP set: nothing is skipped, because the GUI desktop tests read apps/web', () => {
    for (const [name, value] of [
      ['TALOS_GUI_TESTS', '1'],
      ['TALOS_CI_FORCE_DESKTOP', 'on'],
    ] as const) {
      const r = run()
      r.status(r.g0, greenRows)
      r.land(web(), 'web only')
      r.env[name] = value
      expect(r.start().status, name).toBe(0)
      expect(r.ran(), name).toEqual(sorted(...ALL))
      expect(r.posts().join('\n'), name).not.toContain('skipped')
    }
    const off = run() // control: both unset or off is the normal skip
    off.status(off.g0, greenRows)
    off.land(web(), 'web only')
    off.env.TALOS_GUI_TESTS = '0'
    off.env.TALOS_CI_FORCE_DESKTOP = 'no'
    expect(off.start().status).toBe(0)
    expect(off.ran()).toEqual(sorted('check', 'mod', 'browser', 'image'))
  })

  it('a red check fails the run; the skipped jobs are still answered as skipped, not as failures', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land(web(), 'web only')
    const text = readFileSync(join(r.clone, 'scripts/ci-local.sh'), 'utf8').replace(
      'job_check() { echo check >> "$CALLS"; }',
      'job_check() { echo check >> "$CALLS"; return 1; }',
    )
    writeFileSync(join(r.clone, 'scripts/ci-local.sh'), text)
    const out = r.start()
    expect(out.status).toBe(1)
    expect(r.post('check', 'failure')).toHaveLength(1)
    expect(r.post('desktop')[0]).toContain(SKIP(r, 'desktop'))
  })

  it('a gh that hangs is stopped at the plan limit and the run goes on with every job', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land(web(), 'web only')
    // A status read hangs far past the limit. Without the limit the run waits on it (here until the test's own 90 s timeout
    // kills the run, and the exit code check fails); with it the read is stopped after CI_PLAN_LIMIT and every job runs.
    const pids = join(r.T, 'hung-gh.pids')
    writeFileSync(
      join(r.T, 'bin/gh'),
      `#!/bin/bash\n[ "$2" = -X ] || [ "$1 $2" = "api -X" ] && exit 0\necho $$ >> "${pids}"\nexec sleep 600\n`,
    )
    r.env.CI_PLAN_LIMIT = '1'
    try {
      const out = r.start()
      expect(out.status, out.stdout + out.stderr).toBe(0)
      expect(r.ran()).toEqual(sorted(...ALL))
      expect(out.stdout).toContain('running every job')
    } finally {
      // the stopped plan leaves its gh behind; the exec above makes the recorded pid the sleep itself
      let hung = ''
      try {
        hung = readFileSync(pids, 'utf8')
      } catch {}
      for (const pid of hung.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid))
        } catch {}
      }
    }
  }, 120_000)

  it('a checkout without ci-affected.sh runs everything (an old base, or a copy of the script on its own)', () => {
    const r = run({ affectedScript: false })
    r.status(r.g0, greenRows)
    r.land(web(), 'web only')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted(...ALL))
  })

  it("TALOS_FUZZ_MS reaches the bridge's bun tests: ci-local.sh does not scrub it", () => {
    const r = run()
    r.status(r.g0, greenRows)
    // the commit has the bridge runner, so both halves go through bun; bun writes down what it was given
    r.land({ 'apps/bridge/scripts/test-parallel.ts': '' }, 'change')
    const text = readFileSync(join(r.clone, 'scripts/ci-local.sh'), 'utf8').replace(
      'job_check() { echo check >> "$CALLS"; }',
      'job_check() { echo check >> "$CALLS"; step_bun_rest > /dev/null; step_bun_schedules > /dev/null; }',
    )
    writeFileSync(join(r.clone, 'scripts/ci-local.sh'), text)
    const log = join(r.T, 'bun.env')
    writeFileSync(join(r.T, 'bin/bun'), `#!/bin/bash\necho "$* fuzz=\${TALOS_FUZZ_MS:-}" >> "${log}"\nexit 0\n`)
    r.env.TALOS_FUZZ_MS = '60000'
    const out = r.start()
    expect(out.status, out.stdout + out.stderr).toBe(0)
    const lines = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.includes('test-parallel.ts'))
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toMatch(/fuzz=60000$/)
    // this commit's runner does not know --retry-failed, so it is not given it (it would read it as the folder to test)
    for (const l of lines) expect(l).not.toContain('--retry-failed')
  })

  it("the bridge's bun runner is told to rerun failed files once, when the commit's runner knows the flag", () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'apps/bridge/scripts/test-parallel.ts': '// knows --retry-failed\n' }, 'change')
    const text = readFileSync(join(r.clone, 'scripts/ci-local.sh'), 'utf8').replace(
      'job_check() { echo check >> "$CALLS"; }',
      'job_check() { echo check >> "$CALLS"; step_bun_rest > /dev/null; step_bun_schedules > /dev/null; }',
    )
    writeFileSync(join(r.clone, 'scripts/ci-local.sh'), text)
    const log = join(r.T, 'bun.args')
    writeFileSync(join(r.T, 'bin/bun'), `#!/bin/bash\necho "$*" >> "${log}"\nexit 0\n`)
    expect(r.start().status).toBe(0)
    const lines = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.includes('test-parallel.ts'))
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toContain(' --retry-failed')
  })

  it("report-ci/fast runs the unit tests the change since check's last pass can reach; without that pass, typecheck and lint only", () => {
    const fastArgs = (green: boolean, args?: string[]) => {
      const r = run()
      if (green) r.status(r.g0, greenRows)
      r.land(web(), 'web only')
      const log = join(r.T, 'pnpm.args')
      writeFileSync(join(r.T, 'bin/pnpm'), `#!/bin/bash\necho "$*" >> "${log}"\nexit 0\n`)
      const out = r.start(args)
      expect(out.status, out.stdout + out.stderr).toBe(0)
      const all = readFileSync(log, 'utf8').split('\n')
      return { vitest: all.filter((l) => l.includes('--project protocol')), all, g0: r.g0 }
    }
    const withBase = fastArgs(true)
    expect(withBase.vitest).toHaveLength(1)
    expect(withBase.vitest[0]).toContain(`--changed ${withBase.g0}`)
    // one retry per failed test and the flake reporter, as in check's own Vitest
    expect(withBase.vitest[0]).toMatch(/--retry=1 --reporter=default --reporter=\S+\/scripts\/ci-flake-vitest\.ts/)
    // check's own base, when the jobs' bases differ: check passed at c1, browser was only skipped there (its base is g0)
    {
      const r = run()
      r.status(r.g0, greenRows)
      const c1 = r.land(web(1), 'check passed here, browser skipped')
      r.status(
        c1,
        ALL.map((j) =>
          j === 'browser'
            ? `local-ci/browser\tsuccess\tskipped: no browser inputs changed since ${r.g0.slice(0, 7)}`
            : ok(j),
        ),
      )
      r.land(web(2), 'web again')
      const log = join(r.T, 'pnpm.args')
      writeFileSync(join(r.T, 'bin/pnpm'), `#!/bin/bash\necho "$*" >> "${log}"\nexit 0\n`)
      expect(r.start().status).toBe(0)
      const v = readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.includes('--project protocol'))
      expect(v).toEqual([expect.stringContaining(`--changed ${c1}`)])
    }
    // no pass of check in reach, or the full run: the unit tests would be a second copy of check's, so only typecheck and lint
    for (const f of [fastArgs(false), fastArgs(true, ['--ref', 'HEAD', '--full'])]) {
      expect(f.vitest).toEqual([])
      expect(f.all.filter((l) => l === 'typecheck' || l === 'lint').length).toBeGreaterThanOrEqual(2)
    }
  })

  it('the check job leaves out the install and kit tests only when the plan says so, and --full keeps them', () => {
    const vitestArgs = (files: Record<string, string>, args?: string[]) => {
      const r = run()
      r.status(r.g0, greenRows)
      r.land(files, 'change')
      // check runs the real vitest step; pnpm writes down what it was asked
      const text = readFileSync(join(r.clone, 'scripts/ci-local.sh'), 'utf8').replace(
        'job_check() { echo check >> "$CALLS"; }',
        'job_check() { echo check >> "$CALLS"; step_vitest > /dev/null; }',
      )
      writeFileSync(join(r.clone, 'scripts/ci-local.sh'), text)
      const log = join(r.T, 'pnpm.args')
      writeFileSync(
        join(r.T, 'bin/pnpm'),
        `#!/bin/bash\necho "$* full-self-test=\${TALOS_KIT_FULL_SELF_TEST:-}" >> "${log}"\nexit 0\n`,
      )
      const out = r.start(args)
      expect(out.status, out.stdout + out.stderr).toBe(0)
      return {
        args: readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('test ')),
        out: out.stdout,
      }
    }
    const EXCLUDE = '--exclude **/root-install*.test.ts --exclude **/kit-tests.test.ts'
    const skipped = vitestArgs(web())
    expect(skipped.args).toEqual([expect.stringContaining(EXCLUDE)])
    // one retry per failed test, and the reporter that logs a test that passed only on it
    expect(skipped.args).toEqual([
      expect.stringMatching(/ --retry=1 --reporter=default --reporter=\S+\/scripts\/ci-flake-vitest\.ts( |$)/),
    ])
    expect(skipped.out).toContain('install and kit tests skipped')
    expect(vitestArgs({ 'kit/install.sh': 'changed' }).args).toEqual([expect.not.stringContaining('--exclude')])
    const full = vitestArgs(web(), ['--ref', 'HEAD', '--full']).args
    expect(full).toEqual([expect.not.stringContaining('--exclude')])
    // the full run is also the one that runs self-test.sh's suites inside test-default-agent.sh
    expect(full).toEqual([expect.stringMatching(/full-self-test=1$/)])
    expect(skipped.args).toEqual([expect.stringMatching(/full-self-test=0$/)])
  })
})
