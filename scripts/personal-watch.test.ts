// scripts/personal-watch.sh against a scratch "remote" with a made-up private list (personal-watch-fixture.ts).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Env,
  FAKE,
  hits,
  noValue,
  RULE,
  s12,
  setup,
  snapshot,
  stateText,
  tmpEmpty,
  watch,
} from './personal-watch-fixture'

const log = (e: Env) => readFileSync(join(e.cache, 'hits.log'), 'utf8')
const ps = () => execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' })

function startWatch(e: Env, interval: string, env: Record<string, string> = {}) {
  const child = spawn(
    'bash',
    [join(e.owner, 'scripts', 'personal-watch.sh'), '--rules', e.rules, '--remote', e.remote, '--interval', interval],
    { env: { ...e.env, ...env }, cwd: e.root },
  )
  const state = { out: '', code: undefined as number | null | undefined }
  child.stdout.on('data', (d) => {
    state.out += d
  })
  child.on('exit', (c) => {
    state.code = c
  })
  return { child, state }
}
async function until(f: () => boolean, ms = 20_000) {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  return f()
}

describe('personal-watch.sh', () => {
  it('reports each new hit on main and on branches once per ref, with file:line, no value and no ref name', () => {
    const e = setup()
    const before = snapshot(e)
    const first = watch(e)
    expect(first.code).toBe(0)
    expect(hits(first.out)).toEqual([])

    // a leak on main, then a clean commit on top: both new first-parent commits are checked
    const leak = e.commit({ 'src/leak.ts': `const x = 1\nconst org = '${FAKE}'\n` })
    e.commit({ 'src/ok.ts': 'export const ok = true\n' })
    e.push()
    const r1 = watch(e)
    expect(r1.code).toBe(1)
    expect(hits(r1.out)).toEqual([`personal-watch: HIT main@${s12(leak)} ${s12(leak)} src/leak.ts:2 ${RULE}`])
    expect(log(e)).toMatch(
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ main@${s12(leak)} ${s12(leak)} src/leak\\.ts:2 \\[personal-denylist\\.txt rule line 2\\]\\n$`,
      ),
    )
    noValue(r1.out + r1.err + log(e))

    // nothing new: nothing repeated; a clean push: silent
    expect(watch(e).out).not.toContain('HIT')
    e.commit({ 'src/ok2.ts': 'export const ok2 = true\n' })
    e.push()
    const r3 = watch(e)
    expect(r3.code).toBe(0)
    expect(r3.out).not.toContain('HIT')

    // a new handoff branch with a leak, then the same branch moved with a second one: both found, by sha, never by name
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/zebratoken')
    const h1 = e.commit({ 'docs/n.md': `# notes\n${FAKE}\n` })
    e.push('handoff/zebratoken')
    const r4 = watch(e)
    expect(hits(r4.out)).toEqual([`personal-watch: HIT branch@${s12(h1)} ${s12(h1)} docs/n.md:2 ${RULE}`])
    const h2 = e.commit({ 'docs/m.md': `a\nb\nc\n${FAKE}\n` })
    e.push('handoff/zebratoken')
    const r5 = watch(e)
    expect(hits(r5.out)).toEqual([`personal-watch: HIT branch@${s12(h2)} ${s12(h2)} docs/m.md:4 ${RULE}`])
    expect(watch(e).out).not.toContain('HIT')

    // R1-6: the branch lands on main as it is: the same commits, but another ref, so main reports them too, once
    e.push('handoff/zebratoken:main')
    const r6 = watch(e)
    expect(hits(r6.out).sort()).toEqual(
      [
        `personal-watch: HIT main@${s12(h1)} ${s12(h1)} docs/n.md:2 ${RULE}`,
        `personal-watch: HIT main@${s12(h2)} ${s12(h2)} docs/m.md:4 ${RULE}`,
      ].sort(),
    )
    expect(watch(e).out).not.toContain('HIT')

    // R1-3: no ref name in any output or state file
    const all = r1.out + r4.out + r5.out + r6.out + stateText(e)
    expect(all).not.toContain('zebratoken')
    expect(all).not.toContain('handoff')

    // the owner's checkout was never touched, and no temp folder is left
    expect(snapshot(e)).toEqual(before)
    tmpEmpty(e)
  })

  it('shows a branch whose own name carries a value by its sha only', () => {
    const e = setup()
    watch(e)
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/quillmoor-ventures')
    const sha = e.commit({ 'src/d.ts': 'export const d = 4\n' })
    e.push('handoff/quillmoor-ventures')
    const r = watch(e)
    expect(hits(r.out)).toEqual([`personal-watch: HIT branch@${s12(sha)} ${s12(sha)} .ref-name:1 ${RULE}`])
    noValue(r.out + stateText(e))
  })

  // R1-1 through the watch: one push that adds and removes, and a --no-ff merge of such a branch
  it('finds a value that a later commit of the same push removed, and one inside a merged branch', () => {
    const e = setup()
    watch(e)
    const add = e.commit({ 'a.md': `${FAKE}\n` })
    e.commit({}, 'remove', ['a.md'])
    e.push()
    expect(hits(watch(e).out)).toEqual([`personal-watch: HIT main@${s12(add)} ${s12(add)} a.md:1 ${RULE}`])
    e.git(e.dev, 'checkout', '-q', '-b', 'side')
    const add2 = e.commit({ 'b.md': `x\n${FAKE}\n` })
    e.commit({}, 'remove', ['b.md'])
    e.git(e.dev, 'checkout', '-q', 'main')
    e.git(e.dev, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const merge = e.git(e.dev, 'rev-parse', 'HEAD')
    e.push()
    expect(hits(watch(e).out)).toEqual([`personal-watch: HIT main@${s12(merge)} ${s12(add2)} b.md:2 ${RULE}`])
  })

  // R1-2: a main commit whose check fails never pins the mark and never goes quiet
  it('keeps a failed main commit on an unchecked list, checks later commits, says so every pass and exits 2', () => {
    const e = setup()
    watch(e)
    e.git(e.dev, 'checkout', '-q', '-b', 'side')
    e.commit({ 's1.md': '1\n' })
    e.commit({ 's2.md': '2\n' })
    const inside = e.commit({ 's3.md': `${FAKE}\n` })
    e.git(e.dev, 'checkout', '-q', 'main')
    e.git(e.dev, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const merge = e.git(e.dev, 'rev-parse', 'HEAD')
    const later = e.commit({ 'later.md': `${FAKE}\n` })
    e.push()
    const tight = { CHECK_MAX_COMMITS: '2', PERSONAL_WATCH_ERROR_EVERY: '0' }
    const r1 = watch(e, [], tight)
    expect(r1.code).toBe(2)
    expect(r1.out).toContain(
      `personal-watch: ERROR the check of main@${s12(merge)} failed (exit 2: check-ref-personal: more than 2 commits in the range; give a base)`,
    )
    expect(hits(r1.out)).toEqual([`personal-watch: HIT main@${s12(later)} ${s12(later)} later.md:1 ${RULE}`])
    // again: the error is said again (ERROR_EVERY 0), the later hit is not repeated
    const r2 = watch(e, [], tight)
    expect(r2.code).toBe(2)
    expect(r2.out).toContain(`ERROR the check of main@${s12(merge)} failed`)
    expect(hits(r2.out)).toEqual([])
    // inside the rate limit it is quiet on screen, but the exit still says something is unchecked
    const r3 = watch(e, [], { CHECK_MAX_COMMITS: '2' })
    expect(r3.code).toBe(2)
    expect(r3.out).not.toContain('ERROR')
    // fixed: the commit is checked, its hit reported, and it leaves the list
    const r4 = watch(e)
    expect(r4.code).toBe(1)
    expect(hits(r4.out)).toEqual([`personal-watch: HIT main@${s12(merge)} ${s12(inside)} s3.md:1 ${RULE}`])
    expect(readFileSync(join(e.cache, 'unchecked'), 'utf8')).toBe('')
    expect(watch(e).code).toBe(0)
  })

  // R3-3: a check that fails says why, from the checker's own value-free note
  it("says why a check failed, in the checker's own words", () => {
    const e = setup()
    watch(e)
    const blob = e.gitIn(e.dev, 'x\n', 'hash-object', '-w', '--stdin')
    const tree = e.gitIn(e.dev, `100644 blob ${blob}\t..\n`, 'mktree')
    const odd = e.gitIn(e.dev, 'odd', 'commit-tree', tree, '-p', 'HEAD')
    e.git(e.dev, 'push', '-q', 'origin', `${odd}:refs/heads/handoff/odd`)
    const r = watch(e)
    expect(r.code).toBe(2)
    expect(r.out).toContain(
      `personal-watch: ERROR the check of branch@${s12(odd)} failed (exit 2: check-ref-personal: could not copy commit ${s12(odd)} out of git; ${s12(odd)} a path that is absolute or has an empty, "." or ".." part: the commit is refused, nothing in it is known clean); it runs again next pass`,
    )
  })

  // R4-5: --scan-main says why too, from the scanner's own words
  it("--scan-main says why a check failed, in the scanner's own words", () => {
    const e = setup()
    const bad = join(e.root, 'bad')
    mkdirSync(bad)
    writeFileSync(join(bad, 'personal-denylist.txt'), '.\t-\tzo[ëé] x\n')
    const r = spawnSync(
      'bash',
      [
        join(e.owner, 'scripts', 'personal-watch.sh'),
        '--rules',
        join(bad, 'personal-denylist.txt'),
        '--remote',
        e.remote,
        '--scan-main',
      ],
      { cwd: e.root, env: e.env, encoding: 'utf8' },
    )
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(
      /personal-watch: ERROR the check of main@[0-9a-f]{12} failed \(exit 2: check-no-personal: personal-denylist\.txt line 1 has a bracket set with non-ASCII letters/,
    )
    expect(r.stdout).not.toContain('zo[')
  })

  // R1-7: tags
  it('checks new tags: the commits they bring, an annotated message, and the name, all by sha', () => {
    const e = setup()
    watch(e)
    e.git(e.dev, 'checkout', '-q', '-b', 'tmp')
    const c = e.commit({ 't.md': `${FAKE}\n` })
    e.git(e.dev, 'tag', 'light')
    e.git(e.dev, 'checkout', '-q', 'main')
    e.git(e.dev, 'tag', '-a', 'rel', '-m', `notes\n\nfor ${FAKE}`)
    e.git(e.dev, 'tag', 'quillmoor-ventures-1')
    e.git(e.dev, 'push', '-q', 'origin', 'light', 'rel', 'quillmoor-ventures-1')
    const tag = e.git(e.dev, 'rev-parse', 'rel')
    const head = e.git(e.dev, 'rev-parse', 'HEAD')
    const r = watch(e)
    expect(r.code).toBe(1)
    expect(hits(r.out).sort()).toEqual(
      [
        `personal-watch: HIT tag@${s12(c)} ${s12(c)} t.md:1 ${RULE}`,
        `personal-watch: HIT tag@${s12(tag)} ${s12(tag)} .tag-message.${s12(tag)}:3 ${RULE}`,
        `personal-watch: HIT tag@${s12(head)} ${s12(head)} .ref-name:1 ${RULE}`,
      ].sort(),
    )
    noValue(r.out + stateText(e))
    expect(stateText(e)).not.toContain('light')
  })

  it('records branches already there on the first pass, and checks them with --scan-existing', () => {
    const e = setup()
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/old')
    const sha = e.commit({ 'old.md': `${FAKE}\n` })
    e.push('handoff/old')
    const quiet = watch(e)
    expect(quiet.code).toBe(0)
    expect(quiet.out).not.toContain('HIT')
    const scan = watch(e, ['--home', join(e.root, 'other-cache'), '--scan-existing'])
    expect(scan.code).toBe(1)
    expect(hits(scan.out)).toEqual([`personal-watch: HIT branch@${s12(sha)} ${s12(sha)} old.md:1 ${RULE}`])
  })

  it('--scan-main reports every hit in the main tree and a count, even while a watch holds the cache', async () => {
    const e = setup()
    const old = e.commit({ 'deep/old.md': `x\n${FAKE}\n` })
    e.push()
    const r = watch(e, ['--scan-main'])
    expect(r.code).toBe(1)
    expect(hits(r.out)).toEqual([`personal-watch: HIT main@${s12(old)} ${s12(old)} deep/old.md:2 ${RULE}`])
    expect(r.out).toContain(`personal-watch: main@${s12(old)}: 1 hit(s), 0 note(s)`)
    e.commit({}, 'clean', ['deep/old.md'])
    e.push()
    const w = startWatch(e, '3600')
    try {
      expect(await until(() => w.state.out.includes('first pass'))).toBe(true)
      const clean = watch(e, ['--scan-main'])
      expect(clean.code).toBe(0)
      expect(clean.out).toContain('holds the cache')
      expect(clean.out).toMatch(/main@[0-9a-f]{12}: 0 hit\(s\), 0 note\(s\)/)
    } finally {
      w.child.kill('SIGTERM')
      await until(() => w.state.code !== undefined)
    }
  })

  it('refuses to run without the private list, and says so', () => {
    const e = setup()
    const r = spawnSync('bash', [join(e.owner, 'scripts', 'personal-watch.sh'), '--remote', e.remote, '--once'], {
      env: e.env,
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('ERROR no private list')
  })

  it("reports a failed fetch as an error, never as a clean pass, and never prints git's message", () => {
    const e = setup()
    expect(watch(e).code).toBe(0)
    execFileSync('mv', [e.remote, `${e.remote}.gone`])
    const bad = watch(e)
    expect(bad.code).toBe(2)
    expect(bad.out).toContain('ERROR the fetch failed')
    expect(bad.out + bad.err).not.toContain('remote.git')
    expect(readFileSync(join(e.cache, 'fetch.err'), 'utf8')).toContain('remote.git')
    // git's message names the remote: owner-only, both files
    expect(statSync(join(e.cache, 'fetch.err')).mode & 0o777).toBe(0o600)
    expect(statSync(join(e.cache, 'clone.err')).mode & 0o777).toBe(0o600)
  })

  it('makes error files an older watch left readable private again', () => {
    const e = setup()
    mkdirSync(e.cache, { recursive: true })
    writeFileSync(join(e.cache, 'fetch.err'), 'old\n', { mode: 0o644 })
    expect(watch(e).code).toBe(0)
    expect(statSync(join(e.cache, 'fetch.err')).mode & 0o777).toBe(0o600)
    expect(statSync(join(e.cache, 'hits.log'), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('stops a fetch that hangs, with its whole process group, and says so', () => {
    const e = setup()
    expect(watch(e).code).toBe(0)
    e.git(join(e.cache, 'repo'), 'config', 'remote.origin.url', 'ssh://example.invalid/x.git')
    const marker = String(4000 + Math.floor(Math.random() * 900))
    const t0 = Date.now()
    const r = watch(e, [], { PERSONAL_WATCH_FETCH_TIMEOUT: '1', GIT_SSH_COMMAND: `sleep ${marker}; :` })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(r.code).toBe(2)
    expect(r.out).toContain('ERROR the fetch timed out after 1s')
    expect(ps()).not.toMatch(new RegExp(`sleep ${marker}`))
  })

  it('stops at once on SIGTERM, leaving no process behind and no lock', async () => {
    const e = setup()
    const w = startWatch(e, '3600')
    expect(await until(() => w.state.out.includes('first pass'))).toBe(true)
    w.child.kill('SIGTERM')
    expect(await until(() => w.state.code !== undefined, 5000)).toBe(true)
    expect(w.state.code).toBe(0)
    expect(w.state.out).toContain('personal-watch: stopped')
    expect(ps()).not.toContain(e.root)
    expect(existsSync(join(e.cache, 'lock'))).toBe(false)
  })

  // R1-8: the lock
  describe('the lock', () => {
    const lock = (e: Env) => join(e.cache, 'lock')
    const deadPid = () => {
      const p = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' })
      return p.stdout.trim()
    }

    it('refuses while a live process holds it, and takes it over from a dead one', () => {
      const e = setup()
      mkdirSync(lock(e), { recursive: true })
      writeFileSync(join(lock(e), 'pid'), `${process.pid}\n`)
      const busy = watch(e)
      expect(busy.code).toBe(2)
      expect(busy.out).toContain(`another watch (pid ${process.pid})`)
      writeFileSync(join(lock(e), 'pid'), `${deadPid()}\n`)
      const r = watch(e)
      expect(r.code).toBe(0)
      expect(r.out).toContain('first pass')
      expect(existsSync(lock(e))).toBe(false)
    })

    it('treats a lock with no pid as being taken, until it is older than the stale age', () => {
      const e = setup()
      mkdirSync(lock(e), { recursive: true })
      const young = watch(e)
      expect(young.code).toBe(2)
      expect(young.out).toContain('another watch (a watch that is starting)')
      const old = new Date(Date.now() - 11 * 60_000)
      utimesSync(lock(e), old, old)
      const r = watch(e)
      expect(r.code).toBe(0)
      expect(existsSync(lock(e))).toBe(false)
    })

    it('does not remove a fresh lock another watch made between judging the old one stale and moving it', () => {
      const e = setup()
      mkdirSync(lock(e), { recursive: true })
      writeFileSync(join(lock(e), 'pid'), `${deadPid()}\n`)
      // in the gap: the dead lock is taken over by someone else, who has made the folder but not yet written a pid
      const gap = join(e.root, 'gap.sh')
      writeFileSync(gap, 'rm -rf "$1" && mkdir "$1"\n')
      const r = watch(e, [], { PERSONAL_WATCH_TEST_LOCK_GAP: gap })
      expect(r.code).toBe(2)
      expect(r.out).toContain('another watch (a watch that is starting)')
      expect(existsSync(lock(e))).toBe(true)
      expect(existsSync(join(lock(e), 'pid'))).toBe(false)
    })

    it('lets exactly one of two watches started at once run', async () => {
      const e = setup()
      watch(e) // the cache clone, made once
      const a = startWatch(e, '3600')
      const b = startWatch(e, '3600')
      try {
        expect(await until(() => [a, b].some((w) => w.state.code !== undefined))).toBe(true)
        await new Promise((r) => setTimeout(r, 500))
        const exited = [a, b].filter((w) => w.state.code !== undefined)
        expect(exited.length).toBe(1)
        expect(exited[0]?.state.code).toBe(2)
        expect(exited[0]?.state.out).toContain('another watch')
      } finally {
        for (const w of [a, b]) if (w.state.code === undefined) w.child.kill('SIGTERM')
        await until(() => a.state.code !== undefined && b.state.code !== undefined)
      }
    })
  })
})
