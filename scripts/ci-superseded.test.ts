// ci-runner.sh superseded: GitHub keeps one run waiting per concurrency group and cancels the older waiting one, so a busy hour
// tests some commits of main and not others. A push run marks the ones in between (since the last commit with any local-ci status)
// report-ci/superseded, so a skip never looks like "untested and fine". The verdict ignores report-ci/*.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { copyRunnerMainQueue } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ci-sup-'))
  dirs.push(T)
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: T, env: gitEnv, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  mkdirSync(join(T, 'scripts'))
  cpSync(join(here, 'ci-runner.sh'), join(T, 'scripts/ci-runner.sh'))
  copyRunnerMainQueue(join(T, 'scripts'))
  const commit = (n: string) => {
    writeFileSync(join(T, 'f'), `${n}\n`)
    git('add', '-A')
    git('commit', '-qm', n)
    return git('rev-parse', 'HEAD')
  }
  const bin = mkdtempSync(join(tmpdir(), 'ci-sup-bin-'))
  dirs.push(bin)
  mkdirSync(join(T, '.st'))
  // GitHub: each commit's statuses from .st/<sha> ("context<TAB>state" rows); every call written down
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nall="$*"; echo "$all" >> "${T}/.gh.log"\ncase "$all" in *"-X POST"*) exit 0 ;; *"/commits/"*"/status"*) s="\${all#*/commits/}"; s="\${s%%/status*}"; cat "${T}/.st/$s" 2>/dev/null ;; esac\nexit 0\n`,
    { mode: 0o755 },
  )
  const has = (sha: string, rows: string) => writeFileSync(join(T, '.st', sha), rows)
  const run = (sha: string, event = 'push') =>
    spawnSync('bash', ['scripts/ci-runner.sh', 'superseded'], {
      cwd: T,
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_SHA: sha,
      },
      encoding: 'utf8',
    })
  const marked = () =>
    (existsSync(join(T, '.gh.log')) ? readFileSync(join(T, '.gh.log'), 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes('-X POST') && l.includes('context=report-ci/superseded'))
  return { T, commit, has, run, marked }
}

describe('ci-runner.sh superseded: the commits of main CI skipped are marked as skipped', () => {
  it('every commit since the last one with a local-ci status, not that one, not this one', () => {
    const s = setup()
    const a = s.commit('tested')
    s.has(a, 'local-ci/check\tsuccess\n')
    const b = s.commit('skipped one')
    const c = s.commit('skipped two')
    s.has(c, 'report-ci/linux\tsuccess\n') // a report-only status is not a test of the commit
    const d = s.commit('this run')
    const r = s.run(d)
    expect(r.status, r.stderr).toBe(0)
    const m = s.marked()
    expect(m).toHaveLength(2)
    expect(m.some((l) => l.includes(`statuses/${b}`))).toBe(true)
    expect(m.some((l) => l.includes(`statuses/${c}`))).toBe(true)
    for (const l of m)
      expect(l).toMatch(
        new RegExp(
          `state=success .*description=not tested: superseded by ${d.slice(0, 7)}; CI tests main's newest commit`,
        ),
      )
  })

  it('a commit already marked is not marked again; at most 20 commits back', () => {
    const s = setup()
    s.commit('root')
    const all: string[] = []
    for (let i = 0; i < 25; i++) all.push(s.commit(`c${i}`))
    const tip = all.at(-1) as string
    s.has(all.at(-2) as string, 'report-ci/superseded\tsuccess\n')
    s.run(tip)
    expect(s.marked()).toHaveLength(19) // 20 back, less the one already marked
  })

  it('only a push run: a PR, a dispatch or the nightly marks nothing', () => {
    const s = setup()
    const a = s.commit('a')
    s.has(a, 'local-ci/check\tsuccess\n')
    s.commit('b')
    const c = s.commit('c')
    for (const e of ['pull_request', 'workflow_dispatch', 'schedule']) {
      expect(s.run(c, e).status).toBe(0)
      expect(s.marked(), e).toEqual([])
    }
  })
})
