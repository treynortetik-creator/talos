// scripts/verified-trailer.sh on its own, in a temp repo: what counts as a trailer, the three modes, and that observe never fails
// whatever git does. (pre-push.test.ts drives it through the real hook and a real push.)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeTool } from './fake-tool'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verified-trailer.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo() {
  const T = mkdtempSync(join(tmpdir(), 'vt-'))
  dirs.push(T)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: T,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    TALOS_VERIFIED_LOG: join(T, 'v.log'),
  }
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(T, 'f'), '0\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  let n = 0
  const commit = (msg: string) => {
    writeFileSync(join(T, 'f'), `${++n}\n`)
    git('commit', '-qam', msg)
    return git('rev-parse', 'HEAD')
  }
  const run = (extra: Record<string, string> = {}, input?: string) => {
    const r = spawnSync('bash', [SCRIPT], {
      cwd: T,
      env: { ...env, ...extra },
      input: input ?? `${git('rev-parse', 'HEAD')} ${base}\n`,
      encoding: 'utf8',
    })
    const log = existsSync(env.TALOS_VERIFIED_LOG as string)
      ? readFileSync(env.TALOS_VERIFIED_LOG as string, 'utf8')
      : ''
    return { code: r.status, err: r.stderr, log }
  }
  return { T, env, base, commit, run, git }
}

describe('verified-trailer.sh', () => {
  it('a commit with no trailer is logged and said, exit 0 (the default is observe)', () => {
    const r = repo()
    r.commit('plain')
    const o = r.run()
    expect(o.code).toBe(0)
    expect(o.err).toContain('has no Verified: trailer (plain)')
    expect(o.log).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+Z commit \w+ has no Verified: trailer \(plain\)$/m)
  })

  it('accepts evidence text and "none" with a dash and a reason; refuses a bare "none" and an empty value', () => {
    const r = repo()
    r.commit('a\n\nVerified: web fake mode, graph click x5, themes all; evidence <root>/96f2389/')
    r.commit('b\n\nVerified: none — docs only')
    r.commit('c\n\nVerified: none - rename the compiler checks')
    r.commit('d\n\nVerified: None: comment only')
    expect(r.run().err).toBe('')
    for (const bad of ['Verified: none', 'Verified: none -', 'Verified: none and some words', 'Verified:']) {
      const x = repo()
      x.commit(`bad\n\n${bad}`)
      const o = x.run()
      expect(o.code).toBe(0)
      expect(o.err, bad).toMatch(/no Verified: trailer|unusable Verified: trailer/)
    }
  })

  it('a trailer naming an absolute path is flagged (the personal check refuses home paths): cite <root>/<sha>/', () => {
    for (const p of ['/home/alex/ev/96f2389/', '/Users/alex/ev/x/', '/private/tmp/ev/', '/var/folders/ab/x/']) {
      const r = repo()
      r.commit(`a\n\nVerified: web fake mode; evidence ${p}`)
      const o = r.run()
      expect(o.code, p).toBe(0)
      expect(o.err, p).toContain('naming an absolute path; cite <root>/<sha>/ instead')
    }
  })

  it('a "Verified:" line in the body (not in the trailer block) does not count', () => {
    const r = repo()
    r.commit('subject\n\nVerified: yes, I say so, here in the body\n\nSigned-off-by: someone')
    expect(r.run().err).toContain('has no Verified: trailer')
  })

  it("merge commits are skipped; commits named by TALOS_VERIFIED_NOT are not this push's", () => {
    const r = repo()
    const first = r.commit('already on main')
    const second = r.commit('mine\n\nVerified: none - test')
    expect(r.run({ TALOS_VERIFIED_NOT: first }, `${second} ${r.base}\n`).err).toBe('')
    expect(r.run({}, `${second} ${r.base}\n`).err).toContain('already on main')
  })

  it('off does nothing', () => {
    const r = repo()
    r.commit('plain')
    const o = r.run({ TALOS_VERIFIED_TRAILER: 'off' })
    expect(o).toEqual({ code: 0, err: '', log: '' })
  })

  it('the mode also comes from git config; the environment wins', () => {
    const r = repo()
    r.commit('plain')
    r.git('config', 'talos.verifiedTrailer', 'enforce')
    expect(r.run().code).toBe(1)
    expect(r.run({ TALOS_VERIFIED_TRAILER: 'observe' }).code).toBe(0)
  })

  it('enforce refuses a missing trailer and passes a good one', () => {
    const r = repo()
    r.commit('plain')
    const refused = r.run({ TALOS_VERIFIED_TRAILER: 'enforce' })
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('REFUSED (enforce)')
    const g = repo()
    g.commit('ok\n\nVerified: none - fixture')
    expect(g.run({ TALOS_VERIFIED_TRAILER: 'enforce' }).code).toBe(0)
  })

  it('observe cannot fail the push even if git errors (a base that is not there, a git that dies, an unwritable log); enforce does fail', () => {
    const r = repo()
    r.commit('plain')
    const head = r.git('rev-parse', 'HEAD')
    const bad = r.run({}, `${head} ${'0'.repeat(39)}1\n`)
    expect(bad.code).toBe(0)
    expect(bad.err).toContain('could not list the commits')
    expect(r.run({ TALOS_VERIFIED_TRAILER: 'enforce' }, `${head} ${'0'.repeat(39)}1\n`).code).toBe(1)

    // a git that fails for every command the check runs
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    fakeTool(
      bin,
      'git',
      `#!/bin/sh\ncase "$*" in *rev-list*|*interpret-trailers*|*"log -1"*) echo "fatal: simulated" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`,
    )
    const broken = r.run({ PATH: `${bin}:${r.env.PATH}` })
    expect(broken.code).toBe(0)
    expect(broken.err).toContain('could not list the commits')
    expect(r.run({ PATH: `${bin}:${r.env.PATH}`, TALOS_VERIFIED_TRAILER: 'enforce' }).code).toBe(1)

    const nolog = r.run({ TALOS_VERIFIED_LOG: join(r.T, 'no-such-dir', 'x.log') })
    expect(nolog.code).toBe(0)
    expect(nolog.err).toContain('cannot write the log')
  })

  it('an unknown mode is observe, said once', () => {
    const r = repo()
    r.commit('plain')
    const o = r.run({ TALOS_VERIFIED_TRAILER: 'banana' })
    expect(o.code).toBe(0)
    expect(o.err).toContain('unknown mode "banana"')
  })
})

