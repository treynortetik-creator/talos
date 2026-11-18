// The pre-push hook's personal-data scan, split from pre-push.test.ts so the two run side by side: the same tests.
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) }) // real git pushes, beside other suites on a loaded Mac
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'pp-'))
  dirs.push(T)
  const clone = join(T, 'clone')
  const log = join(T, 'calls.log')
  const bin = join(T, 'bin')
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: log,
    TALOS_CI_NESTED: '0',
    TALOS_NO_HOOKS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, env, encoding: 'utf8' })
  const ok = (cwd: string, ...a: string[]) => {
    const r = git(cwd, ...a)
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  mkdirSync(bin)
  const stub = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    fakeTool(dirname(path), basename(path), `#!/bin/sh\n${body}\n`)
  }
  // pnpm: the typecheck stand-in; biome: lives in node_modules like the real one. FAIL=<tool> turns it red.
  stub(join(bin, 'pnpm'), 'echo "pnpm $*" >> "$CALLS"; [ "$FAIL" = pnpm ] && exit 1; exit 0')
  mkdirSync(clone)
  ok(clone, 'init', '-q', '-b', 'main')
  for (const f of [
    'pre-push.sh',
    'gate.sh',
    'talos-machine.sh',
    'path-fold.sh',
    'install-hooks.sh',
    'check-no-personal.sh',
    'denylist.generic.txt',
  ]) {
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    cpSync(join(here, f), join(clone, 'scripts', f))
  }
  cpSync(join(here, 'gate'), join(clone, 'scripts/gate'), { recursive: true })
  cpSync(join(repoRoot, '.githooks'), join(clone, '.githooks'), { recursive: true })
  const put = (file: string, text = 'x\n') => {
    mkdirSync(dirname(join(clone, file)), { recursive: true })
    writeFileSync(join(clone, file), text)
  }
  // no e2e package: the gate's e2e step (gate.test.ts) would need Playwright in this clone
  for (const p of ['apps/web', 'apps/relay', 'packages/protocol']) put(`${p}/tsconfig.json`, '{}\n')
  put('apps/web/src/a.ts')
  put('docs/a.md')
  put('.gitignore', 'node_modules\n')
  ok(clone, 'add', '-A')
  ok(clone, 'commit', '-qm', 'base')
  const origin = join(T, 'origin.git')
  ok(T, 'clone', '-q', '--bare', clone, origin)
  ok(clone, 'remote', 'add', 'origin', origin)
  ok(clone, 'fetch', '-q', 'origin')
  ok(clone, 'checkout', '-qb', 'feat')
  stub(join(clone, 'node_modules/.bin/biome'), 'echo "biome $*" >> "$CALLS"; [ "$FAIL" = biome ] && exit 1; exit 0')
  const install = (e: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: clone, env: { ...env, ...e }, encoding: 'utf8' })
  const change = (files: Record<string, string>, remove: string[] = []) => {
    for (const [f, t] of Object.entries(files)) put(f, t)
    for (const f of remove) rmSync(join(clone, f))
    ok(clone, 'add', '-A')
    ok(clone, 'commit', '-qm', 'change')
  }
  const push = (e: Record<string, string> = {}, ...a: string[]) => {
    rmSync(log, { force: true })
    const r = spawnSync('git', ['push', '-q', 'origin', ...(a.length ? a : ['HEAD:refs/heads/feat'])], {
      cwd: clone,
      env: { ...env, ...e },
      encoding: 'utf8',
    })
    return { code: r.status, err: r.stderr }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  return { T, clone, origin, env, git, ok, install, change, push, calls, stub }
}

