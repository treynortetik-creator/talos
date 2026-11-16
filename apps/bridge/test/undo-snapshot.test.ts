// Undo points (snapshot.ts): what a folder looked like before a turn ran. A git folder gets a commit under refs/talos/undo
// built from a temporary index, and the owner's HEAD, branch, index, stash and reflog stay byte for byte as they were.
// Any other folder (or git missing) gets a copy under the Talos home, capped in size.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { type AsyncRunOpts, type RunAsync, runCommandAsync } from '../src/run-command.ts'
import {
  IGNORED_RELIST_MS,
  type IgnoredCache,
  NAMES_DIFFER,
  PROBE_PREFIX,
  snapshotFolder,
} from '../src/undo/snapshot.ts'

const root = mkdtempSync(join(tmpdir(), 'talos-undo-snap-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (name: string) => {
  const d = join(root, `${name}-${n++}`)
  mkdirSync(d, { recursive: true })
  return d
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/** Every byte under .git except new objects and our own refs: HEAD, refs, index, stash, reflogs, config, hooks, locks. */
function gitState(repo: string): Record<string, string> {
  const g = join(repo, '.git')
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(g, p)
      if (rel === 'objects' || rel === join('refs', 'talos')) continue
      if (e.isDirectory()) walk(p)
      else out[rel] = readFileSync(p).toString('base64')
    }
  }
  walk(g)
  out['stash list'] = git(repo, 'stash', 'list')
  out.branch = git(repo, 'symbolic-ref', '-q', 'HEAD')
  return out
}

/** A repo with a commit, a stash, a staged edit, an unstaged edit, an untracked file and an ignored one. */
function busyRepo(): string {
  const r = fresh('repo')
  git(r, 'init', '-q', '-b', 'main')
  git(r, 'config', 'core.logAllRefUpdates', 'always') // a reflog for every ref, ours included, if we let one be written
  writeFileSync(join(r, '.gitignore'), '.env\n')
  writeFileSync(join(r, 'a.txt'), 'one\n')
  writeFileSync(join(r, 'b.txt'), 'bee\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'first')
  writeFileSync(join(r, 'a.txt'), 'stashed\n')
  git(r, 'stash', '-q')
  writeFileSync(join(r, 'a.txt'), 'staged\n')
  git(r, 'add', 'a.txt')
  writeFileSync(join(r, 'b.txt'), 'unstaged\n')
  writeFileSync(join(r, 'new.txt'), 'untracked\n')
  writeFileSync(join(r, '.env'), 'SECRET=1\n')
  return r
}

/** The snapshot reads global git config from HOME: point it at an empty one so the owner's settings cannot change a result. */
const home = fresh('home')
const snap = (o: Parameters<typeof snapshotFolder>[0]) =>
  snapshotFolder({ env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home }, ...o })

const showFile = (repo: string, commit: string, path: string) => git(repo, 'show', `${commit}:${path}`)
const treeFiles = (repo: string, commit: string) => git(repo, 'ls-tree', '-r', '--name-only', commit).split('\n')

