// scripts/export-public.sh: writes the tracked files minus a fixed EXCLUDE list into a new folder. The tests build a small real git
// repository (no fake git), run the real script against it, and read the written folder back from disk.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOT } from './size-report.ts'

const script = join(ROOT, 'scripts/export-public.sh')
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env: cleanEnv,
    encoding: 'utf8',
  })

function run(args: string[], source?: string) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...cleanEnv, ...(source ? { EXPORT_SOURCE: source } : {}) },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else out.push(p.slice(base.length + 1))
  }
  return out.sort()
}

const excludes = run(['--print-excludes']).out.split('\n').filter(Boolean)

/** A repo that tracks one file per EXCLUDE entry, a look-alike beside each, and ordinary files. */
function fixtureRepo() {
  const repo = tmp('export-src-')
  git(repo, 'init', '-q', '-b', 'main')
  const keep = [
    'README.md',
    'docs/ARCHITECTURE.md',
    'scripts/smoke-test.sh',
    'scripts/smokey/a.md',
    'docs/SPEC.md.bak',
    'docs/SPEC-NOTES.md',
  ]
  const drop = excludes.map((e) => (e.endsWith('/') ? `${e}journal.md` : e))
  for (const f of [...keep, ...drop, ...excludes.filter((e) => e.endsWith('/')).map((e) => `${e}deep/er/x.md`)]) {
    mkdirSync(dirname(join(repo, f)), { recursive: true })
    writeFileSync(join(repo, f), `content of ${f}\n`)
  }
  chmodSync(join(repo, 'scripts/smoke-test.sh'), 0o755)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fixture')
  return { repo, keep: keep.sort() }
}

describe('export-public.sh', () => {
  it('lists every path the brief says stays private', () => {
    for (const must of [
      'docs/SPEC.md',
      'docs/CI-AUDIT-2026-10-31.md',
      'docs/FOLLOWUPS.md',
      'scripts/smoke/',
      'apps/desktop/scripts/review-d0-test.sh',
      'apps/desktop/scripts/review-d0-recheck-test.sh',
      'scripts/personal-denylist.txt',
    ])
      expect(excludes, must).toContain(must)
  })

  it('writes exactly the tracked files minus the exclude list, with contents and the executable bit intact', () => {
    const { repo, keep } = fixtureRepo()
    const target = join(tmp('export-out-'), 'public')
    const r = run([target], repo)
    expect(r.code, r.out).toBe(0)
    expect(walk(target)).toEqual(keep)
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('content of README.md\n')
    expect(statSync(join(target, 'scripts/smoke-test.sh')).mode & 0o111).not.toBe(0)
    for (const e of excludes) expect(existsSync(join(target, e)), `${e} must not be exported`).toBe(false)
    expect(existsSync(join(target, '.git'))).toBe(false)
  })

  it('leaves out an untracked file and does not mind an exclude entry that was never tracked', () => {
    const { repo } = fixtureRepo()
    writeFileSync(join(repo, 'untracked-secret.txt'), 'x')
    git(repo, 'rm', '-q', '-r', '--cached', 'scripts/personal-denylist.txt')
    git(repo, 'commit', '-q', '-m', 'untrack')
    const target = join(tmp('export-out-'), 'public')
    const r = run([target], repo)
    expect(r.code, r.out).toBe(0)
    expect(existsSync(join(target, 'untracked-secret.txt'))).toBe(false)
  })

  it('fails when a setup doc names a file the export leaves out, and passes once it is reworded', () => {
    const { repo } = fixtureRepo()
    writeFileSync(join(repo, 'SETUP.md'), 'Run the list in scripts/smoke/ios.md on a phone.\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'doc points at an excluded folder')
    const bad = run([join(tmp('export-out-'), 'public')], repo)
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('SETUP.md names scripts/smoke/')
    writeFileSync(join(repo, 'SETUP.md'), 'Run the checks on a phone.\n')
    git(repo, 'commit', '-q', '-am', 'reworded')
    const good = run([join(tmp('export-out-'), 'public')], repo)
    expect(good.code, good.out).toBe(0)
  })

  it('refuses a target that already holds files, and writes nothing into it', () => {
    const { repo } = fixtureRepo()
    const target = tmp('export-out-')
    writeFileSync(join(target, 'mine.txt'), 'keep me')
    const r = run([target], repo)
    expect(r.code).toBe(2)
    expect(r.out).toContain('not empty')
    expect(readdirSync(target)).toEqual(['mine.txt'])
  })

  it('refuses a target inside the source repository', () => {
    const { repo } = fixtureRepo()
    const r = run([join(repo, 'out')], repo)
    expect(r.code).toBe(2)
    expect(r.out).toContain('outside the source repository')
  })

  it('refuses uncommitted changes to tracked files unless told otherwise', () => {
    const { repo } = fixtureRepo()
    writeFileSync(join(repo, 'README.md'), 'edited but not committed\n')
    const t1 = join(tmp('export-out-'), 'a')
    const refused = run([t1], repo)
    expect(refused.code).toBe(2)
    expect(refused.out).toContain('uncommitted')
    expect(existsSync(join(t1, 'README.md'))).toBe(false)
    const t2 = join(tmp('export-out-'), 'b')
    expect(run(['--allow-dirty', t2], repo).code).toBe(0)
    expect(readFileSync(join(t2, 'README.md'), 'utf8')).toBe('edited but not committed\n')
  })

  it('fails loudly (exit 1) when a tracked file is gone from disk, not a silent short export', () => {
    const { repo } = fixtureRepo()
    rmSync(join(repo, 'README.md'))
    const r = run(['--allow-dirty', join(tmp('export-out-'), 'public')], repo)
    expect(r.code).toBe(1)
    expect(r.out).toContain('missing on disk: README.md')
  })

  it('needs a target, rejects an unknown option and a non-repository source', () => {
    expect(run([]).code).toBe(2)
    expect(run(['--nope', 'x']).code).toBe(2)
    expect(run([join(tmp('export-out-'), 'p')], tmp('not-a-repo-')).code).toBe(2)
  })

  it('on the real repository: none of the excluded paths is exported and the README is', () => {
    const target = join(tmp('export-real-'), 'public')
    const r = run(['--allow-dirty', target])
    expect(r.code, r.out).toBe(0)
    for (const e of excludes) expect(existsSync(join(target, e)), `${e} must not be exported`).toBe(false)
    expect(existsSync(join(target, 'README.md'))).toBe(true)
    expect(existsSync(join(target, 'package.json'))).toBe(true)
  })
})
