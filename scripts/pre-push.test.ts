// The pre-push hook, for real: a temp repo, a bare origin, a real `git push`, the real hook and installer, with stand-ins for
// biome and pnpm that write down what they were asked to do. A check that only lives in a doc gets skipped, so what matters
// here is that `pnpm install` turns it on for every worktree and that a failing check really stops the push.

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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
vi.setConfig({ testTimeout: 60_000 }) // real git pushes, beside other suites on a loaded Mac
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
    TALOS_PERSONAL_SCAN: 'stop', // the hard stop going public turns on; a test that wants the warning clears it
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
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  // pnpm: the typecheck stand-in; biome: lives in node_modules like the real one. FAIL=<tool> turns it red.
  stub(join(bin, 'pnpm'), 'echo "pnpm $*" >> "$CALLS"; [ "$FAIL" = pnpm ] && exit 1; exit 0')
  mkdirSync(clone)
  ok(clone, 'init', '-q', '-b', 'main')
  for (const f of ['pre-push.sh', 'install-hooks.sh', 'check-no-personal.sh', 'denylist.generic.txt']) {
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    cpSync(join(here, f), join(clone, 'scripts', f))
  }
  cpSync(join(repoRoot, '.githooks'), join(clone, '.githooks'), { recursive: true })
  const put = (file: string, text = 'x\n') => {
    mkdirSync(dirname(join(clone, file)), { recursive: true })
    writeFileSync(join(clone, file), text)
  }
  for (const p of ['apps/web', 'apps/relay', 'packages/protocol', 'e2e']) put(`${p}/tsconfig.json`, '{}\n')
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
  it('`pnpm install` turns it on, and a failing check stops the push', () => {
    const r = setup()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    expect(r.push({}).code).toBe(0) // before the install: no hook
    expect(r.calls()).toEqual([])

    expect(r.install().status).toBe(0)
    r.change({ 'apps/web/src/b.ts': 'z\n' })
    const biome = r.push({ FAIL: 'biome' })
    expect(biome.code).not.toBe(0)
    expect(biome.err).toContain('pre-push: fix the above')
    expect(r.ok(r.origin, 'rev-parse', 'feat')).not.toBe(r.ok(r.clone, 'rev-parse', 'HEAD')) // it did not get there

    expect(r.push({ FAIL: 'pnpm' }).code).not.toBe(0)
    expect(r.push({}).code).toBe(0)
    expect(r.ok(r.origin, 'rev-parse', 'feat')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
  })

  it('a worktree added later has it too, without an install of its own', () => {
    const r = setup()
    r.install()
    const wt = join(r.T, 'wt')
    r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other', wt, 'HEAD')
    r.stub(join(wt, 'node_modules/.bin/biome'), 'echo "biome $*" >> "$CALLS"; exit 1')
    mkdirSync(join(wt, 'apps/web/src'), { recursive: true })
    writeFileSync(join(wt, 'apps/web/src/c.ts'), 'c\n')
    r.ok(wt, 'add', '-A')
    r.ok(wt, 'commit', '-qm', 'c')
    const p = r.git(join(wt, 'apps'), 'push', '-q', 'origin', 'HEAD:refs/heads/other') // from a subfolder, too
    expect(p.status).not.toBe(0)
    expect(r.calls()[0]).toContain('apps/web/src/c.ts')
  })

  // Sample values are assembled at run time so this file itself holds nothing the personal-data scan would flag.
  const put = (r: ReturnType<typeof setup>, f: string, t: string) => {
    mkdirSync(dirname(join(r.clone, f)), { recursive: true })
    writeFileSync(join(r.clone, f), t)
  }
  const bad = ['jo.smith', '@', 'gmail.com'].join('')

  it('the personal-data check runs first and stops the push, before biome or tsc are asked anything', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('check-no-personal: FAILED')
    expect(p.err).toContain('the personal-data check failed')
    expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'feat').status).not.toBe(0) // it did not get there
    // A later commit that removes the value is not enough, the bad one is still in the push: it has to be taken out.
    r.change({ 'docs/a.md': 'fixed\n' })
    expect(r.push().code).not.toBe(0)
    r.ok(r.clone, 'reset', '-q', '--hard', 'HEAD~2')
    r.change({ 'docs/a.md': 'fixed\n' })
    expect(r.push().code).toBe(0)
  })

  it('a hit already on main in a file this push does not touch does not stop it; one in a file it changes does', () => {
    const r = setup()
    r.install()
    // The hit is in the base history, as when someone else's earlier push put text there.
    r.ok(r.origin, 'update-ref', 'refs/heads/main', r.ok(r.clone, 'rev-parse', 'main'))
    r.change({ 'docs/old.md': `write to ${bad}\n` })
    r.ok(r.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD') // pretend that commit already reached origin/main
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    const clean = r.push()
    expect(clean.code, clean.err).toBe(0)
    r.change({ 'docs/old.md': `still ${bad}\n` })
    const dirty = r.push()
    expect(dirty.code).not.toBe(0)
    expect(dirty.err).toContain('docs/old.md')
  })

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
    it('after a merge of main into the branch, hits already on origin/main do not block the push', () => {
      const r = setup()
      r.install()
      mainWithOldHit(r)
      r.ok(r.clone, 'merge', '-q', '--no-edit', 'main')
      const p = r.push()
      expect(p.code, p.err).toBe(0)
    })
    it('after a rebase onto main, hits already on origin/main do not block the push; a new one still does', () => {
      const r = setup()
      r.install()
      mainWithOldHit(r)
      r.ok(r.clone, 'rebase', '-q', 'main')
      const p = r.push({}, '+HEAD:refs/heads/feat')
      expect(p.code, p.err).toBe(0)
      r.change({ 'docs/new.md': `write to ${bad}\n` })
      expect(r.push().code).not.toBe(0)
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

  it('without TALOS_PERSONAL_SCAN=stop the check warns and the push goes on, with the file named and the value not printed', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    const sha = r.ok(r.clone, 'rev-parse', 'HEAD')
    const p = r.push({ TALOS_PERSONAL_SCAN: '' })
    expect(p.code).toBe(0)
    expect(p.err).toContain('check-no-personal: FAILED')
    expect(p.err).toContain('docs/a.md:1')
    expect(p.err).toContain('warning only, the push goes on')
    expect(p.err).not.toContain('the push is stopped')
    expect(p.err).not.toContain(bad)
    expect(r.ok(r.origin, 'rev-parse', 'feat')).toBe(sha)
    expect(r.calls().join('\n')).toContain('biome') // the quick checks still ran
  })

  it('a failing biome still stops the push when the personal-data check only warned', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    expect(r.push({ TALOS_PERSONAL_SCAN: '', FAIL: 'biome' }).code).not.toBe(0)
  })

  it('a missing scanner warns too, and the push goes on', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': 'fine\n' }, ['scripts/check-no-personal.sh'])
    const p = r.push({ TALOS_PERSONAL_SCAN: '' })
    expect(p.code).toBe(0)
    expect(p.err).toContain('check-no-personal.sh is missing')
  })

  it('a push is stopped for personal data even when the lint and type checks are skipped (no node_modules)', () => {
    const r = setup()
    r.install()
    rmSync(join(r.clone, 'node_modules'), { recursive: true })
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('check-no-personal: FAILED')
    expect(p.err).toContain('skipping the lint and type checks')
    expect(p.err).not.toContain('CI still runs')
  })

  it('a missing check script stops the push; it is not read as a pass', () => {
    const r = setup()
    r.install()
    r.change({}, ['scripts/check-no-personal.sh'])
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('check-no-personal.sh is missing')
  })

  it("a worktree runs the owner's private list from the main checkout, where the gitignored file lives", () => {
    const secret = 'zq-private-marker-77'
    const r = setup()
    r.install()
    // The private list exists only in the main checkout, gitignored, like the real one.
    writeFileSync(join(r.clone, 'scripts/personal-denylist.txt'), `.*\t-\t${secret}\n`)
    r.ok(r.clone, 'checkout', '-q', 'main')
    const wt = join(r.T, 'wt2')
    r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other2', wt, 'HEAD')
    expect(existsSync(join(wt, 'scripts/personal-denylist.txt'))).toBe(false)
    r.stub(join(wt, 'node_modules/.bin/biome'), 'exit 0')
    mkdirSync(join(wt, 'docs'), { recursive: true })
    writeFileSync(join(wt, 'docs/n.md'), `notes ${secret}\n`)
    r.ok(wt, 'add', '-A')
    r.ok(wt, 'commit', '-qm', 'n')
    const p = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other2')
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('personal-denylist.txt rule line')
    expect(p.stderr).not.toContain(secret) // the hit is named by file and line, never printed
    // Without the list anywhere, the hook says only the generic rules ran, instead of implying more.
    rmSync(join(r.clone, 'scripts/personal-denylist.txt'))
    const q = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other2')
    expect(q.status).toBe(0)
    expect(q.stderr).toContain('only the generic personal-data rules ran')
  })

  it('checks the changed files that still exist, whatever their names', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/with space.ts': 'y\n', 'apps/web/src/b.ts': 'y\n' }, ['apps/web/src/a.ts'])
    expect(r.push().code).toBe(0)
    const biome = r.calls()[0] as string
    expect(biome).toContain('apps/web/src/with space.ts')
    expect(biome).toContain('apps/web/src/b.ts')
    expect(biome).not.toContain('apps/web/src/a.ts')
  })

  it('type-checks the changed package, and nothing for a docs-only push', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': 'more\n' })
    expect(r.push().code).toBe(0)
    expect(r.calls().filter((c) => c.startsWith('pnpm'))).toEqual([])

    r.change({ 'packages/protocol/src/x.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.calls().filter((c) => c.startsWith('pnpm'))).toEqual([
      'pnpm --filter=./packages/protocol -r --workspace-concurrency=0 --if-present typecheck',
    ])

    r.change({ 'plugins/talos-app-mod/hooks/a.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.calls().filter((c) => c.startsWith('pnpm'))).toEqual(['pnpm typecheck:mod'])
  })

  it('a change it cannot place in one package type-checks everything', () => {
    for (const file of ['tsconfig.base.json', 'pnpm-lock.yaml', 'something-new.yaml']) {
      const r = setup()
      r.install()
      r.change({ [file]: 'y\n' })
      expect(r.push().code).toBe(0)
      expect(r.calls()).toContain('pnpm -r --workspace-concurrency=0 --if-present typecheck')
      expect(r.calls()).toContain('pnpm typecheck:mod')
    }
  })

  it('a push it cannot place at all checks everything, it does not wave it through', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    r.ok(r.clone, 'update-ref', '-d', 'refs/remotes/origin/main') // no origin/main to diff against
    expect(r.push().code).toBe(0)
    expect(r.calls()[0]).toBe('biome check .')
    expect(r.calls()).toContain('pnpm -r --workspace-concurrency=0 --if-present typecheck')
  })

  it('a second push checks only what is new since the first', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    r.change({ 'apps/relay/src/r.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.calls()[0]).toContain('apps/relay/src/r.ts')
    expect(r.calls()[0]).not.toContain('apps/web/src/b.ts')
  })

  it('a type check cut off by the time limit still shows the errors it found first, and says the push goes on', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    r.stub(
      join(r.T, 'bin', 'pnpm'),
      'echo "src/a.ts(1,2): error TS2322: not assignable" >&2; echo "Failed" >&2; sleep 60 & echo "$!" >> "$CALLS"; wait',
    )
    const p = r.push({ PRE_PUSH_TSC_SECONDS: '1' })
    expect(p.code).toBe(0)
    expect(p.err).toContain('error TS2322: not assignable')
    expect(p.err).toContain('typecheck: skipped, over 1s')
    expect(p.err).toMatch(/push (goes|continues)|continues/)
    expect(p.err.indexOf('error TS2322')).toBeLessThan(p.err.indexOf('skipped'))
  })

  it('a type check past its budget is cut off and the push goes on; a failing one inside it still stops the push', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    // Like pnpm, it reports "Failed" when it is stopped. The owner must see one plain line instead of that.
    r.stub(
      join(r.T, 'bin', 'pnpm'),
      'trap \'echo "apps/web typecheck: Failed" >&2; exit 143\' TERM; sleep 60 & echo "$!" >> "$CALLS"; wait',
    )
    const p = r.push({ PRE_PUSH_TSC_SECONDS: '1' })
    expect(p.code).toBe(0)
    // No stopwatch. The note is printed only on the cutoff path, and the stub runs for 60 s, so it is what shows the push
    // stopped it instead of waiting it out.
    expect(p.err).toContain('typecheck: skipped, over 1s')
    expect(p.err).not.toContain('Failed')
    const slow = r.calls().at(-1) as string
    // and nothing is left running (a stopped process nobody has collected yet shows as Z)
    const state = spawnSync('ps', ['-o', 'stat=', '-p', slow], { encoding: 'utf8' }).stdout.trim()
    expect(state === '' || state.startsWith('Z')).toBe(true)

    r.change({ 'apps/web/src/c.ts': 'y\n' })
    r.stub(join(r.T, 'bin', 'pnpm'), 'exit 1')
    expect(r.push({ PRE_PUSH_TSC_SECONDS: '20' }).code).not.toBe(0)
  })

  it('a push that only deletes a file still type-checks its package', () => {
    const r = setup()
    r.install()
    r.change({}, ['apps/web/src/a.ts'])
    expect(r.push().code).toBe(0)
    expect(r.calls()).toContain('pnpm --filter=./apps/web -r --workspace-concurrency=0 --if-present typecheck')
  })

  it("files on disk that aren't what is being pushed are not passed off as checked", () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'committed\n' })
    writeFileSync(join(r.clone, 'apps/web/src/b.ts'), 'edited, not committed\n')
    const p = r.push()
    expect(p.code).toBe(0)
    expect(p.err).toContain("aren't what you are pushing")
    expect(r.calls()).toEqual([])
  })

  it('with a lockfile newer than node_modules it asks for an install instead of blaming the code', () => {
    const r = setup()
    r.install()
    writeFileSync(join(r.clone, 'node_modules/.modules.yaml'), '')
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(r.clone, 'node_modules/.modules.yaml'), old, old)
    r.change({ 'pnpm-lock.yaml': 'y\n' })
    const p = r.push({ FAIL: 'pnpm' })
    expect(p.code).toBe(0)
    expect(p.err).toContain('run pnpm install')
    expect(r.calls().filter((c) => c.startsWith('pnpm'))).toEqual([])
  })

  it('Ctrl-C stops the type check and leaves no temp file', async () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    r.stub(join(r.T, 'bin', 'pnpm'), 'echo "$$" > "$CALLS.pid"; exec sleep 60')
    const tmp = join(r.T, 'tmp')
    mkdirSync(tmp)
    const lsha = r.ok(r.clone, 'rev-parse', 'HEAD')
    const hook = spawn('bash', ['scripts/pre-push.sh'], {
      cwd: r.clone,
      env: { ...r.env, TMPDIR: tmp, PRE_PUSH_TSC_SECONDS: '60' },
    })
    hook.stdin.end(`refs/heads/feat ${lsha} refs/heads/feat ${'0'.repeat(40)}\n`)
    const code = new Promise<number | null>((res) => hook.on('exit', (c) => res(c)))
    const pidFile = `${r.env.CALLS}.pid`
    await vi.waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', {
      timeout: 30_000,
      interval: 25,
    })
    const pid = readFileSync(pidFile, 'utf8').trim()
    hook.kill('SIGINT')
    expect(await code).toBe(130)
    await vi.waitUntil(() => spawnSync('kill', ['-0', pid]).status !== 0, { timeout: 10_000, interval: 25 })
    expect(readdirSync(tmp)).toEqual([])
  })

  it('deleting a branch checks nothing', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.push({ FAIL: 'biome' }, '--delete', 'feat').code).toBe(0)
    expect(r.calls()).toEqual([])
  })

  it('with no node_modules it says so and lets the push go; CI still runs', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    rmSync(join(r.clone, 'node_modules'), { recursive: true })
    const p = r.push()
    expect(p.code).toBe(0)
    expect(p.err).toContain('no node_modules')
  })

  describe('the personal-data scan on awkward pushes', () => {
    // A stand-in scanner that writes down, per run, every file it was handed as "path :: first line".
    const recorder = (r: ReturnType<typeof setup>) => {
      const log = join(r.T, 'scans.log')
      writeFileSync(
        join(r.clone, 'scripts/check-no-personal.sh'),
        `#!/bin/sh\necho "== scan" >> "${log}"\ncd "$1" && find . -type f -exec sh -c 'echo "$0 :: $(head -n 1 "$0")"' {} \\; >> "${log}"\n`,
      )
      return () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .split('== scan\n')
              .slice(1)
              .map((g) => g.trim().split('\n').filter(Boolean))
          : []
    }
    const warnOnly = { TALOS_PERSONAL_SCAN: 'warn' }

    // Which of the commit-file names n0..n4 each scan was handed, in order.
    const nFiles = (runs: string[][]) =>
      runs.map((run) =>
        run
          .map((l) => /docs\/(n\d)\.md/.exec(l)?.[1])
          .filter(Boolean)
          .sort()
          .join(','),
      )

    it('a push of more commits than the limit warns what it skips, scans the newest ones and the tip tree, and still goes', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      for (let i = 0; i < 5; i++) r.change({ [`docs/n${i}.md`]: `n${i}\n` })
      const p = r.push({ ...warnOnly, PRE_PUSH_SCAN_COMMITS: '2' })
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain('5 commits')
      expect(p.err).toContain('not checked one by one')
      // The whole tree of the tip (every file), then the newest two commits one by one (their own file each), not the oldest.
      expect(nFiles(scans()).sort()).toEqual(['n0,n1,n2,n3,n4', 'n3', 'n4'])
    })

    it('in stop mode the limit does not apply: a value in an old commit message still refuses the push', () => {
      const r = setup() // the real scanner, so a refusal is a real one
      r.install()
      const messages = ['c0', 'c1', `write to ${bad}`, 'c3', 'c4'] // the third is outside the newest two
      messages.forEach((m, i) => {
        put(r, `docs/n${i}.md`, `n${i}\n`)
        r.ok(r.clone, 'add', '-A')
        r.ok(r.clone, 'commit', '-qm', m)
      })
      const p = r.push({ PRE_PUSH_SCAN_COMMITS: '2' }) // stop mode is the test default
      expect(p.code).not.toBe(0)
      expect(p.err).toContain('check-no-personal: FAILED')
      expect(p.err).not.toContain('not checked one by one')
      expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'feat').status).not.toBe(0) // it did not get there
    })

    // A bad limit means no cap. Few commits are enough to see it is not a small cap or an error; 101 are needed to see it is
    // not the default of 100, which is tried once below.
    it('a limit that is not a plain number is ignored: every commit is scanned and there is no warning', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      for (let i = 0; i < 9; i++) r.ok(r.clone, 'commit', '--allow-empty', '-qm', `c${i}`)
      let n = 0
      // 18446744073709551617 is 2^64 + 1: counted as a number it would wrap round to a limit of 1.
      for (const v of ['abc', '', '-1', '0', '18446744073709551617']) {
        const before = scans().length
        const p = r.push({ ...warnOnly, PRE_PUSH_SCAN_COMMITS: v }, `HEAD:refs/heads/f${n++}`)
        expect(p.code, p.err).toBe(0)
        expect(p.err, `value "${v}"`).not.toContain('not checked one by one')
        expect(scans().length - before, `value "${v}"`).toBe(9)
      }
    })

    it('08 is a limit of eight, not an error', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      for (let i = 0; i < 9; i++) r.ok(r.clone, 'commit', '--allow-empty', '-qm', `c${i}`)
      const p = r.push({ ...warnOnly, PRE_PUSH_SCAN_COMMITS: '08' })
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain('more than the 8 ')
      expect(scans()).toHaveLength(9) // the newest eight and the tip tree
    })

    it('a limit that is not a plain number does not fall back to the default of 100', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      for (let i = 0; i < 101; i++) r.ok(r.clone, 'commit', '--allow-empty', '-qm', `c${i}`)
      const p = r.push({ ...warnOnly, PRE_PUSH_SCAN_COMMITS: 'abc' })
      expect(p.code, p.err).toBe(0)
      expect(p.err).not.toContain('not checked one by one')
      expect(scans()).toHaveLength(101)
    })

    it('a push within the limit is scanned commit by commit with no warning', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      for (let i = 0; i < 3; i++) r.change({ [`docs/n${i}.md`]: `n${i}\n` })
      const p = r.push({ ...warnOnly, PRE_PUSH_SCAN_COMMITS: '3' })
      expect(p.code, p.err).toBe(0)
      expect(p.err).not.toContain('not checked one by one')
      expect(scans()).toHaveLength(3)
    })

    it('a root file named .commit-message does not replace the commit message in the scan', () => {
      const r = setup()
      r.install()
      const scans = recorder(r)
      put(r, '.commit-message', 'FILE-TEXT\n')
      r.ok(r.clone, 'add', '-A')
      r.ok(r.clone, 'commit', '-qm', 'MESSAGE-TEXT')
      const p = r.push(warnOnly)
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
      const p = r.push(warnOnly, `${commit}:refs/heads/feat`)
      expect(p.code, p.err).toBe(0)
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
      expect(r.push().code).toBe(0) // to origin, the same commits are fine
    })
  })
})

