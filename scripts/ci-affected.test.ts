// scripts/ci-affected.sh: which of the six CI jobs a change can affect, and which commit it is compared with. Two layers:
//   `jobs <base> <head>`  pure git, one throwaway repo: every path class, the unknown path, renames, deletes, odd names
//   `plan <repo> <head>`  the base is the last GREEN commit (a fake `gh` answers the statuses): inner commits, a red base, a PR
// and, at the end, scripts/ci-local.sh itself with stub jobs: what it runs, what it posts for a job it skips, and that the
// verdict reader accepts that post. Nothing here touches a real repository, runner, cache or simulator.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const affected = join(here, 'ci-affected.sh')
vi.setConfig({ testTimeout: 60_000 })

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
    echo "GET $sha" >> "$GH_READS"
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

describe('ci-affected.sh plan: the base is the last green commit, never just the parent', () => {
  it('a green parent is the base: a web-only change skips desktop and mobile', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const head = w.commit(web(), 'web')
    w.publish()
    const r = w.plan(head)
    expect(r.jobs).toEqual(only('browser'))
    expect(r.why).toContain(g.slice(0, 7))
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

  it('a red nearest verdict means everything runs: a skip cannot hide an earlier red', () => {
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
    expect(r.jobs).toEqual(ALL)
    expect(r.why).toMatch(/red|not green/i)
  })

  it('an older green behind a red does not count: the nearest tested commit decides', () => {
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
    expect(w.plan(head).jobs).toEqual(ALL)
  })

  it('a base that is pending, partly reported, errored or skipped the old way is not green: everything runs', () => {
    const cases: Record<string, string[]> = {
      pending: greenRows.map((l) =>
        l.startsWith('local-ci/browser\t') ? 'local-ci/browser\tpending\trunning on ci-runner' : l,
      ),
      partial: greenRows.slice(0, 3),
      error: greenRows.map((l) => (l.startsWith('local-ci/mod\t') ? 'local-ci/mod\terror\tcancelled' : l)),
      'old skip text': greenRows.map((l) =>
        l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tsuccess\tskipped (no desktop changes)' : l,
      ),
      'check skipped': greenRows.map((l) => (l.startsWith('local-ci/check\t') ? skippedOk('check') : l)),
    }
    for (const [name, rows] of Object.entries(cases)) {
      const w = world()
      const g = w.commit(seedFiles, 'base')
      w.status(g, rows)
      const head = w.commit(web(), 'web')
      w.publish()
      expect(w.plan(head).jobs, name).toEqual(ALL)
    }
  })

  it('a commit whose own skips were honest is a good base: desktop and mobile stay skipped down a chain of web changes', () => {
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
    expect(r.why).toContain(s.slice(0, 7))
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

  it('more than 30 statuses on a commit are all read: a red local-ci row past the first page is not hidden', () => {
    const w = world()
    const g = w.commit(seedFiles, 'green')
    w.status(g, greenRows)
    const red = w.commit({}, 'red behind 30 other contexts')
    const filler = Array.from({ length: 35 }, (_, i) => `ci/other-${i}\tsuccess\tfine`)
    w.status(red, [...filler, 'local-ci/check\tfailure\tfailed on ci-runner'])
    const head = w.commit(web(), 'web')
    w.publish()
    const r = w.plan(head)
    expect(r.jobs).toEqual(ALL) // red nearest tested commit: no base. A 30-row read sees no local-ci and skips against g
    expect(r.why).toContain(red.slice(0, 7))
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
    writeFileSync(join(clone, '.git/info/exclude'), 'scripts/\n') // the scripts under test are not part of any commit
    const text = readFileSync(join(here, 'ci-local.sh'), 'utf8').replace('\ncd "$WT"\n', `\n${stubs}\ncd "$WT"\n`)
    writeFileSync(join(clone, 'scripts/ci-local.sh'), text)
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
  const SKIP_TEXT = 'description=skipped: no affected files'

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
      expect(p[0], j).toContain(SKIP_TEXT)
      expect(p[0], j).not.toContain('passed on')
    }
    for (const j of ['check', 'mod', 'browser', 'image'])
      expect(r.post(j, 'success').join('\n'), j).toContain('passed on')
    expect(out.stdout).toContain('desktop skipped: no affected files')
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
    expect(r.post('browser')[0]).toContain(SKIP_TEXT)
    expect(r.post('mobile')[0]).toContain(SKIP_TEXT)
  })

  it('only mobile changed: mobile and check run; browser and desktop are skipped', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'apps/mobile/ios/a.swift': 'changed' }, 'mobile')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted('check', 'mod', 'image', 'mobile'))
    expect(r.post('browser')[0]).toContain(SKIP_TEXT)
    expect(r.post('desktop')[0]).toContain(SKIP_TEXT)
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
    expect(r.post('mobile')[0]).toContain(SKIP_TEXT)
  })

  it('an unknown path runs all six jobs and skips nothing', () => {
    const r = run()
    r.status(r.g0, greenRows)
    r.land({ 'brand-new-folder/file.txt': 'x' }, 'unknown')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted(...ALL))
    expect(r.posts().join('\n')).not.toContain('skipped')
  })

  it('a base that was red runs everything, even for a web-only change', () => {
    const r = run()
    r.status(
      r.g0,
      greenRows.map((l) => (l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tfailure\tfailed on ci-runner' : l)),
    )
    r.land(web(), 'web only, base red')
    expect(r.start().status).toBe(0)
    expect(r.ran()).toEqual(sorted(...ALL))
    expect(r.posts().join('\n')).not.toContain('skipped')
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
    expect(r.post('desktop')[0]).toContain(SKIP_TEXT)
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
})
