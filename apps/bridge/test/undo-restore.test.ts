// Restore (restore.ts): put a folder back the way an undo point saw it. Files the turn edited or deleted (with Bash or
// anything else) come back; a file that is new since the point is only LISTED, and deleted only when the owner approved
// that path. Ignored files are left alone. A git folder in the middle of a rebase, merge or cherry-pick is refused, and
// HEAD, the branch, the real index, the stash and the reflog never change.
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { type RunAsync, runCommandAsync } from '../src/run-command.ts'
import { UndoPoints } from '../src/undo/points.ts'
import { applyRestore, planRestore, probeBirthTimes, TRUST_TTL_MS, type TrustCache } from '../src/undo/restore.ts'
import { IGNORED_MAX_BYTES, IGNORED_MAX_PATHS, PROBE_PREFIX, snapshotFolder } from '../src/undo/snapshot.ts'

const root = mkdtempSync(join(tmpdir(), 'talos-undo-restore-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (name: string) => {
  const d = join(root, `${name}-${n++}`)
  mkdirSync(d, { recursive: true })
  return realpathSync(d)
}
const home = fresh('home')
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home }
const gitEnv = {
  ...env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const bash = (cwd: string, script: string) => {
  const r = spawnSync('/bin/bash', ['-c', script], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}
const read = (p: string) => readFileSync(p, 'utf8')

/**
 * Birth times trusted, whatever the file system the tests run on: the probe answers yes, in a memory of its own. The
 * tests of the probe itself use their own seams.
 */
const trusted = () => ({
  probe: async () => true,
  fsTypeOf: async () => 'apfs',
  trustCache: new Map() as TrustCache,
})

function repo(): string {
  const r = fresh('repo')
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, '.gitignore'), '.env\n')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  writeFileSync(join(r, 'b.txt'), 'b\n')
  mkdirSync(join(r, 'src'))
  writeFileSync(join(r, 'src', 'c.txt'), 'c\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  writeFileSync(join(r, 'notes.txt'), 'untracked before the turn\n')
  writeFileSync(join(r, '.env'), 'KEY=before\n')
  return r
}

/** Every byte that says where the owner's work stands (as in the snapshot tests). */
function gitState(r: string): Record<string, string> {
  const g = join(r, '.git')
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
  return out
}

async function point(folder: string, turn = 'm_1') {
  const points = new UndoPoints(new Database(':memory:'))
  const undoDir = fresh('store')
  const s = await snapshotFolder({ folder, thread: 'main', turn, undoDir, env })
  points.record({ message_id: turn, thread_id: 'main', turn, snapshot: s, at: Date.now() })
  const row = points.get(turn)
  if (row?.state !== 'ready') throw new Error(`no ready point: ${JSON.stringify(s)}`)
  await Bun.sleep(20) // a file the test writes next is born clearly after the point, on a coarse file-system clock too
  return { row, undoDir }
}

/** What a turn did with Bash: an edit, a deletion, a file and a folder of its own. */
const turn = (r: string) =>
  bash(
    r,
    'echo edited > a.txt; rm b.txt; rm -r src; echo turn > notes.txt; mkdir -p out/deep; echo made > out/deep/new.txt',
  )

describe('restore: a git folder', () => {
  test('the plan lists what comes back and what is new', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    turn(r)
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.rewrite.sort()).toEqual(['a.txt', 'notes.txt'])
    expect(plan.recreate.sort()).toEqual(['b.txt', 'src/c.txt'])
    expect(plan.extra).toEqual(['out/deep/new.txt'])
  })

  test('edits and deletions made with Bash come back; a new file survives; ignored files are left alone', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    turn(r)
    bash(r, 'echo KEY=after > .env') // an ignored file changed
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: [] })
    expect(done.ok).toBe(true)
    expect(read(join(r, 'a.txt'))).toBe('a\n')
    expect(read(join(r, 'b.txt'))).toBe('b\n')
    expect(read(join(r, 'src', 'c.txt'))).toBe('c\n')
    expect(read(join(r, 'notes.txt'))).toBe('untracked before the turn\n')
    expect(read(join(r, 'out', 'deep', 'new.txt'))).toBe('made\n')
    expect(read(join(r, '.env'))).toBe('KEY=after\n')
  })

  test('a new file goes only when the owner approved that path, and its empty folders go with it', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    turn(r)
    writeFileSync(join(r, 'keep.txt'), 'unrelated\n')
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['out/deep/new.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(done.deleted).toEqual(['out/deep/new.txt'])
    expect(existsSync(join(r, 'out'))).toBe(false)
    expect(read(join(r, 'keep.txt'))).toBe('unrelated\n')
  })

  test('an approved path that is not a new file is never deleted', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    turn(r)
    writeFileSync(join(root, 'outside.txt'), 'outside\n')
    const done = await applyRestore(row, {
      undoDir,
      env,
      deletes: ['a.txt', '.env', '../outside.txt', join(r, 'out', 'deep', 'new.txt'), 'out'],
    })
    if (!done.ok) throw new Error(done.why)
    expect(done.deleted).toEqual([])
    expect(read(join(r, 'a.txt'))).toBe('a\n')
    expect(existsSync(join(r, '.env'))).toBe(true)
    expect(existsSync(join(root, 'outside.txt'))).toBe(true)
    expect(existsSync(join(r, 'out', 'deep', 'new.txt'))).toBe(true)
  })

  test('HEAD, the branch, the index, the stash and the reflog do not change', async () => {
    const r = repo()
    git(r, 'add', 'notes.txt') // a staged file: the real index must keep it staged
    const { row, undoDir } = await point(r)
    turn(r)
    const before = gitState(r)
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['out/deep/new.txt'] })
    expect(done.ok).toBe(true)
    expect(gitState(r)).toEqual(before)
  })

  for (const [what, make] of [
    ['a merge', (g: string) => writeFileSync(join(g, 'MERGE_HEAD'), `${'a'.repeat(40)}\n`)],
    ['a rebase', (g: string) => mkdirSync(join(g, 'rebase-merge'))],
    ['a cherry-pick', (g: string) => writeFileSync(join(g, 'CHERRY_PICK_HEAD'), `${'a'.repeat(40)}\n`)],
  ] as const)
    test(`refused in the middle of ${what}, and nothing is touched`, async () => {
      const r = repo()
      const { row, undoDir } = await point(r)
      turn(r)
      make(join(r, '.git'))
      const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['out/deep/new.txt'] })
      expect(done.ok).toBe(false)
      if (!done.ok) expect(done.why).toContain(what.replace(/^an? /, ''))
      expect(read(join(r, 'a.txt'))).toBe('edited\n')
      expect(existsSync(join(r, 'out', 'deep', 'new.txt'))).toBe(true)
    })

  test('a file and a folder that swapped places: listed as blocked, and nothing of the new one is lost', async () => {
    const r = repo()
    writeFileSync(join(r, 'out'), 'a file in the point\n')
    const { row, undoDir } = await point(r)
    bash(r, 'rm out; mkdir out; echo mine > out/mine.txt; rm -r src; echo now-a-file > src')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.blocked.sort()).toEqual(['out', 'src/c.txt'])
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: [] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(r, 'out', 'mine.txt'))).toBe('mine\n')
    expect(read(join(r, 'src'))).toBe('now-a-file\n')
    expect(read(join(r, 'a.txt'))).toBe('a\n') // the rest still comes back
  })

  test('a sparse checkout: files outside it are not written out', async () => {
    const r = repo()
    git(r, 'sparse-checkout', 'set', '--no-cone', '/a.txt', '/b.txt', '/.gitignore')
    expect(existsSync(join(r, 'src', 'c.txt'))).toBe(false)
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'a.txt'), 'edited\n')
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: [] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(r, 'a.txt'))).toBe('a\n')
    expect(existsSync(join(r, 'src', 'c.txt'))).toBe(false)
  })

  test('an edit of the same size in the same second as the index is still seen (racy git)', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    git(r, 'commit', '-q', '--allow-empty', '-m', 'writes the real index') // then an edit in that same second
    writeFileSync(join(r, 'a.txt'), 'A\n') // same size as 'a'
    await Bun.sleep(1100)
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.rewrite).toContain('a.txt')
  })

  test('a folder git ignores: its point is a copy, and restore brings its files back', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nwork/\n')
    mkdirSync(join(r, 'work'))
    writeFileSync(join(r, 'work', 'draft.txt'), 'draft\n')
    const { row, undoDir } = await point(join(r, 'work'))
    expect(row.kind).toBe('copy')
    writeFileSync(join(r, 'work', 'draft.txt'), 'edited\n')
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: [] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(r, 'work', 'draft.txt'))).toBe('draft\n')
  })

  test('a new file that cannot be deleted is reported, and the files already restored are still reported back', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    turn(r)
    chmodSync(join(r, 'out', 'deep'), 0o555) // new.txt inside cannot be removed
    try {
      const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['out/deep/new.txt'] })
      if (!done.ok) throw new Error(done.why)
      expect(done.rewritten).toContain('a.txt')
      expect(done.deleted).toEqual([])
      expect(done.failed).toEqual(['out/deep/new.txt'])
      expect(read(join(r, 'a.txt'))).toBe('a\n')
    } finally {
      chmodSync(join(r, 'out', 'deep'), 0o755)
    }
  })

  test('git failing partway through writing files: the result says the restore stopped partway, never nothing changed', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    turn(r)
    const failsAfterWriting: RunAsync = async (cmd, cwd, o) => {
      const res = await runCommandAsync(cmd, cwd, o)
      return cmd.includes('checkout-index') ? { ...res, code: 1, stderr: 'error: unable to write file' } : res
    }
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: [], run: failsAfterWriting })
    expect(done).toMatchObject({ ok: false, partial: true })
    if (!done.ok) {
      expect(done.why).toContain('The restore stopped partway: check the folder')
      expect(done.mayHaveChanged?.sort()).toEqual(['a.txt', 'b.txt', 'notes.txt', 'src/c.txt'])
    }
  })

  test('an ignored .env the turn un-ignored is not new: never offered for deletion, and it survives', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, '.gitignore'), '') // the turn un-ignores .env
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual(['made.txt'])
    expect(plan.leftInPlace).toContain('.env')
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['.env', 'made.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(r, '.env'))).toBe('KEY=before\n')
    expect(done.deleted).toEqual(['made.txt'])
  })

  test('a file inside an ignored folder the turn un-ignored is left in place too', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nbuild/\n')
    mkdirSync(join(r, 'build'))
    writeFileSync(join(r, 'build', 'out.bin'), 'built\n')
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, '.gitignore'), '.env\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).not.toContain('build/out.bin')
    expect(plan.leftInPlace).toContain('build/out.bin')
  })

  test('a point with no record of what git ignored then: nothing is offered for deletion', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore({ ...row, ignored_json: null }, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.leftInPlace).toContain('made.txt')
    const done = await applyRestore(
      { ...row, ignored_json: null },
      { ...trusted(), undoDir, env, deletes: ['made.txt'] },
    )
    if (!done.ok) throw new Error(done.why)
    expect(existsSync(join(r, 'made.txt'))).toBe(true)
  })

  test('an ignored .env the turn renamed and un-ignored is not new either: its content was never saved', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    bash(r, 'mv .env .env.local')
    writeFileSync(join(r, '.gitignore'), '')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).not.toContain('.env.local')
    expect(plan.leftInPlace).toContain('.env.local')
  })

  test('a file system that keeps no birth times proves nothing new: no deletions, and the plan says so', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env, birthOf: async () => 0 })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.leftInPlace).toContain('made.txt')
    expect(plan.noDeletes).toEqual({ why: 'unprovable' })
  })

  test('a new file whose birth time is its change time (Linux: btrfs, ext4) is offered when the device is trusted', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    // birth time = change time to the ms, as a freshly made file has; the probe, not this, says whether to trust it
    const birthOf = async (p: string) => statSync(p).ctimeMs
    const plan = await planRestore(row, { ...trusted(), undoDir, env, birthOf })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual(['made.txt'])
  })

  test('each device gets its own answer: a failed one is remembered for a day, a trusted one is asked each time', async () => {
    const a = repo()
    const b = repo()
    const pa = await point(a)
    const pb = await point(b, 'm_2')
    writeFileSync(join(a, 'made.txt'), 'new\n')
    writeFileSync(join(b, 'made.txt'), 'new\n')
    const devOf = async (p: string) => (p.startsWith(a) ? 1 : 2)
    const asked: string[] = []
    const probe = async (dir: string) => {
      asked.push(dir.startsWith(a) ? 'a' : 'b')
      return dir.startsWith(a) // device 1 keeps birth times, device 2 does not
    }
    let now = 1_000_000
    const o = { env, devOf, probe, fsTypeOf: async () => 'apfs', trustCache: new Map() as TrustCache, now: () => now }
    const planA = await planRestore(pa.row, { ...o, undoDir: pa.undoDir })
    const planB = await planRestore(pb.row, { ...o, undoDir: pb.undoDir })
    if (!planA.ok || !planB.ok) throw new Error('no plan')
    expect(planA.extra).toEqual(['made.txt'])
    expect(planB.noDeletes).toEqual({ why: 'unprovable' })
    await planRestore(pa.row, { ...o, undoDir: pa.undoDir })
    await planRestore(pb.row, { ...o, undoDir: pb.undoDir })
    expect(asked).toEqual(['a', 'b', 'a']) // device 2's failure remembered; device 1 asked again (its number may be reused)
    now += TRUST_TTL_MS
    await planRestore(pb.row, { ...o, undoDir: pb.undoDir })
    expect(asked).toEqual(['a', 'b', 'a', 'b']) // a day on: asked again
  })

  test('a folder on a file system not proven to keep birth times (exfat): nothing is deleted, and the plan says which', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const o = { ...trusted(), undoDir, env, fsTypeOf: async () => 'exfat' }
    const plan = await planRestore(row, o)
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.leftInPlace).toEqual(['made.txt'])
    expect(plan.noDeletes).toEqual({ why: 'fs_unproven', fs: 'exfat' })
    const done = await applyRestore(row, { ...o, deletes: ['made.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(existsSync(join(r, 'made.txt'))).toBe(true)
  })

  test('one whose file system cannot be read fails closed: nothing is deleted', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env, fsTypeOf: async () => undefined })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'fs_unproven', fs: 'unknown' })
  })

  for (const fs of ['apfs', 'btrfs'])
    test(`on ${fs} a new file is offered, as before`, async () => {
      const r = repo()
      const { row, undoDir } = await point(r)
      writeFileSync(join(r, 'made.txt'), 'new\n')
      const plan = await planRestore(row, { ...trusted(), undoDir, env, fsTypeOf: async () => fs })
      if (!plan.ok) throw new Error(plan.why)
      expect(plan.extra).toEqual(['made.txt'])
    })

  test('a device remembered as failing the probe still names an unproven file system on it', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const trustCache = new Map() as TrustCache
    const o = { undoDir, env, trustCache, devOf: async () => 7, probe: async () => false }
    await planRestore(row, { ...o, fsTypeOf: async () => 'apfs' }) // the probe fails: remembered for device 7
    const plan = await planRestore(row, { ...o, fsTypeOf: async () => 'exfat' }) // the number now names an exfat volume
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.noDeletes).toEqual({ why: 'fs_unproven', fs: 'exfat' })
  })

  test('the file system is read for the folder itself, and before the probe: an unproven one is never probed', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const read: string[] = []
    let probed = 0
    const plan = await planRestore(row, {
      undoDir,
      env,
      trustCache: new Map(),
      fsTypeOf: async (p: string) => {
        read.push(p)
        return 'tmpfs'
      },
      probe: async () => {
        probed++
        return true
      },
    })
    if (!plan.ok) throw new Error(plan.why)
    expect(read).toEqual([realpathSync(r)])
    expect(probed).toBe(0)
    expect(plan.noDeletes).toEqual({ why: 'fs_unproven', fs: 'tmpfs' })
  })

  test('a new file on another device than the folder (a mount inside it) is no proof: nothing is offered', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    mkdirSync(join(r, 'mnt'))
    writeFileSync(join(r, 'made.txt'), 'new\n')
    writeFileSync(join(r, 'mnt', 'moved-in.txt'), 'the only copy\n')
    const devOf = async (p: string) => (p.includes('/mnt/') ? 2 : 1)
    const plan = await planRestore(row, { ...trusted(), undoDir, env, devOf })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'unprovable' })
  })

  test("a folder whose device can't be read: nothing is offered", async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const devOf = async (): Promise<number> => {
      throw new Error('EIO')
    }
    const plan = await planRestore(row, { ...trusted(), undoDir, env, devOf })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'unprovable' })
  })

  test('a probe file caught in the folder is never listed, for deletion or as left in place', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    writeFileSync(join(r, `${PROBE_PREFIX}1-abc`), '')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual(['made.txt'])
    expect(plan.leftInPlace).toEqual([])
  })

  test('the probe: a real birth time kept through a rename and apart from the change time, and nothing else', async () => {
    const dir = fresh('probe')
    // each stat answer in turn: the file as made, then as renamed
    const seq = (...xs: Array<[number, number]>) => {
      let i = 0
      return async () => {
        const [birthtimeMs, ctimeMs] = xs[i++] ?? [0, 0]
        return { birthtimeMs, ctimeMs }
      }
    }
    const waitMs = [0, 0]
    expect(await probeBirthTimes(dir, { stat: seq([5, 5], [5, 9]), waitMs })).toBe(true)
    expect(await probeBirthTimes(dir, { stat: seq([0, 5], [0, 9]), waitMs })).toBe(false) // no birth time
    expect(await probeBirthTimes(dir, { stat: seq([5, 5], [9, 9]), waitMs })).toBe(false) // the rename moved it
    expect(await probeBirthTimes(dir, { stat: seq([5, 5], [5, 5], [7, 7], [7, 7]), waitMs })).toBe(false) // a tick, twice
    expect(await probeBirthTimes(dir, { stat: seq([5, 5], [5, 5], [7, 7], [7, 8]), waitMs })).toBe(true) // then apart
    expect(readdirSync(dir)).toEqual([])
  })

  test('the real file system and probe on this machine: when they trust the folder, a new file is offered', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { undoDir, env, trustCache: new Map() })
    if (!plan.ok) throw new Error(plan.why)
    if (plan.noDeletes?.why === 'unprovable' || plan.noDeletes?.why === 'fs_unproven') {
      console.warn(
        `${tmpdir()} is not trusted here (${plan.noDeletes.why}): only the "nothing offered" side was checked`,
      )
      expect(plan.extra).toEqual([])
    } else expect(plan.extra).toEqual(['made.txt'])
  })

  test('the probe runs on the same device as the files: in the git dir when it is there, else in the folder', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const asked: string[] = []
    const probe = async (dir: string) => {
      asked.push(dir)
      return true
    }
    const gitHere = async () => 1
    const gitElsewhere = async (p: string) => (p.includes('/.git') ? 2 : 1)
    const fsTypeOf = async () => 'apfs'
    await planRestore(row, { undoDir, env, probe, fsTypeOf, devOf: gitHere, trustCache: new Map() })
    await planRestore(row, { undoDir, env, probe, fsTypeOf, devOf: gitElsewhere, trustCache: new Map() })
    expect(asked).toEqual([join(realpathSync(r), '.git'), realpathSync(r)])
  })

  test('the real probe leaves no file behind, in the git dir or the folder', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    for (const devOf of [undefined, async (p: string) => (p.includes('/.git') ? 2 : 1)]) {
      const o = { undoDir, env, fsTypeOf: async () => 'apfs', trustCache: new Map() }
      const plan = await planRestore(row, { ...o, ...(devOf ? { devOf } : {}) })
      expect(plan.ok).toBe(true)
    }
    const left = [...readdirSync(r), ...readdirSync(join(r, '.git'))].filter((n) => n.includes('talos-undo-probe'))
    expect(left).toEqual([])
  })

  test('cp .env x; rm .env: the only copy of the secrets is never offered, and nothing is deleted', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    bash(r, 'cp .env x; rm .env')
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.leftInPlace).toEqual(expect.arrayContaining(['x', 'made.txt']))
    expect(plan.noDeletes).toEqual({ why: 'ignored_gone', example: '.env' })
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['x', 'made.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(r, 'x'))).toBe('KEY=before\n')
  })

  test('a folder whose birth times cannot be trusted (the probe fails): nothing is deleted, whatever one file says', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env, probe: async () => false })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'unprovable' })
  })

  test('one file that cannot be proved new: no file is offered, so the card never says none and still fills the box', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    writeFileSync(join(r, 'odd.txt'), 'odd\n')
    const plan = await planRestore(row, {
      ...trusted(),
      undoDir,
      env,
      birthOf: async (p) => (p.endsWith('odd.txt') ? 0 : Date.now() + 5000),
    })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'unprovable' })
  })

  test('no record of what was ignored then: the plan says why nothing is offered', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore({ ...row, ignored_json: null }, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.noDeletes).toEqual({ why: 'no_record' })
  })

  test('cp build/secret.key x; rm build/secret.key inside an ignored folder: nothing is deleted', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nbuild/\n')
    mkdirSync(join(r, 'build'))
    writeFileSync(join(r, 'build', 'secret.key'), 'only copy\n')
    const { row, undoDir } = await point(r)
    bash(r, 'cp build/secret.key x; rm build/secret.key')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'ignored_gone', example: 'build/secret.key' })
  })

  test('a point holding a repo inside the repo: its files were never recorded, so nothing is deleted', async () => {
    const r = repo()
    const inner = join(r, 'sub')
    mkdirSync(inner)
    git(inner, 'init', '-q', '-b', 'main')
    writeFileSync(join(inner, 'i.txt'), 'i\n')
    git(inner, 'add', '-A')
    git(inner, 'commit', '-q', '-m', 'inner')
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'no_record' })
  })

  test('an older bare list that holds an ignored folder: incomplete, not "gone"', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nbuild/\n')
    mkdirSync(join(r, 'build'))
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const old = { ...row, ignored_json: JSON.stringify(['.env', 'build/']) } // the bare-list form: the folder's files unnamed
    const plan = await planRestore(old, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'incomplete' })
  })

  test('an older record of files with no stats: no record, so nothing is deleted', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const old = { ...row, ignored_json: JSON.stringify({ paths: ['.env'], dirs: {} }) }
    const plan = await planRestore(old, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'no_record' })
  })

  test('cp build/sub/secret x; rm build/sub/secret deep inside an ignored folder: nothing is deleted', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nbuild/\n')
    mkdirSync(join(r, 'build', 'sub'), { recursive: true })
    writeFileSync(join(r, 'build', 'sub', 'secret'), 'only copy\n')
    const { row, undoDir } = await point(r)
    bash(r, 'cp build/sub/secret x; rm build/sub/secret')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'ignored_gone', example: 'build/sub/secret' })
  })

  test('one more ignored file than the record keeps: the point is marked incomplete and offers no deletions', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\ncache/\n')
    mkdirSync(join(r, 'cache'))
    // .env is one ignored file already: cap more in cache/ makes cap + 1
    for (let i = 0; i < IGNORED_MAX_PATHS; i++) writeFileSync(join(r, 'cache', `f${i}`), '')
    const points = new UndoPoints(new Database(':memory:'))
    const undoDir = fresh('store')
    const s = await snapshotFolder({ folder: r, thread: 'main', turn: 'm_9', undoDir, env })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('no git point')
    expect(s.ignoredIncomplete).toBe(true)
    points.record({ message_id: 'm_9', thread_id: 'main', turn: 'm_9', snapshot: s, at: Date.now() })
    const row = points.get('m_9')
    if (row?.state !== 'ready') throw new Error('no point')
    await Bun.sleep(20)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'incomplete' })
  }, 120_000)

  test('cp .env .env.bak, then .env edited: the copy is the only old content, so nothing is deleted', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    bash(r, 'cp .env .env.bak; echo KEY=changed > .env')
    writeFileSync(join(r, '.gitignore'), '') // un-ignore both, so .env.bak reads as untracked
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'ignored_gone', example: '.env' })
  })

  test('an ignored repo inside the repo: its files are not listed one by one, so the record is incomplete', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nvendor/\n')
    const lib = join(r, 'vendor', 'lib')
    mkdirSync(join(lib, 'deep'), { recursive: true })
    git(lib, 'init', '-q', '-b', 'main')
    writeFileSync(join(lib, 'deep', 'key'), 'only copy\n')
    const { row, undoDir } = await point(r)
    bash(r, 'cp vendor/lib/deep/key x; rm vendor/lib/deep/key')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'incomplete' })
  })

  test('an older record with a folder entry: incomplete, never the folder-time check', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\nbuild/\n')
    mkdirSync(join(r, 'build', 'sub'), { recursive: true })
    writeFileSync(join(r, 'build', 'sub', 'secret'), 'only copy\n')
    const { row, undoDir } = await point(r)
    const mtime = (await import('node:fs')).statSync(join(r, 'build')).mtimeMs
    const old = { ...row, ignored_json: JSON.stringify({ paths: ['.env', 'build/'], dirs: { 'build/': mtime } }) }
    bash(r, 'cp build/sub/secret x; rm build/sub/secret')
    const plan = await planRestore(old, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'incomplete' })
  })

  /** Two points of the same repo in one store: m_1, then (after `between`) m_2. The m_1 row widened by m_2. */
  async function twoPoints(r: string, between: () => void, first?: (j: string | null) => string | null) {
    const points = new UndoPoints(new Database(':memory:'))
    const undoDir = fresh('store')
    const at = Date.now()
    const s1 = await snapshotFolder({ folder: r, thread: 'main', turn: 'm_1', undoDir, env })
    points.record({ message_id: 'm_1', thread_id: 'main', turn: 'm_1', snapshot: s1, at })
    await Bun.sleep(20)
    between()
    const s2 = await snapshotFolder({ folder: r, thread: 'main', turn: 'm_2', undoDir, env })
    points.record({ message_id: 'm_2', thread_id: 'main', turn: 'm_2', snapshot: s2, at: at + 1 })
    const row = points.get('m_1')
    if (!row) throw new Error('no row')
    const p1 = first ? { ...row, ignored_json: first(row.ignored_json) } : row
    return { row: points.withLaterIgnored(p1), undoDir }
  }

  test('cp .env .env.bak and an edit before a later point: the first point keeps its own stats', async () => {
    const r = repo()
    const { row, undoDir } = await twoPoints(r, () => bash(r, 'cp .env .env.bak; echo KEY=changed > .env'))
    writeFileSync(join(r, '.gitignore'), '') // un-ignore both, so .env.bak reads as untracked
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'ignored_gone', example: '.env' })
  })

  test('an older record with no stats, widened by a later point that has them: still no record', async () => {
    const r = repo()
    const old = () => JSON.stringify({ paths: ['.env'], dirs: {} })
    const { row, undoDir } = await twoPoints(r, () => bash(r, 'cp .env .env.bak; echo KEY=changed > .env'), old)
    writeFileSync(join(r, '.gitignore'), '')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.noDeletes).toEqual({ why: 'no_record' })
  })

  test('an ignored file named __proto__ or constructor is kept like any other: a new file is still offered', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\n__proto__\nconstructor\n')
    writeFileSync(join(r, '__proto__'), 'p\n')
    writeFileSync(join(r, 'constructor'), 'c\n')
    const { row, undoDir } = await point(r)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual(['made.txt'])
    bash(r, 'cp __proto__ x; rm __proto__') // and once it is gone, that is seen like any other
    const after = await planRestore(row, { ...trusted(), undoDir, env })
    if (!after.ok) throw new Error(after.why)
    expect(after.noDeletes).toEqual({ why: 'ignored_gone', example: '__proto__' })
  })

  /** A repo whose ignored cache/ holds `n` files named `name(i)`, and a point of it recorded. */
  async function ignoredFiles(n: number, name: (i: number) => string) {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\ncache/\n')
    mkdirSync(join(r, 'cache'))
    for (let i = 0; i < n; i++) writeFileSync(join(r, 'cache', name(i)), '')
    const undoDir = fresh('store')
    const s = await snapshotFolder({ folder: r, thread: 'main', turn: 'm_9', undoDir, env })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('no git point')
    const points = new UndoPoints(new Database(':memory:'))
    points.record({ message_id: 'm_9', thread_id: 'main', turn: 'm_9', snapshot: s, at: Date.now() })
    const row = points.get('m_9')
    if (!row) throw new Error('no row')
    await Bun.sleep(20)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    return { s, stored: Buffer.byteLength(row.ignored_json ?? ''), plan }
  }

  test('a record past its size cap (long names, under the count cap) is incomplete, never stored whole', async () => {
    // ~160 bytes a name: the listing (~240 KB) is under the cap, the record with its stats (~290 KB) past it, and
    // 1500 files is far under the count cap
    const { s, stored, plan } = await ignoredFiles(1500, (i) => `${'n'.repeat(150)}${i}`)
    expect(s.ignoredIncomplete).toBe(true)
    expect(stored).toBeLessThan(100)
    expect(plan.noDeletes).toEqual({ why: 'incomplete' })
  }, 120_000)

  test('the size cap counts bytes as stored: names of 3-byte characters past it are incomplete too', async () => {
    // ~120 UTF-16 units but ~275 bytes an entry: 1200 of them (~145K units, ~330 KB) is under the cap in units,
    // past it in bytes
    const { s, stored, plan } = await ignoredFiles(1200, (i) => `${'文'.repeat(80)}${i}`)
    expect(s.ignoredIncomplete).toBe(true)
    expect(stored).toBeLessThan(100)
    expect(plan.noDeletes).toEqual({ why: 'incomplete' })
  }, 120_000)

  test('a record just under its size cap is kept whole, and a new file is still offered', async () => {
    // ~230 bytes an entry: 1000 of them is ~230 KB, under the 256 KB cap
    const { s, stored, plan } = await ignoredFiles(1000, (i) => `${'n'.repeat(200)}${i}`)
    expect(s.ignoredIncomplete).toBeUndefined()
    expect(stored).toBeGreaterThan(200 * 1024)
    expect(stored).toBeLessThanOrEqual(IGNORED_MAX_BYTES)
    expect(plan.extra).toEqual(['made.txt'])
  }, 120_000)

  test('exactly as many ignored files as the record keeps: complete, and a new file is still offered', async () => {
    const r = repo()
    writeFileSync(join(r, '.gitignore'), '.env\ncache/\n')
    mkdirSync(join(r, 'cache'))
    for (let i = 0; i < IGNORED_MAX_PATHS - 1; i++) writeFileSync(join(r, 'cache', `f${i}`), '')
    const points = new UndoPoints(new Database(':memory:'))
    const undoDir = fresh('store')
    const s = await snapshotFolder({ folder: r, thread: 'main', turn: 'm_8', undoDir, env })
    if (s.state !== 'ready' || s.kind !== 'git') throw new Error('no git point')
    expect(s.ignoredIncomplete).toBeUndefined()
    expect(s.ignored?.length).toBe(IGNORED_MAX_PATHS)
    points.record({ message_id: 'm_8', thread_id: 'main', turn: 'm_8', snapshot: s, at: Date.now() })
    const row = points.get('m_8')
    if (!row) throw new Error('no row')
    expect(Buffer.byteLength(row.ignored_json ?? '')).toBeLessThanOrEqual(IGNORED_MAX_BYTES) // under both caps
    await Bun.sleep(20)
    writeFileSync(join(r, 'made.txt'), 'new\n')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual(['made.txt'])
  }, 120_000)

  test('a point whose commit is gone is refused', async () => {
    const r = repo()
    const { row, undoDir } = await point(r)
    const done = await applyRestore({ ...row, commit_id: 'f'.repeat(40) }, { ...trusted(), undoDir, env, deletes: [] })
    expect(done.ok).toBe(false)
  })
})