describe('pre-push hook', () => {
  // A hit already on origin/main is not this push's commit, so the scan of the pushed commits does not blame it. The gate's
  // check of the whole tree still refuses the push: main itself must be clean (CI runs that same check).
  const notBlamed = (p: { code: number | null; err: string }) => {
    expect(p.code).not.toBe(0)
    expect(p.err).not.toContain('the personal-data check failed on commit')
    expect(p.err).toContain('gate: REFUSED: personal failed')
  }
  // Sample values are assembled at run time so this file itself holds nothing the personal-data scan would flag.
  const put = (r: ReturnType<typeof setup>, f: string, t: string) => {
    mkdirSync(dirname(join(r.clone, f)), { recursive: true })
    writeFileSync(join(r.clone, f), t)
  }
  const bad = ['jo.smith', '@', 'gmail.com'].join('')

  describe('the personal-data check reads what is pushed, not the working tree', () => {
    const refused = (p: { code: number | null; err: string }, r: ReturnType<typeof setup>) => {
      expect(p.code, p.err).not.toBe(0)
      expect(p.err).toContain('check-no-personal: FAILED')
      expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'feat').status).not.toBe(0) // it did not get there
    }
    it('a value added by one commit and removed by the next in the same push is still caught', () => {
      const r = setup()
      r.install()
      r.change({ 'docs/a.md': `write to ${bad}\n` })
      r.change({ 'docs/a.md': 'clean now\n' })
      refused(r.push(), r)
    })
    it('a commit message holding a value is caught', () => {
      const r = setup()
      r.install()
      put(r, 'docs/a.md', 'fine\n')
      r.ok(r.clone, 'add', '-A')
      r.ok(r.clone, 'commit', '-qm', `notes for ${bad}`)
      refused(r.push(), r)
    })
    it('a clean copy on disk does not hide a pushed commit that has the value (edited, or deleted, on disk)', () => {
      const r = setup()
      r.install()
      r.change({ 'docs/a.md': `write to ${bad}\n` })
      writeFileSync(join(r.clone, 'docs/a.md'), 'clean on disk\n') // uncommitted edit
      refused(r.push(), r)
      rmSync(join(r.clone, 'docs/a.md')) // deleted on disk
      refused(r.push(), r)
    })
    it('pushing another branch than the checked-out one scans that branch', () => {
      const r = setup()
      r.install()
      r.ok(r.clone, 'checkout', '-qb', 'other')
      r.change({ 'docs/a.md': `write to ${bad}\n` })
      r.ok(r.clone, 'checkout', '-q', 'feat') // clean, and what is on disk
      refused(r.push({}, 'other:refs/heads/feat'), r)
    })
    it('a push the hook cannot place scans the whole tree of the tip', () => {
      const r = setup()
      r.install()
      r.change({ 'docs/a.md': `write to ${bad}\n` })
      r.ok(r.clone, 'update-ref', '-d', 'refs/remotes/origin/main')
      refused(r.push(), r)
    })
    const mainWithOldHit = (r: ReturnType<typeof setup>) => {
      // origin/main gains a commit that holds a value (someone else's earlier push); this branch is then brought up to date with it.
      r.change({ 'apps/web/src/b.ts': '1\n' })
      expect(r.push().code).toBe(0) // feat is on origin now, so later pushes of it start from its remote tip
      r.ok(r.clone, 'checkout', '-q', 'main')
      put(r, 'docs/old.md', `write to ${bad}\n`)
      r.ok(r.clone, 'add', '-A')
      r.ok(r.clone, 'commit', '-qm', 'old hit on main')
      r.ok(r.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      r.ok(r.clone, 'checkout', '-q', 'feat')
    }
    it('after a merge of main into the branch, hits already on origin/main are not blamed on the push', () => {
      const r = setup()
      r.install()
      mainWithOldHit(r)
      r.ok(r.clone, 'merge', '-q', '--no-edit', 'main')
      notBlamed(r.push())
    })
    it('after a rebase onto main, hits already on origin/main are not blamed on the push; a new one is', () => {
      const r = setup()
      r.install()
      mainWithOldHit(r)
      r.ok(r.clone, 'rebase', '-q', 'main')
      notBlamed(r.push({}, '+HEAD:refs/heads/feat'))
      r.change({ 'docs/new.md': `write to ${bad}\n` })
      const p = r.push({}, '+HEAD:refs/heads/feat')
      expect(p.code).not.toBe(0)
      expect(p.err).toContain('the personal-data check failed on commit')
    })
    it('a merge commit is scanned for the files it changes against every parent: a hand-made change in the merge is caught', () => {
      const r = setup()
      r.install()
      mainWithOldHit(r)
      r.ok(r.clone, 'merge', '-q', '--no-edit', 'main')
      put(r, 'docs/resolved.md', `write to ${bad}\n`)
      r.ok(r.clone, 'add', '-A')
      r.ok(r.clone, 'commit', '-q', '--amend', '--no-edit') // the merge commit itself now holds a new file
      const p = r.push()
      expect(p.code).not.toBe(0)
      expect(p.err).toContain('docs/resolved.md')
    })
    it('a failed file listing stops the push; it does not read as an empty change', () => {
      const r = setup()
      r.install()
      r.change({ 'docs/a.md': 'fine\n' })
      // Lose the commit's tree object: `git log` still reads the commit, but listing its files fails.
      const tree = r.ok(r.clone, 'rev-parse', 'HEAD^{tree}')
      const obj = join(r.clone, '.git/objects', tree.slice(0, 2), tree.slice(2))
      chmodSync(obj, 0o644)
      rmSync(obj)
      rmSync(join(r.clone, 'node_modules'), { recursive: true }) // so nothing after the personal check can fail by itself
      // Run the hook itself (a push would fail on the missing object by itself and hide what the hook said).
      const head = r.ok(r.clone, 'rev-parse', 'HEAD')
      const p = spawnSync('bash', ['scripts/pre-push.sh'], {
        cwd: r.clone,
        env: r.env,
        input: `refs/heads/feat ${head} refs/heads/feat ${'0'.repeat(40)}\n`,
        encoding: 'utf8',
      })
      expect(p.status).not.toBe(0)
      expect(p.stderr).toContain('could not list the files of commit')
    })
    it('Ctrl-C while the scan runs removes the temp folder holding the commit files', async () => {
      const r = setup()
      r.install()
      r.change({ 'docs/a.md': 'fine\n' })
      const tmp = join(r.T, 'tmpdir')
      mkdirSync(tmp)
      const started = join(r.T, 'scan-started')
      writeFileSync(join(r.clone, 'scripts/check-no-personal.sh'), `#!/bin/sh\ntouch "${started}"\nsleep 30\n`)
      const head = r.ok(r.clone, 'rev-parse', 'HEAD')
      const child = spawn('bash', ['scripts/pre-push.sh'], {
        cwd: r.clone,
        env: { ...r.env, TMPDIR: tmp },
        detached: true, // its own process group, like a foreground job: Ctrl-C reaches the hook and what it started
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.stdin.end(`refs/heads/feat ${head} refs/heads/feat ${'0'.repeat(40)}\n`)
      const done = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
      await vi.waitUntil(() => existsSync(started), { timeout: 30_000, interval: 25 })
      expect(readdirSync(tmp).some((n) => n.startsWith('talos-pre-push.'))).toBe(true) // the folder exists while it scans
      process.kill(-(child.pid as number), 'SIGINT')
      await done
      expect(readdirSync(tmp).filter((n) => n.startsWith('talos-pre-push.'))).toEqual([])
    })
    it('in a linked worktree (git exports GIT_DIR to the hook) the scan still reads the pushed files, not the worktree index', () => {
      const r = setup()
      r.install()
      r.ok(r.clone, 'checkout', '-q', 'main')
      const wt = join(r.T, 'wt4')
      r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other4', wt, 'HEAD')
      r.stub(join(wt, 'node_modules/.bin/biome'), 'exit 0')
      appendFileSync(join(r.clone, '.git/info/exclude'), 'docs/hidden-*.md\n') // shared by every worktree
      writeFileSync(join(wt, 'docs/hidden-n.md'), `notes ${bad}\n`)
      r.ok(wt, 'add', '-f', '-A')
      r.ok(wt, 'commit', '-qm', 'n')
      r.ok(wt, 'rm', '-q', '--cached', 'docs/hidden-n.md') // the pushed commit has the file; the worktree's index does not, and a listing that follows GIT_DIR skips it as ignored
      const p = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other4')
      expect(p.status, p.stderr).not.toBe(0)
      expect(p.stderr).toContain('check-no-personal: FAILED')
    })
    it("a worktree also picks up the main checkout's private-docs list", () => {
      const r = setup()
      r.install()
      const line = 'zq-private-doc-line-for-the-test-91'
      const doc = join(r.T, 'private.md')
      writeFileSync(doc, `# t\n\n## Appendix P\n\n- ${line}\n`)
      writeFileSync(join(r.clone, 'scripts/private-docs.txt'), `${doc}\n`)
      r.ok(r.clone, 'checkout', '-q', 'main')
      const wt = join(r.T, 'wt3')
      r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other3', wt, 'HEAD')
      expect(existsSync(join(wt, 'scripts/private-docs.txt'))).toBe(false)
      r.stub(join(wt, 'node_modules/.bin/biome'), 'exit 0')
      writeFileSync(join(wt, 'docs/n.md'), `${line}\n`)
      r.ok(wt, 'add', '-A')
      r.ok(wt, 'commit', '-qm', 'n')
      const p = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other3')
      expect(p.status).not.toBe(0)
      expect(p.stderr).toContain('[private-doc] docs/n.md')
    })
  })

  describe('the personal-data scan on awkward pushes', () => {
    // A stand-in scanner that writes down, per run, every file it was handed as "path :: first line". The gate's own run, on
    // the working tree (no folder named), is not one of the hook's commit scans and is not written down.
    const recorder = (r: ReturnType<typeof setup>) => {
      const log = join(r.T, 'scans.log')
      writeFileSync(
        join(r.clone, 'scripts/check-no-personal.sh'),
        `#!/bin/sh\n[ -n "$1" ] || exit 0\necho "== scan" >> "${log}"\ncd "$1" && find . -type f -exec sh -c 'echo "$0 :: $(head -n 1 "$0")"' {} \\; >> "${log}"\n`,
      )
      return () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .split('== scan\n')
              .slice(1)
              .map((g) => g.trim().split('\n').filter(Boolean))
          : []
    }
    it('every commit is read, however many: a value in an old commit message still refuses the push', () => {
      const r = setup() // the real scanner, so a refusal is a real one
      r.install()
      const messages = ['c0', 'c1', `write to ${bad}`, 'c3', 'c4']
      messages.forEach((m, i) => {
        put(r, `docs/n${i}.md`, `n${i}\n`)
        r.ok(r.clone, 'add', '-A')
        r.ok(r.clone, 'commit', '-qm', m)
      })
      const p = r.push({ PRE_PUSH_SCAN_COMMITS: '2' }) // the old cap is gone: a leftover setting changes nothing
      expect(p.code).not.toBe(0)
      expect(p.err).toContain('check-no-personal: FAILED')
      expect(p.err).not.toContain('not checked one by one')
      expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'feat').status).not.toBe(0) // it did not get there
    })

    it('a root file named .commit-message does not replace the commit message in the scan', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      put(r, '.commit-message', 'FILE-TEXT\n')
      r.ok(r.clone, 'add', '-A')
      r.ok(r.clone, 'commit', '-qm', 'MESSAGE-TEXT')
      const p = r.push()
      expect(p.code, p.err).toBe(0)
      const lines = scans().flat()
      expect(lines.some((l) => l.endsWith(':: MESSAGE-TEXT'))).toBe(true)
      expect(lines.some((l) => l.endsWith(':: FILE-TEXT'))).toBe(true)
    })

    it('two paths that differ only by case are never put in one folder, where a case-insensitive disk would merge them', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      // Built in the object database: on a disk that ignores case, writing both files would leave one.
      const blob = (text: string) =>
        spawnSync('git', ['hash-object', '-w', '--stdin'], {
          cwd: r.clone,
          env: r.env,
          encoding: 'utf8',
          input: text,
        }).stdout.trim()
      const indexEnv = { ...r.env, GIT_INDEX_FILE: join(r.T, 'case-index') }
      const idx = (...a: string[]) => {
        const x = spawnSync('git', ['-c', 'core.ignorecase=false', ...a], {
          cwd: r.clone,
          env: indexEnv,
          encoding: 'utf8',
        })
        if (x.status !== 0) throw new Error(`git ${a.join(' ')}: ${x.stderr}`)
        return x.stdout.trim()
      }
      idx('read-tree', 'HEAD')
      idx('update-index', '--add', '--cacheinfo', `100644,${blob('LOWER-CASE-ONE\n')},docs/Readme.md`)
      idx('update-index', '--add', '--cacheinfo', `100644,${blob('UPPER-CASE-TWO\n')},docs/README.md`)
      const commit = r.ok(r.clone, 'commit-tree', '-p', 'HEAD', '-m', 'two cases', idx('write-tree'))
      expect(r.ok(r.clone, 'ls-tree', '-r', '--name-only', commit)).toContain('docs/Readme.md')
      expect(r.ok(r.clone, 'ls-tree', '-r', '--name-only', commit)).toContain('docs/README.md')
      // that commit is not checked out, so the gate cannot run on it and the push is refused, after the scan
      const p = r.push({}, `${commit}:refs/heads/feat`)
      expect(p.code).not.toBe(0)
      expect(p.err).toContain("aren't what you are pushing")
      const runs = scans()
      expect(runs.some((run) => run.some((l) => l.endsWith(':: LOWER-CASE-ONE')))).toBe(true)
      expect(runs.some((run) => run.some((l) => l.endsWith(':: UPPER-CASE-TWO')))).toBe(true)
      for (const run of runs) {
        const names = run.map((l) => l.split(' :: ')[0]?.toLowerCase())
        expect(new Set(names).size).toBe(names.length)
      }
    })

    it('commits already on origin/main are skipped only when pushing to origin; another remote has not got them', () => {
      const r = setup()
      r.install()
      r.change({ 'docs/old.md': `write to ${bad}\n` })
      r.ok(r.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD') // that commit is on origin/main
      r.change({ 'apps/web/src/b.ts': 'y\n' })
      const fork = join(r.T, 'fork.git')
      r.ok(r.T, 'init', '-q', '--bare', fork)
      r.ok(r.clone, 'remote', 'add', 'fork', fork)
      const p = r.git(r.clone, 'push', '-q', 'fork', 'HEAD:refs/heads/feat')
      expect(p.status, p.stderr).not.toBe(0)
      expect(p.stderr).toContain('docs/old.md')
      expect(p.stderr).toContain('the personal-data check failed on commit')
      notBlamed(r.push()) // to origin, those commits are not this push's
    })
  })
})
