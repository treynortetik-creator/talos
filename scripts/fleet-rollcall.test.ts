// scripts/fleet-state-push.sh and scripts/fleet-rollcall.sh: one status line per machine on refs/fleet/<machine>, and the table that
// reads them back. Every test uses a temp BARE repository as origin and a temp clone; the real origin is never touched.
// gate-reads: scripts/fleet-state-push.sh scripts/fleet-rollcall.sh scripts/check-no-personal.sh
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const push = join(here, 'fleet-state-push.sh')
const rollcall = join(here, 'fleet-rollcall.sh')
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('TALOS_')),
)
const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)))
  temps.push(d)
  return d
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env: cleanEnv,
    encoding: 'utf8',
  })

/** A bare origin and a clone of it holding one commit on main. */
function fixture() {
  const origin = tmp('fleet-origin-')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const clone = tmp('fleet-clone-')
  git(clone, 'init', '-q', '-b', 'main')
  git(clone, 'remote', 'add', 'origin', origin)
  writeFileSync(join(clone, 'README.md'), 'hello\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-q', '-m', 'first')
  git(clone, 'push', '-q', 'origin', 'main')
  return { origin, clone }
}

function runScript(script: string, cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8', env: { ...cleanEnv, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }
}
const doPush = (clone: string, args: string[], machine: string | null = 'work', env: Record<string, string> = {}) =>
  runScript(push, clone, args, { ...(machine ? { TALOS_MACHINE: machine } : {}), ...env })
const doRoll = (clone: string, args: string[] = [], env: Record<string, string> = {}) =>
  runScript(rollcall, clone, args, env)
