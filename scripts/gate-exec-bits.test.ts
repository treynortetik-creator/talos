// scripts/gate/exec-bits.sh against a scratch repository: a change that drops a file's executable bit fails unless a commit
// message says `Exec-bit-removed: <path>` (2026-11-16: edits over \\wsl$ dropped it twice; once on main, spend.py).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gate', 'exec-bits.sh')
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.fileMode=true', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  )
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.trim()
}
/** a repo with run.sh (100755) and notes.txt (100644) committed; returns its folder and that commit */
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'xbit-'))
  made.push(d)
  git(d, 'init', '-q')
  writeFileSync(join(d, 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(d, 'run.sh'), 0o755)
  writeFileSync(join(d, 'notes.txt'), 'x\n')
  git(d, 'add', '.')
  git(d, 'commit', '-q', '-m', 'base')
  return { d, base: git(d, 'rev-parse', 'HEAD') }
}
const check = (d: string, base: string) => spawnSync('bash', [SCRIPT, base], { cwd: d, encoding: 'utf8' })

describe('scripts/gate/exec-bits.sh', () => {
  it('passes a change that keeps every executable bit, and one that adds one', () => {
    const { d, base } = repo()
    writeFileSync(join(d, 'run.sh'), '#!/bin/sh\necho changed\n')
    chmodSync(join(d, 'notes.txt'), 0o755)
    git(d, 'commit', '-qam', 'edit')
    expect(check(d, base).status).toBe(0)
  })

  it('fails a change that drops one, naming the file and the fix', () => {
    const { d, base } = repo()
    chmodSync(join(d, 'run.sh'), 0o644)
    git(d, 'commit', '-qam', 'an edit over \\\\wsl$')
    const r = check(d, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('run.sh lost its executable bit')
    expect(r.stderr).toContain('git update-index --chmod=+x')
  })

  it('passes a drop that a commit message names exactly, and not one that names another file', () => {
    const { d, base } = repo()
    chmodSync(join(d, 'run.sh'), 0o644)
    git(d, 'commit', '-qam', 'run.sh is sourced now\n\nExec-bit-removed: other.sh')
    expect(check(d, base).status).toBe(1)
    git(d, 'commit', '-q', '--allow-empty', '-m', 'say so\n\nExec-bit-removed: run.sh')
    expect(check(d, base).status).toBe(0)
  })

  it('refuses a base that is not a commit', () => {
    const { d } = repo()
    expect(check(d, 'no-such-ref').status).toBe(2)
  })
})