describe('snapshotFolder: a git folder', () => {
  test('saves the working tree (untracked included, ignored left out) under refs/talos/undo', async () => {
    const repo = busyRepo()
    const head = git(repo, 'rev-parse', 'HEAD')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_01', undoDir: fresh('store') })
    expect(s.state).toBe('ready')
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('expected a git point')
    expect(s.ref).toBe('refs/talos/undo/main/m_01')
    expect(git(repo, 'rev-parse', s.ref)).toBe(s.commit)
    expect(git(repo, 'rev-parse', `${s.commit}^`)).toBe(head)
    expect(showFile(repo, s.commit, 'a.txt')).toBe('staged')
    expect(showFile(repo, s.commit, 'b.txt')).toBe('unstaged')
    expect(showFile(repo, s.commit, 'new.txt')).toBe('untracked')
    expect(treeFiles(repo, s.commit)).not.toContain('.env')
  })

  test('a restore probe file caught in the folder, at the top or deeper, is never in the point', async () => {
    const repo = busyRepo()
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, `${PROBE_PREFIX}1-abc`), '')
    writeFileSync(join(repo, 'sub', `${PROBE_PREFIX}2-def-moved`), '')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_01', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('expected a git point')
    const files = treeFiles(repo, s.commit)
    expect(files.filter((f) => f.includes(PROBE_PREFIX))).toEqual([])
    expect(files).toContain('new.txt') // every other untracked file is still saved
  })

  test('an ignored probe file caught in the folder is not in the record of ignored files', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, '.gitignore'), `.env\n${PROBE_PREFIX}*\n`)
    writeFileSync(join(repo, `${PROBE_PREFIX}1-abc`), '')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_01', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('expected a git point')
    expect(s.ignored).toEqual(['.env'])
  })

  test('never changes HEAD, the branch, the index, the stash or the reflog', async () => {
    const repo = busyRepo()
    const before = gitState(repo)
    const status = git(repo, 'status', '--porcelain')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_02', undoDir: fresh('store') })
    expect(s.state).toBe('ready')
    expect(gitState(repo)).toEqual(before)
    expect(git(repo, 'status', '--porcelain')).toBe(status)
    expect(existsSync(join(repo, '.git', 'logs', 'refs', 'talos'))).toBe(false)
  })

  test('a repo with no commit yet gets a commit with no parent', async () => {
    const repo = fresh('unborn')
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'x.txt'), 'x\n')
    const before = gitState(repo)
    const s = await snap({ folder: repo, thread: 't_one', turn: 'm_03', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error(`expected a git point, got ${JSON.stringify(s)}`)
    expect(git(repo, 'rev-list', '--parents', '-n', '1', s.commit)).toBe(s.commit)
    expect(showFile(repo, s.commit, 'x.txt')).toBe('x')
    expect(gitState(repo)).toEqual(before)
    expect(existsSync(join(repo, '.git', 'index'))).toBe(false)
  })

  test('a folder inside a repo saves the whole repo', async () => {
    const repo = busyRepo()
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'deep.txt'), 'deep\n')
    const s = await snap({ folder: join(repo, 'sub'), thread: 'main', turn: 'm_04', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('expected a git point')
    expect(treeFiles(repo, s.commit)).toEqual(expect.arrayContaining(['a.txt', 'new.txt', 'sub/deep.txt']))
  })

  test('a repo inside the repo is kept as its commit only (top level only)', async () => {
    const repo = busyRepo()
    const inner = join(repo, 'inner')
    mkdirSync(inner)
    git(inner, 'init', '-q', '-b', 'main')
    writeFileSync(join(inner, 'i.txt'), 'i\n')
    git(inner, 'add', '-A')
    git(inner, 'commit', '-q', '-m', 'inner')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_05', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('expected a git point')
    expect(git(repo, 'ls-tree', s.commit, 'inner')).toStartWith('160000 commit')
    expect(treeFiles(repo, s.commit)).not.toContain('inner/i.txt')
  })

  test('a tracked file that matches .gitignore is kept (the real index is the starting point)', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, 'keep.log'), 'kept\n')
    git(repo, 'add', 'keep.log')
    git(repo, 'commit', '-q', '-m', 'log')
    writeFileSync(join(repo, '.gitignore'), '.env\n*.log\n')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_20', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error(`expected a git point, got ${JSON.stringify(s)}`)
    expect(showFile(repo, s.commit, 'keep.log')).toBe('kept')
  })

  test("the owner's git hooks do not run", async () => {
    const repo = busyRepo()
    const marker = join(repo, '..', `hook-ran-${n++}`)
    for (const h of ['post-index-change', 'reference-transaction', 'pre-commit', 'post-commit']) {
      writeFileSync(join(repo, '.git', 'hooks', h), `#!/bin/sh\necho ${h} >> ${marker}\n`, { mode: 0o755 })
    }
    const before = gitState(repo)
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_21', undoDir: fresh('store') })
    expect(s.state).toBe('ready')
    expect(existsSync(marker)).toBe(false)
    expect(gitState(repo)).toEqual(before)
  })

  test('a split index is left as it was', async () => {
    const repo = busyRepo()
    git(repo, 'config', 'core.splitIndex', 'true')
    git(repo, 'update-index', '--split-index')
    const before = gitState(repo)
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_22', undoDir: fresh('store') })
    expect(s.state).toBe('ready')
    expect(gitState(repo)).toEqual(before)
  })

  test('a linked worktree saves its own files and keeps its own index', async () => {
    const repo = busyRepo()
    const wt = join(repo, '..', `wt-${n++}`)
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
    writeFileSync(join(wt, 'a.txt'), 'in the worktree\n')
    const wtIndex = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
    const before = readFileSync(wtIndex).toString('base64')
    const mainBefore = gitState(repo)
    const s = await snap({ folder: wt, thread: 'main', turn: 'm_23', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error(`expected a git point, got ${JSON.stringify(s)}`)
    expect(showFile(repo, s.commit, 'a.txt')).toBe('in the worktree')
    expect(git(repo, 'rev-parse', `${s.commit}^`)).toBe(git(wt, 'rev-parse', 'HEAD'))
    expect(readFileSync(wtIndex).toString('base64')).toBe(before)
    const mainAfter = gitState(repo)
    for (const k of Object.keys(mainAfter)) if (k.startsWith('worktrees/')) delete mainAfter[k]
    for (const k of Object.keys(mainBefore)) if (k.startsWith('worktrees/')) delete mainBefore[k]
    expect(mainAfter).toEqual(mainBefore)
  })

  test('untracked files over the size cap: too_large, and no ref or object is written', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(4096, 7))
    const objectsBefore = git(repo, 'count-objects', '-v')
    const before = gitState(repo)
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_30',
      undoDir: fresh('store'),
      limits: { bytes: 1024 },
    })
    expect(s).toMatchObject({ state: 'too_large', kind: 'git' })
    expect(git(repo, 'for-each-ref', 'refs/talos')).toBe('')
    expect(git(repo, 'count-objects', '-v')).toBe(objectsBefore)
    expect(gitState(repo)).toEqual(before)
  })

  test('the cap counts files inside an untracked folder', async () => {
    const repo = busyRepo()
    mkdirSync(join(repo, 'out', 'deep'), { recursive: true })
    writeFileSync(join(repo, 'out', 'deep', 'big.bin'), Buffer.alloc(4096, 3))
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_33',
      undoDir: fresh('store'),
      limits: { bytes: 1024 },
    })
    expect(s).toMatchObject({ state: 'too_large', kind: 'git' })
  })

  test('untracked files over the file cap: too_large', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, 'more.txt'), 'more\n')
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_31', undoDir: fresh('store'), limits: { files: 1 } })
    expect(s).toMatchObject({ state: 'too_large', kind: 'git' })
    expect(git(repo, 'for-each-ref', 'refs/talos')).toBe('')
  })

  test('the cap leaves ignored files and untouched tracked files out', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, '.env'), Buffer.alloc(4096, 1)) // ignored
    writeFileSync(join(repo, 'b.txt'), Buffer.alloc(4096, 2)) // tracked and big, but committed: unchanged
    git(repo, 'add', '-A') // b.txt's edit staged: the real index matches the folder, so nothing tracked is new to store
    git(repo, 'commit', '-q', '-m', 'all')
    writeFileSync(join(repo, 'c.txt'), 'small\n')
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_32',
      undoDir: fresh('store'),
      limits: { bytes: 1024 },
    })
    expect(s.state).toBe('ready')
  })

  test('a sparse checkout: untracked files are saved, and files outside it stay in the point', async () => {
    const repo = busyRepo()
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'c.txt'), 'c\n')
    git(repo, 'add', 'src/c.txt')
    git(repo, 'commit', '-q', '-m', 'src')
    git(repo, 'sparse-checkout', 'set', '--no-cone', '/a.txt', '/b.txt', '/.gitignore')
    const before = gitState(repo)
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_34', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error(`expected a git point, got ${JSON.stringify(s)}`)
    expect(treeFiles(repo, s.commit)).toEqual(expect.arrayContaining(['new.txt', 'src/c.txt']))
    expect(gitState(repo)).toEqual(before)
  })

  test('an edit of the same size in the same second as the index is still saved (racy git)', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, 'b.txt'), 'BEE\n') // same size as the committed 'bee'
    git(repo, 'add', 'b.txt')
    git(repo, 'commit', '-q', '-m', 'BEE')
    writeFileSync(join(repo, 'b.txt'), 'bzz\n')
    await Bun.sleep(1100)
    const s = await snap({ folder: repo, thread: 'main', turn: 'm_35', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('expected a git point')
    expect(showFile(repo, s.commit, 'b.txt')).toBe('bzz')
  })

  test('an edited tracked file counts against the cap: too_large, and nothing is written', async () => {
    const repo = busyRepo()
    const objectsBefore = git(repo, 'count-objects', '-v')
    writeFileSync(join(repo, 'b.txt'), Buffer.alloc(4096, 5)) // tracked, now big
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_36',
      undoDir: fresh('store'),
      limits: { bytes: 2048 },
    })
    expect(s).toMatchObject({ state: 'too_large', kind: 'git' })
    expect(git(repo, 'count-objects', '-v')).toBe(objectsBefore)
    expect(git(repo, 'for-each-ref', 'refs/talos')).toBe('')
  })

  for (const [what, ignore, folder] of [
    ['the folder itself', 'sub/\n', 'sub'],
    ['a parent folder', 'build/\n', 'build/x'],
  ] as const)
    test(`a folder git ignores (${what}) is copied instead, never a git point that holds none of it`, async () => {
      const repo = busyRepo()
      writeFileSync(join(repo, '.gitignore'), `.env\n${ignore}`)
      mkdirSync(join(repo, folder), { recursive: true })
      writeFileSync(join(repo, folder, 'work.txt'), 'work\n')
      const store = fresh('store')
      const s = await snap({ folder: join(repo, folder), thread: 'main', turn: 'm_37', undoDir: store })
      if (s.state !== 'ready' || s.kind !== 'copy') throw new Error(`expected a copy, got ${JSON.stringify(s)}`)
      expect(readFileSync(join(s.path, 'work.txt'), 'utf8')).toBe('work\n')
      expect(git(repo, 'for-each-ref', 'refs/talos')).toBe('')
    })

  test('a folder named like ..notes that git ignores is copied too', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, '.gitignore'), '.env\n..notes/\n')
    mkdirSync(join(repo, '..notes'))
    writeFileSync(join(repo, '..notes', 'n.txt'), 'n\n')
    const s = await snap({ folder: join(repo, '..notes'), thread: 'main', turn: 'm_38', undoDir: fresh('store') })
    expect(s).toMatchObject({ state: 'ready', kind: 'copy' })
  })

  test('a folder name that looks like git pathspec magic is taken literally', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, '.gitignore'), '.env\nsub\n')
    mkdirSync(join(repo, ':sub'))
    writeFileSync(join(repo, ':sub', 's.txt'), 's\n')
    const s = await snap({ folder: join(repo, ':sub'), thread: 'main', turn: 'm_39', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error(`expected a git point, got ${JSON.stringify(s)}`)
    expect(treeFiles(repo, s.commit)).toContain(':sub/s.txt')
  })

  test('a big tracked file that was only touched does not count against the cap', async () => {
    const repo = busyRepo()
    writeFileSync(join(repo, 'b.txt'), Buffer.alloc(4096, 6))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'big')
    await Bun.sleep(1100)
    const now = new Date()
    utimesSync(join(repo, 'b.txt'), now, now) // newer stat, same content
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_40',
      undoDir: fresh('store'),
      limits: { bytes: 2048 },
    })
    expect(s.state).toBe('ready')
  })

  test('a bad thread or turn id is refused before git runs', async () => {
    const repo = busyRepo()
    const s = await snap({ folder: repo, thread: '../x', turn: 'm_06', undoDir: fresh('store') })
    expect(s.state).toBe('not_saved')
  })

  test('an aborted snapshot reports not_saved and leaves no ref', async () => {
    const repo = busyRepo()
    const ac = new AbortController()
    ac.abort()
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_07',
      undoDir: fresh('store'),
      signal: ac.signal,
    })
    expect(s.state).toBe('not_saved')
    expect(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/talos/undo/main/m_07'], { cwd: repo }).status,
    ).not.toBe(0)
  })
})