const refs = (origin: string) => git(origin, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/fleet/')
const writeRoster = (dir: string, lines: string[]) => {
  const f = join(dir, 'roster.txt')
  writeFileSync(f, `${lines.join('\n')}\n`)
  return f
}
const at = (secondsAgo: number) => String(Math.floor(Date.now() / 1000) - secondsAgo)

describe('fleet-state-push.sh', () => {
  it('publishes one line to refs/fleet/<machine> as a parentless commit holding one file, headline', () => {
    const { origin, clone } = fixture()
    const r = doPush(clone, ['building the thing'])
    expect(r.code, r.out).toBe(0)
    const sha = git(origin, 'rev-parse', 'refs/fleet/work').trim()
    expect(git(origin, 'ls-tree', '--name-only', sha).trim()).toBe('headline')
    expect(git(origin, 'show', `${sha}:headline`)).toBe('building the thing\n')
    expect(git(origin, 'rev-list', '--parents', '-n', '1', sha).trim()).toBe(sha)
  })

  it('a second push replaces the first (force)', () => {
    const { origin, clone } = fixture()
    expect(doPush(clone, ['one']).code).toBe(0)
    const first = git(origin, 'rev-parse', 'refs/fleet/work').trim()
    expect(doPush(clone, ['two'], 'work', { GIT_COMMITTER_DATE: at(60) }).code).toBe(0)
    const second = git(origin, 'rev-parse', 'refs/fleet/work').trim()
    expect(second).not.toBe(first)
    expect(git(origin, 'show', `${second}:headline`)).toBe('two\n')
  })

  it('refuses 161 characters and accepts 160', () => {
    const { origin, clone } = fixture()
    const bad = doPush(clone, ['a'.repeat(161)])
    expect(bad.code).not.toBe(0)
    expect(bad.out).toMatch(/160/)
    expect(refs(origin)).toBe('')
    expect(doPush(clone, ['a'.repeat(160)]).code).toBe(0)
  })

  it('refuses a two-line value, an empty one and a control character, and pushes nothing', () => {
    const { origin, clone } = fixture()
    for (const v of ['line one\nline two', '', 'tab\there', 'bell\u0007']) {
      const r = doPush(clone, [v])
      expect(r.code, JSON.stringify(v)).not.toBe(0)
    }
    expect(refs(origin)).toBe('')
  })

  it('refuses a line check-no-personal refuses and pushes nothing', () => {
    const { origin, clone } = fixture()
    const before = git(origin, 'for-each-ref')
    const r = doPush(clone, [`mail me at ${['jo.smith', '@', 'gmail.com'].join('')}`])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('check-no-personal')
    expect(git(origin, 'for-each-ref')).toBe(before)
  })

  it('refuses with no TALOS_MACHINE (and a bad one), and pushes nothing', () => {
    const { origin, clone } = fixture()
    const r = doPush(clone, ['hello'], null)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('TALOS_MACHINE')
    expect(doPush(clone, ['hello'], 'Bad Name').code).not.toBe(0)
    expect(doPush(clone, ['hello'], '_roster').code).not.toBe(0)
    expect(refs(origin)).toBe('')
  })

  it('leaves the working tree, the index and the local branches alone', () => {
    const { clone } = fixture()
    const branches = git(clone, 'for-each-ref', 'refs/heads')
    const head = git(clone, 'rev-parse', 'HEAD')
    expect(doPush(clone, ['hello']).code).toBe(0)
    expect(doRoll(clone).code).toBe(0)
    expect(git(clone, 'status', '--porcelain')).toBe('')
    expect(git(clone, 'for-each-ref', 'refs/heads')).toBe(branches)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('--roster publishes the roster file the same way, with the same checks', () => {
    const { origin, clone } = fixture()
    const ok = writeRoster(clone, ['work w1', 'home', 'atlas'])
    const r = doPush(clone, ['--roster', ok])
    expect(r.code, r.out).toBe(0)
    const sha = git(origin, 'rev-parse', 'refs/fleet/_roster').trim()
    expect(git(origin, 'ls-tree', '--name-only', sha).trim()).toBe('roster')
    expect(git(origin, 'show', `${sha}:roster`)).toBe('work w1\nhome\natlas\n')
    const before = git(origin, 'for-each-ref')
    expect(doPush(clone, ['--roster', writeRoster(clone, ['work', 'x'.repeat(161)])]).code).not.toBe(0)
    const leak = writeRoster(clone, ['work', ['jo.smith', '@', 'gmail.com'].join('')])
    expect(doPush(clone, ['--roster', leak]).code).not.toBe(0)
    expect(git(origin, 'for-each-ref')).toBe(before)
  })
})

describe('fleet-rollcall.sh', () => {
  it('shows a pushed line with an age', () => {
    const { clone } = fixture()
    expect(
      doPush(clone, ['building the thing'], 'work', { GIT_COMMITTER_DATE: at(3 * 3600 + 12 * 60 + 30) }).code,
    ).toBe(0)
    const r = doRoll(clone)
    expect(r.code, r.out).toBe(0)
    expect(r.stdout).toMatch(/work \| building the thing \| 3h12m/)
  })

  it('with a roster: a member with no ref is "never published", and one over 2 hours is STALE', () => {
    const { clone } = fixture()
    expect(doPush(clone, ['fresh work'], 'work', { GIT_COMMITTER_DATE: at(600) }).code).toBe(0)
    expect(doPush(clone, ['old news'], 'home', { GIT_COMMITTER_DATE: at(3 * 3600) }).code).toBe(0)
    expect(doPush(clone, ['--roster', writeRoster(clone, ['work w1', 'home', 'atlas'])], 'work').code).toBe(0)
    const r = doRoll(clone)
    expect(r.code, r.out).toBe(0)
    const rows = r.stdout.trim().split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^work \| fresh work \| 1?0m$/)
    expect(rows[0]).not.toContain('STALE')
    expect(rows[1]).toMatch(/^home \| old news \| 3h0\dm STALE$/)
    expect(rows[2]).toBe('atlas | never published | -')
  })

  it('without a _roster says so and lists the refs that exist', () => {
    const { clone } = fixture()
    expect(doPush(clone, ['only me']).code).toBe(0)
    const r = doRoll(clone)
    expect(r.code).toBe(0)
    expect(r.out).toContain('_roster')
    expect(r.out).toMatch(/missing/i)
    expect(r.stdout).toMatch(/^work \| only me \| /m)
  })

  it('--json gives the same rows as one array', () => {
    const { clone } = fixture()
    expect(doPush(clone, ['fresh work'], 'work', { GIT_COMMITTER_DATE: at(3 * 3600) }).code).toBe(0)
    expect(doPush(clone, ['--roster', writeRoster(clone, ['work w1 w-one', 'atlas'])], 'work').code).toBe(0)
    const r = doRoll(clone, ['--json'])
    expect(r.code, r.out).toBe(0)
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: 'work', aliases: ['w1', 'w-one'], headline: 'fresh work', stale: true })
    expect(rows[0]?.age_seconds).toBeGreaterThanOrEqual(3 * 3600)
    expect(rows[1]).toMatchObject({ name: 'atlas', aliases: [], headline: null, age_seconds: null, stale: false })
  })

  it('--json with no roster still prints a valid array', () => {
    const { clone } = fixture()
    const empty = doRoll(clone, ['--json'])
    expect(empty.code).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual([])
    expect(doPush(clone, ['a "quoted" \\ line']).code).toBe(0)
    const one = JSON.parse(doRoll(clone, ['--json']).stdout) as Array<Record<string, unknown>>
    expect(one[0]?.headline).toBe('a "quoted" \\ line')
  })

  it('changes no branch, no file and no index', () => {
    const { clone } = fixture()
    doPush(clone, ['hello'])
    const branches = git(clone, 'for-each-ref', 'refs/heads')
    expect(doRoll(clone).code).toBe(0)
    expect(doRoll(clone, ['--json']).code).toBe(0)
    expect(git(clone, 'status', '--porcelain')).toBe('')
    expect(git(clone, 'for-each-ref', 'refs/heads')).toBe(branches)
  })
})