describe('restore: a copy', () => {
  const plain = () => {
    const d = fresh('plain')
    writeFileSync(join(d, 'a.txt'), 'a\n')
    writeFileSync(join(d, 'b.txt'), 'b\n')
    mkdirSync(join(d, 'src'))
    writeFileSync(join(d, 'src', 'c.txt'), 'c\n')
    return d
  }

  test('edits and deletions come back; a new file is listed and kept unless approved', async () => {
    const d = plain()
    const { row, undoDir } = await point(d)
    expect(row.kind).toBe('copy')
    bash(d, 'echo edited > a.txt; rm b.txt; rm -r src; mkdir out; echo made > out/new.txt; echo x > other.txt')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.rewrite).toEqual(['a.txt'])
    expect(plan.recreate.sort()).toEqual(['b.txt', 'src/c.txt'])
    expect(plan.extra.sort()).toEqual(['other.txt', 'out/new.txt'])
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['out/new.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(d, 'a.txt'))).toBe('a\n')
    expect(read(join(d, 'b.txt'))).toBe('b\n')
    expect(read(join(d, 'src', 'c.txt'))).toBe('c\n')
    expect(existsSync(join(d, 'out'))).toBe(false)
    expect(read(join(d, 'other.txt'))).toBe('x\n')
  })

  test('on a file system not proven (exfat), a copy deletes nothing either: the new files are left in place', async () => {
    const d = plain()
    const { row, undoDir } = await point(d)
    bash(d, 'echo edited > a.txt; echo x > other.txt')
    const o = { ...trusted(), undoDir, env, fsTypeOf: async () => 'exfat' }
    const plan = await planRestore(row, o)
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.rewrite).toEqual(['a.txt'])
    expect(plan.extra).toEqual([])
    expect(plan.leftInPlace).toEqual(['other.txt'])
    expect(plan.noDeletes).toEqual({ why: 'fs_unproven', fs: 'exfat' })
    const done = await applyRestore(row, { ...o, deletes: ['other.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(d, 'a.txt'))).toBe('a\n') // the files still come back
    expect(read(join(d, 'other.txt'))).toBe('x\n')
  })

  test('a new file on another device than the folder (a mount inside it): a copy deletes nothing either', async () => {
    const d = plain()
    const { row, undoDir } = await point(d)
    bash(d, 'mkdir mnt; echo x > mnt/moved-in.txt; echo y > other.txt')
    const devOf = async (p: string) => (p.includes('/mnt/') ? 2 : 1)
    const o = { ...trusted(), undoDir, env, devOf }
    const plan = await planRestore(row, o)
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.extra).toEqual([])
    expect(plan.leftInPlace.sort()).toEqual(['mnt/moved-in.txt', 'other.txt'])
    expect(plan.noDeletes).toEqual({ why: 'unprovable' })
    const done = await applyRestore(row, { ...o, deletes: ['mnt/moved-in.txt', 'other.txt'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(d, 'mnt', 'moved-in.txt'))).toBe('x\n')
  })

  test('a folder the turn swapped for a link to somewhere else is never written through', async () => {
    const d = plain()
    const { row, undoDir } = await point(d)
    const outside = fresh('outside')
    writeFileSync(join(outside, 'c.txt'), 'OUT\n')
    bash(d, `rm -r src; ln -s ${outside} src`)
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['src'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(outside, 'c.txt'))).toBe('OUT\n')
    expect(done.blocked).toEqual(['src/c.txt'])
  })

  test('an executable bit the turn added is taken back', async () => {
    const d = plain()
    const { row, undoDir } = await point(d)
    bash(d, 'chmod +x a.txt')
    const plan = await planRestore(row, { ...trusted(), undoDir, env })
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.rewrite).toEqual(['a.txt'])
    await applyRestore(row, { ...trusted(), undoDir, env, deletes: [] })
    expect(statSync(join(d, 'a.txt')).mode & 0o111).toBe(0)
  })

  test('a rename that only changed case: the approved delete does not take the restored file with it', async () => {
    const d = plain()
    writeFileSync(join(d, 'Readme.md'), 'read me\n')
    const { row, undoDir } = await point(d)
    bash(d, 'mv Readme.md tmp.md && mv tmp.md README.md')
    const caseFolds = existsSync(join(d, 'readme.md'))
    const done = await applyRestore(row, { ...trusted(), undoDir, env, deletes: ['README.md'] })
    if (!done.ok) throw new Error(done.why)
    expect(read(join(d, 'Readme.md'))).toBe('read me\n')
    if (caseFolds) expect(done.deleted).toEqual([])
  })

  test('a point that is not ready is refused', async () => {
    const d = plain()
    const { row, undoDir } = await point(d)
    const done = await applyRestore({ ...row, state: 'not_saved' }, { ...trusted(), undoDir, env, deletes: [] })
    expect(done.ok).toBe(false)
  })
})