describe('snapshotFolder: a folder that is not git', () => {
  const plain = () => {
    const d = fresh('plain')
    writeFileSync(join(d, 'a.txt'), 'a\n')
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'sub', 'b.txt'), 'b\n')
    return d
  }

  test('a restore probe file caught in the folder is never in the copy', async () => {
    const d = plain()
    writeFileSync(join(d, `${PROBE_PREFIX}1-abc-moved`), '') // the probe writes only at the top (a git toplevel)
    const s = await snap({ folder: d, thread: 'main', turn: 'm_10', undoDir: fresh('store') })
    if (s.state !== 'ready' || s.kind !== 'copy') throw new Error(`expected a copy, got ${JSON.stringify(s)}`)
    expect(readdirSync(s.path).sort()).toEqual(['a.txt', 'sub'])
  })

  test('a link to a folder holding one that cannot be read: still copied, and nothing is followed through it', async () => {
    const d = plain()
    const outside = fresh('outside')
    mkdirSync(join(outside, 'locked'))
    writeFileSync(join(outside, `${PROBE_PREFIX}9-keep`), 'not ours to remove\n')
    chmodSync(join(outside, 'locked'), 0o000)
    symlinkSync(outside, join(d, 'link'))
    try {
      const s = await snap({ folder: d, thread: 'main', turn: 'm_10', undoDir: fresh('store') })
      expect(s).toMatchObject({ state: 'ready', kind: 'copy' })
      expect(existsSync(join(outside, `${PROBE_PREFIX}9-keep`))).toBe(true)
    } finally {
      chmodSync(join(outside, 'locked'), 0o755)
    }
  })

  test("a copy that does not hold exactly the folder's names (A.txt and a.txt on a case-insensitive disk) is not saved", async () => {
    const d = plain()
    // a folder on a case-sensitive volume copied onto a case-insensitive one keeps one name of A.txt and a.txt. This
    // test disk may be either, so the folder holds A.txt and a stand-in for a.txt, and the copy loses the stand-in
    writeFileSync(join(d, 'A.txt'), 'upper\n')
    writeFileSync(join(d, 'a.txt.lower'), 'lower\n')
    const store = fresh('store')
    const collapsing: RunAsync = async (cmd, cwd, opts) => {
      const r = await runCommandAsync(cmd, cwd, opts)
      const part = cmd.at(-1) as string
      if (r.code === 0 && part.includes('.part-')) rmSync(join(part, 'a.txt.lower'))
      return r
    }
    const s = await snap({ folder: d, thread: 'main', turn: 'm_11', undoDir: store, run: collapsing })
    expect(s).toMatchObject({ state: 'not_saved', kind: 'copy', why: NAMES_DIFFER })
    expect(readdirSync(join(store, 'main'))).toEqual([]) // neither the copy nor its .part is left
  })

  test('names that cannot be compared (a folder unreadable after the copy): not saved, and no copy is left', async () => {
    const d = plain()
    const store = fresh('store')
    const locking: RunAsync = async (cmd, cwd, opts) => {
      const r = await runCommandAsync(cmd, cwd, opts)
      if (r.code === 0 && (cmd.at(-1) as string).includes('.part-')) chmodSync(join(d, 'sub'), 0o000)
      return r
    }
    try {
      const s = await snap({ folder: d, thread: 'main', turn: 'm_13', undoDir: store, run: locking })
      expect(s).toMatchObject({ state: 'not_saved', kind: 'copy' })
      expect(s.state === 'not_saved' && s.why).not.toBe(NAMES_DIFFER)
      expect(readdirSync(join(store, 'main'))).toEqual([])
    } finally {
      chmodSync(join(d, 'sub'), 0o755)
    }
  })

  test("a copy holding exactly the folder's names, byte for byte, is saved", async () => {
    const d = plain()
    writeFileSync(join(d, 'Ä.txt'), 'nfc\n')
    const s = await snap({ folder: d, thread: 'main', turn: 'm_12', undoDir: fresh('store') })
    expect(s).toMatchObject({ state: 'ready', kind: 'copy' })
  })

  test('is copied under the undo store', async () => {
    const d = plain()
    const store = fresh('store')
    const s = await snap({ folder: d, thread: 'main', turn: 'm_10', undoDir: store })
    if (s.state !== 'ready' || s.kind !== 'copy') throw new Error(`expected a copy, got ${JSON.stringify(s)}`)
    expect(s.path).toBe(join(store, 'main', 'm_10'))
    expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(s.path, 'sub', 'b.txt'), 'utf8')).toBe('b\n')
    writeFileSync(join(d, 'a.txt'), 'changed\n')
    expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('a\n') // a clone, not a link
  })

  test('git missing from PATH: the folder is treated as not git', async () => {
    const repo = busyRepo()
    const emptyBin = fresh('bin')
    const s = await snap({
      folder: repo,
      thread: 'main',
      turn: 'm_11',
      undoDir: fresh('store'),
      env: { ...process.env, PATH: emptyBin },
    })
    expect(s.kind).toBe('copy')
  })

  test('over the file cap: too_large, and nothing is left behind', async () => {
    const d = plain()
    const store = fresh('store')
    const s = await snap({ folder: d, thread: 'main', turn: 'm_12', undoDir: store, limits: { files: 1 } })
    expect(s.state).toBe('too_large')
    expect(readdirSync(store)).toEqual([])
  })

  test('over the size cap: too_large', async () => {
    const d = plain()
    writeFileSync(join(d, 'big.bin'), Buffer.alloc(4096))
    const s = await snap({
      folder: d,
      thread: 'main',
      turn: 'm_13',
      undoDir: fresh('store'),
      limits: { bytes: 1024 },
    })
    expect(s.state).toBe('too_large')
  })

  test('a folder that holds the undo store itself is not copied into itself', async () => {
    const d = plain()
    const store = join(d, 'talos-home', 'undo')
    const s = await snap({ folder: d, thread: 'main', turn: 'm_14', undoDir: store })
    expect(s.state).toBe('not_saved')
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([])
  })

  test('a folder inside the undo store is not copied into itself', async () => {
    const store = fresh('store')
    const d = join(store, 'main')
    mkdirSync(d)
    writeFileSync(join(d, 'a.txt'), 'a\n')
    const s = await snap({ folder: d, thread: 'main', turn: 'm_16', undoDir: store })
    expect(s.state).toBe('not_saved')
    expect(readdirSync(d)).toEqual(['a.txt'])
  })

  test('the copy is private to the owner', async () => {
    const d = plain()
    const store = fresh('store')
    const s = await snap({ folder: d, thread: 'main', turn: 'm_15', undoDir: store })
    expect(s.state).toBe('ready')
    expect(statSync(store).mode & 0o777).toBe(0o700)
    expect(statSync(join(store, 'main')).mode & 0o777).toBe(0o700)
  })
})