describe('fleet-state-push.sh, more', () => {
  it('a headline that starts with a dash goes after "--"; without it the script refuses', () => {
    const { origin, clone } = fixture()
    expect(doPush(clone, ['-- not an option']).code).not.toBe(0)
    expect(refs(origin)).toBe('')
    const r = doPush(clone, ['--', '-- not an option'])
    expect(r.code, r.out).toBe(0)
    expect(git(origin, 'show', `${git(origin, 'rev-parse', 'refs/fleet/work').trim()}:headline`)).toBe(
      '-- not an option\n',
    )
  })

  it("refuses a line from a private doc's Appendix P that sits in the main checkout's private-docs list, from a worktree", () => {
    const { origin, clone } = fixture()
    const main = tmp('fleet-main-')
    git(main, 'init', '-q', '-b', 'main')
    mkdirSync(join(main, 'scripts'))
    for (const f of ['fleet-state-push.sh', 'check-no-personal.sh', 'denylist.generic.txt'])
      cpSync(join(here, f), join(main, 'scripts', f))
    git(main, 'add', '-A')
    git(main, 'commit', '-q', '-m', 'scripts')
    const line = 'zq-private-doc-line-for-the-test-91'
    const doc = join(tmp('fleet-doc-'), 'private.md')
    writeFileSync(doc, `# t\n\n## Appendix P\n\n- ${line}\n`)
    writeFileSync(join(main, 'scripts/private-docs.txt'), `${doc}\n`) // untracked, as in a real main checkout
    const wt = join(tmp('fleet-wt-'), 'wt')
    git(main, 'worktree', 'add', '-q', '-b', 'other', wt)
    expect(existsSync(join(wt, 'scripts/private-docs.txt'))).toBe(false)
    const script = join(wt, 'scripts/fleet-state-push.sh')
    const bad = runScript(script, clone, [`about ${line} here`], { TALOS_MACHINE: 'work' })
    expect(bad.code).not.toBe(0)
    expect(bad.out).toContain('check-no-personal')
    expect(refs(origin)).toBe('')
    expect(runScript(script, clone, ['about something else'], { TALOS_MACHINE: 'work' }).code).toBe(0)
  })

  it('goes through the real pre-push hook: a headline and a roster are accepted, and the gate is never started', () => {
    const { origin, clone } = fixture()
    mkdirSync(join(clone, 'scripts'))
    for (const f of [
      'pre-push.sh',
      'check-no-personal.sh',
      'denylist.generic.txt',
      'verified-trailer.sh',
      'fleet-state-push.sh',
    ])
      cpSync(join(here, f), join(clone, 'scripts', f))
    const calls = join(clone, '..', 'gate-calls.log')
    writeFileSync(join(clone, 'scripts/gate.sh'), `#!/bin/sh\necho gate >> "${calls}"\nexit 1\n`)
    cpSync(join(here, '..', '.githooks'), join(clone, '.githooks'), { recursive: true })
    git(clone, 'config', 'core.hooksPath', join(clone, '.githooks'))
    const script = join(clone, 'scripts/fleet-state-push.sh')
    const a = runScript(script, clone, ['through the hook'], { TALOS_MACHINE: 'work' })
    expect(a.code, a.out).toBe(0)
    expect(a.out).toContain('pre-push: a fleet status line')
    const b = runScript(script, clone, ['--roster', writeRoster(tmp('fleet-r-'), ['work', 'home'])])
    expect(b.code, b.out).toBe(0)
    expect(
      refs(origin)
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' ')[0])
        .sort(),
    ).toEqual(['refs/fleet/_roster', 'refs/fleet/work'])
    expect(existsSync(calls)).toBe(false)
  })
})