describe('install-hooks', () => {
  it('leaves CI, a checkout that opted out and a hooksPath someone set alone', () => {
    const hooksPath = (r: ReturnType<typeof setup>) => r.git(r.clone, 'config', '--get', 'core.hooksPath').stdout.trim()
    const r = setup()
    r.install({ TALOS_CI_NESTED: '1' })
    expect(hooksPath(r)).toBe('')
    r.install({ TALOS_NO_HOOKS: '1' })
    expect(hooksPath(r)).toBe('')
    r.ok(r.clone, 'config', 'core.hooksPath', 'mine')
    r.install()
    expect(hooksPath(r)).toBe('mine')
  })

  it('stays off for good with git config talos.nohooks, across later installs', () => {
    const r = setup()
    r.ok(r.clone, 'config', 'talos.nohooks', 'true')
    r.install()
    expect(r.git(r.clone, 'config', '--get', 'core.hooksPath').stdout.trim()).toBe('')
  })

  it('a copy unpacked inside another repo leaves that repo alone', () => {
    const r = setup()
    const outer = join(r.T, 'dotfiles')
    mkdirSync(join(outer, 'talos/scripts'), { recursive: true })
    r.ok(outer, 'init', '-q')
    cpSync(join(here, 'install-hooks.sh'), join(outer, 'talos/scripts/install-hooks.sh'))
    const i = spawnSync('bash', ['scripts/install-hooks.sh'], {
      cwd: join(outer, 'talos'),
      env: r.env,
      encoding: 'utf8',
    })
    expect(i.status).toBe(0)
    expect(r.git(outer, 'config', '--get', 'core.hooksPath').stdout.trim()).toBe('')
  })

  it('is quiet outside a git checkout: a Docker build has no .git and no scripts/', () => {
    const d = mkdtempSync(join(tmpdir(), 'pp-'))
    dirs.push(d)
    const r = spawnSync('bash', [join(here, 'install-hooks.sh')], {
      cwd: d,
      env: { ...process.env, TALOS_CI_NESTED: '0', TALOS_NO_HOOKS: '0' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: { prepare: string } }
    expect(spawnSync('sh', ['-c', pkg.scripts.prepare], { cwd: d }).status).toBe(0)
  })
})