describe('snapshotFolder: a folder past the ignored cap', () => {
  /** A run where git's ignored listing reads as past the cap (stopped), counted; every other command is real. */
  const pastCap = () => {
    const c = { lists: 0, full: true }
    const run = (cmd: string[], cwd: string, opts?: AsyncRunOpts) => {
      if (!cmd.includes('-i')) return runCommandAsync(cmd, cwd, opts)
      c.lists++
      return c.full
        ? Promise.resolve({ code: 0, stdout: 'cache/a\0cache/b\0', stderr: '', stopped: true as const })
        : runCommandAsync(cmd, cwd, opts)
    }
    return { c, run }
  }
  const repo = () => {
    const r = fresh('repo')
    git(r, 'init', '-q', '-b', 'main')
    writeFileSync(join(r, '.gitignore'), 'cache/\n')
    writeFileSync(join(r, 'a.txt'), 'a\n')
    mkdirSync(join(r, 'cache'))
    writeFileSync(join(r, 'cache', 'a'), '')
    return r
  }
  const incomplete = (s: Awaited<ReturnType<typeof snapshotFolder>>) =>
    s.state === 'ready' && s.kind === 'git' ? s.ignoredIncomplete : 'no git point'

  test('the next point is incomplete without listing while the top ignored folders are unchanged', async () => {
    const r = repo()
    const { c, run } = pastCap()
    const o = { folder: r, thread: 'main', undoDir: fresh('store'), run, ignoredCache: new Map() as IgnoredCache }
    expect(incomplete(await snap({ ...o, turn: 'm_1' }))).toBe(true)
    expect(c.lists).toBe(1)
    expect(incomplete(await snap({ ...o, turn: 'm_2' }))).toBe(true)
    expect(c.lists).toBe(1) // from memory: still incomplete, never complete
  })

  test('a change to a top ignored folder, or an hour gone, lists again', async () => {
    const r = repo()
    const { c, run } = pastCap()
    let now = 1_000_000
    const o = { folder: r, thread: 'main', undoDir: fresh('store'), run, ignoredCache: new Map() as IgnoredCache }
    await snap({ ...o, turn: 'm_1', now: () => now })
    writeFileSync(join(r, 'cache', 'b'), '') // the folder's mtime moves
    await snap({ ...o, turn: 'm_2', now: () => now })
    expect(c.lists).toBe(2)
    now += IGNORED_RELIST_MS
    await snap({ ...o, turn: 'm_3', now: () => now })
    expect(c.lists).toBe(3)
    writeFileSync(join(r, 'top.log'), '') // a file right in the root moves the root's mtime
    await snap({ ...o, turn: 'm_4', now: () => now })
    expect(c.lists).toBe(4)
  })

  test('a folder past the size cap is remembered too: the next point is incomplete without listing', async () => {
    const r = repo()
    // ~160 bytes a name: the listing (~240 KB) is under the cap, the record with its stats (~290 KB) past it
    for (let i = 0; i < 1500; i++) writeFileSync(join(r, 'cache', `${'n'.repeat(150)}${i}`), '')
    let lists = 0
    const run = (cmd: string[], cwd: string, opts?: AsyncRunOpts) => {
      if (cmd.includes('-i')) lists++
      return runCommandAsync(cmd, cwd, opts)
    }
    const o = { folder: r, thread: 'main', undoDir: fresh('store'), run, ignoredCache: new Map() as IgnoredCache }
    expect(incomplete(await snap({ ...o, turn: 'm_1' }))).toBe(true)
    expect(incomplete(await snap({ ...o, turn: 'm_2' }))).toBe(true)
    expect(lists).toBe(1)
  }, 60_000)

  test('once it lists under the cap, the record is whole again', async () => {
    const r = repo()
    const { c, run } = pastCap()
    let now = 1_000_000
    const o = { folder: r, thread: 'main', undoDir: fresh('store'), run, ignoredCache: new Map() as IgnoredCache }
    await snap({ ...o, turn: 'm_1', now: () => now })
    c.full = false
    now += IGNORED_RELIST_MS
    const s = await snap({ ...o, turn: 'm_2', now: () => now })
    expect(incomplete(s)).toBeUndefined()
    if (s.state === 'ready' && s.kind === 'git') expect(s.ignored).toEqual(['cache/a'])
    await snap({ ...o, turn: 'm_3', now: () => now })
    expect(c.lists).toBe(3)
  })
})