describe('fleet-rollcall.sh, more', () => {
  it('a publisher clock a little ahead never shows a negative age', () => {
    const { clone } = fixture()
    expect(doPush(clone, ['from the future'], 'work', { GIT_COMMITTER_DATE: at(-300) }).code).toBe(0)
    expect(doRoll(clone).stdout).toMatch(/^work \| from the future \| 0m$/m)
    const row = (JSON.parse(doRoll(clone, ['--json']).stdout) as Array<Record<string, unknown>>)[0]
    expect(row?.age_seconds).toBe(0)
    expect(row?.stale).toBe(false)
  })

  it('an alias is data, never a glob', () => {
    const { origin, clone } = fixture()
    // the push script would refuse such an alias; the reader must still not trust what a ref holds
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: origin,
      env: cleanEnv,
      encoding: 'utf8',
      input: 'work * ?\n',
    }).trim()
    const tree = execFileSync('git', ['mktree'], {
      cwd: origin,
      env: cleanEnv,
      encoding: 'utf8',
      input: `100644 blob ${blob}\troster\n`,
    }).trim()
    git(origin, 'update-ref', 'refs/fleet/_roster', git(origin, 'commit-tree', '-m', 'r', tree).trim())
    const rows = JSON.parse(doRoll(clone, ['--json']).stdout) as Array<Record<string, unknown>>
    expect(rows[0]?.aliases).toEqual(['*', '?'])
  })

  it('forgets what origin dropped: refs/fleet-seen follows origin, down to none', () => {
    const { origin, clone } = fixture()
    doPush(clone, ['one'], 'work')
    doPush(clone, ['two'], 'home')
    doRoll(clone)
    expect(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/fleet-seen/').trim().split('\n').sort()).toEqual([
      'refs/fleet-seen/home',
      'refs/fleet-seen/work',
    ])
    git(origin, 'update-ref', '-d', 'refs/fleet/home')
    doRoll(clone)
    expect(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/fleet-seen/').trim()).toBe('refs/fleet-seen/work')
    git(origin, 'update-ref', '-d', 'refs/fleet/work')
    expect(doRoll(clone).code).toBe(0)
    expect(git(clone, 'for-each-ref', 'refs/fleet-seen/').trim()).toBe('')
  })
})