describe('verified-trailer.sh: a long history never makes the push slow or noisy', () => {
  /** n empty-message commits in one go (git fast-import), as a chain; returns the tip. Refs are under the repo's `refs/heads/<name>`. */
  function chain(r: ReturnType<typeof repo>, name: string, n: number, parent?: string) {
    let s = ''
    for (let i = 1; i <= n; i++) {
      const msg = `c${i}\n`
      s += `commit refs/heads/${name}\ncommitter t <t@example.com> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}`
      if (i === 1 && parent) s += `from ${parent}\n`
      s += `M 100644 inline f-${name}\ndata 2\n${i % 10}\n\n`
    }
    const p = spawnSync('git', ['fast-import', '--quiet'], { cwd: r.T, env: r.env, input: s, encoding: 'utf8' })
    if (p.status !== 0) throw new Error(`fast-import: ${p.stderr}`)
    return r.git('rev-parse', name)
  }
  const timed = (f: () => { code: number | null; err: string; log: string }) => {
    const t = Date.now()
    const o = f()
    return { ...o, ms: Date.now() - t, lines: o.err.split('\n').filter(Boolean).length }
  }

  it('a new branch with no remote main ("<tip> none") checks only the newest commits, in a few lines', () => {
    const r = repo()
    const tip = chain(r, 'big', 150)
    const o = timed(() => r.run({}, `${tip} none\n`))
    expect(o.code).toBe(0)
    expect(o.ms).toBeLessThan(2000)
    expect(o.lines).toBeLessThanOrEqual(6)
    expect(o.err).toMatch(/newest 20/)
    expect(o.log.split('\n').filter(Boolean).length).toBeLessThanOrEqual(6)
  })

  it('a force push (the old remote tip is not an ancestor) is the same', () => {
    const r = repo()
    const other = chain(r, 'old', 40)
    const tip = chain(r, 'new', 150)
    const o = timed(() => r.run({}, `${tip} ${other}\n`))
    expect(o.code).toBe(0)
    expect(o.ms).toBeLessThan(2000)
    expect(o.lines).toBeLessThanOrEqual(6)
  })

  it('a big range with a base is capped too, and says how many it did not look at', () => {
    const r = repo()
    const tip = chain(r, 'big', 150)
    const o = timed(() => r.run({}, `${tip} ${r.base}\n`))
    expect(o.code).toBe(0)
    expect(o.ms).toBeLessThan(2000)
    expect(o.lines).toBeLessThanOrEqual(6)
    expect(o.err).toMatch(/only the newest 20 were checked/)
  })

  it('the cap is a setting, and a small range prints each commit as before (up to 3), with a count', () => {
    const r = repo()
    const tip = chain(r, 'small', 5)
    const o = r.run({ TALOS_VERIFIED_MAX: '3' }, `${tip} none\n`)
    expect(o.err).toMatch(/newest 3/)
    const small = repo()
    small.commit('one')
    small.commit('two')
    const s = small.run()
    expect(s.err.match(/has no Verified: trailer/g)).toHaveLength(2)
    expect(s.err).toMatch(/2 commits? lack/)
  })

  it('enforce still refuses when a capped check finds a bad commit', () => {
    const r = repo()
    const tip = chain(r, 'big', 50)
    expect(r.run({ TALOS_VERIFIED_TRAILER: 'enforce' }, `${tip} none\n`).code).toBe(1)
  })

  it('the log file does not grow without bound', () => {
    const r = repo()
    r.commit('plain')
    writeFileSync(r.env.TALOS_VERIFIED_LOG as string, `${'2026-01-01T00:00:00Z old line\n'.repeat(20_000)}`)
    const before = readFileSync(r.env.TALOS_VERIFIED_LOG as string, 'utf8').length
    expect(before).toBeGreaterThan(500_000)
    const o = r.run()
    expect(o.code).toBe(0)
    expect(o.log.length).toBeLessThan(300_000)
    expect(o.log).toContain('has no Verified: trailer') // the new line is kept, the oldest are dropped
  })
})
