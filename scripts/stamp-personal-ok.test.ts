// scripts/stamp-personal-ok.sh against a scratch bare remote and clone. The scan is a stub (STAMP_SCAN_CMD), so no private list is read.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { here, setup } from './personal-watch-fixture'

const GATE_PUSH = join(here, 'gate-push.sh')

type E = ReturnType<typeof setup>

const STUB_LIST = '# stub private list for the test\n.\ti\tquillmoor[ -]ventures\n'

// A fixture scripts/ folder: the real stamp script next to a stub scanner (or the real one) and a stub private list.
// Stub scanner modes (env STUB_MODE): "hit" prints hits and exits 1, "rc" exits 3 silently, "noise" prints and exits 0, else passes.
function fixture(e: E, opts: { real?: boolean; list?: boolean } = {}) {
  const dir = join(e.root, 'fx', 'scripts')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(here, 'stamp-personal-ok.sh'), join(dir, 'stamp-personal-ok.sh'))
  if (opts.real) {
    for (const f of ['check-no-personal.sh', 'denylist.generic.txt', 'check-ref-personal.sh'])
      copyFileSync(join(here, f), join(dir, f))
  } else {
    writeFileSync(
      join(dir, 'check-ref-personal.sh'),
      `#!/bin/bash
echo "$1 $2" > "${e.root}/scan-args"
echo "$CHECK_EXTRA_RULES" > "${e.root}/scan-rules"
case "\${STUB_MODE:-}" in
  hit) echo "abcdef123456 src/leak.ts:3 [rule]"; echo "abcdef123456 my dir/a b.ts:4 [rule]"; echo "abcdef123456 <path hidden #1>@abcdef123456:2 [rule]"; echo "SECRET-VALUE-TEXT"; exit 1 ;;
  rc) exit 3 ;;
  noise) echo "warning: something"; exit 0 ;;
esac
exit 0
`,
    )
  }
  if (opts.list !== false) writeFileSync(join(dir, 'personal-denylist.txt'), STUB_LIST)
  return dir
}

function stamp(e: E, dir: string, arg: string, mode = '', extra: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync('bash', [join(dir, 'stamp-personal-ok.sh'), '--repo', e.dev, ...args, arg], {
    cwd: e.root,
    env: { ...e.env, STUB_MODE: mode, ...extra },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const stamped = (e: E, tip: string) => e.git(e.dev, 'ls-remote', 'origin', `refs/personal-ok/${tip}`)
const allStamps = (e: E) => e.git(e.dev, 'ls-remote', 'origin', 'refs/personal-ok/*')

function branchTip(e: E) {
  e.git(e.dev, 'checkout', '-q', '-b', 'work')
  return e.commit({ 'src/new.ts': 'export const n = 1\n' }, 'add new')
}

describe('stamp-personal-ok.sh', () => {
  it('stamps nothing on a scan hit; prints file:line only (paths with spaces, hidden-path form too), never matched text', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    const r = stamp(e, dir, tip, 'hit')
    expect(r.code).toBe(1)
    expect(r.out).toContain('src/leak.ts:3\n')
    expect(r.out).toContain('my dir/a b.ts:4\n')
    expect(r.out).toContain('<path hidden #1>@abcdef123456:2\n')
    expect(r.out + r.err).not.toContain('SECRET-VALUE-TEXT')
    expect(r.out + r.err).not.toContain('[rule]')
    expect(allStamps(e)).toBe('')
  })

  it('stamps nothing when the scan exits non-zero with no output, nor when a clean exit still printed lines', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    const rc = stamp(e, dir, tip, 'rc')
    expect(rc.code).toBe(1)
    expect(rc.out).toContain('rc 3')
    expect(stamp(e, dir, tip, 'noise').code).toBe(1)
    expect(allStamps(e)).toBe('')
  })

  it('stamps nothing for a short sha, a branch name, a non-commit object or a missing one', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    const tree = e.git(e.dev, 'rev-parse', `${tip}^{tree}`)
    for (const bad of [tip.slice(0, 12), 'work', 'HEAD', tree, '0'.repeat(40), '']) {
      expect(stamp(e, dir, bad).code, `arg ${bad}`).toBe(2)
    }
    expect(allStamps(e)).toBe('')
  })

  it('on PASS pushes an annotated tag at refs/personal-ok/<tip> that peels to the tip, scanned over merge-base..tip with the private list passed in', () => {
    const e = setup()
    const dir = fixture(e)
    const base = e.git(e.dev, 'rev-parse', 'HEAD')
    const tip = branchTip(e)
    e.commit({ 'src/more.ts': 'export const m = 1\n' }, 'more')
    const tip2 = e.git(e.dev, 'rev-parse', 'HEAD')
    const r = stamp(e, dir, tip2)
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain(`refs/personal-ok/${tip2}`)
    expect(stamped(e, tip2)).toMatch(new RegExp(`^[0-9a-f]{40}\\trefs/personal-ok/${tip2}$`))
    expect(stamped(e, tip)).toBe('')
    expect(e.git(e.remote, 'cat-file', '-t', `refs/personal-ok/${tip2}`)).toBe('tag')
    expect(e.git(e.remote, 'rev-parse', `refs/personal-ok/${tip2}^{commit}`)).toBe(tip2)
    expect(readFileSync(join(e.root, 'scan-args'), 'utf8').trim()).toBe(`${tip2} ${base}`)
    expect(readFileSync(join(e.root, 'scan-rules'), 'utf8').trim()).toBe(join(dir, 'personal-denylist.txt'))
  })

  it('uses the remote main as it is NOW as the base, not the clone-time main', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    // main moves on the remote after the clone, and the branch is rebased onto it
    const other = join(e.root, 'other')
    e.git(e.root, 'clone', '-q', e.remote, other)
    writeFileSync(join(other, 'm.txt'), 'm\n')
    e.git(other, 'add', '-A')
    e.git(other, 'commit', '-q', '-m', 'main moves')
    e.git(other, 'push', '-q', 'origin', 'HEAD:main')
    const newMain = e.git(other, 'rev-parse', 'HEAD')
    e.git(e.dev, 'fetch', '-q', 'origin')
    e.git(e.dev, 'rebase', '-q', 'origin/main')
    const tip2 = e.git(e.dev, 'rev-parse', 'HEAD')
    expect(tip2).not.toBe(tip)
    const r = stamp(e, dir, tip2)
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(join(e.root, 'scan-args'), 'utf8').trim()).toBe(`${tip2} ${newMain}`)
  })

  it('refuses when the remote has a tag named origin/main that would hide the range, and when base == tip', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    // a tag "origin/main" at the tip: the short name origin/main would resolve to it and empty the range
    e.git(e.dev, 'tag', 'origin/main', tip)
    const masked = stamp(e, dir, tip, 'hit')
    expect(masked.code).toBe(1)
    expect(masked.out).toContain('src/leak.ts:3') // the scan ran over the real range, so the hit was found
    expect(allStamps(e)).toBe('')
    // a tip that is already main: base == tip, nothing to scan
    const main = e.git(e.dev, 'rev-parse', 'main')
    const same = stamp(e, dir, main)
    expect(same.code).toBe(1)
    expect(same.out).toContain('empty range: no stamp')
    expect(allStamps(e)).toBe('')
  })

  it('refuses without a private list, and never passes the scan an absent one', () => {
    const e = setup()
    const dir = fixture(e, { list: false })
    const tip = branchTip(e)
    const r = stamp(e, dir, tip)
    expect(r.code).toBe(1)
    expect(r.out).toContain('no private list here: no stamp')
    expect(allStamps(e)).toBe('')
  })

  it('cannot be told to skip the scan from the environment', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    const r = stamp(e, dir, tip, 'hit', { STAMP_SCAN_CMD: 'true', CHECK_REF_PERSONAL: 'true' })
    expect(r.code).toBe(1)
    expect(allStamps(e)).toBe('')
  })

  it('with the REAL scanner, a generic-rule hit in a middle commit message stops the stamp', () => {
    const e = setup()
    const dir = fixture(e, { real: true })
    e.git(e.dev, 'checkout', '-q', '-b', 'work')
    e.commit({ 'src/a.ts': 'export const a = 2\n' }, 'first')
    e.commit({ 'src/b.ts': 'export const b = 2\n' }, `mail bob${'@'}corp-mail.io about it`)
    const tip = e.commit({ 'src/c.ts': 'export const c = 2\n' }, 'last')
    const r = stamp(e, dir, tip)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/\.commit-message\.[0-9a-f]{12}:1/)
    expect(r.out + r.err).not.toContain('corp-mail')
    expect(allStamps(e)).toBe('')
    // and a clean branch with the same real scanner does stamp
    e.git(e.dev, 'checkout', '-q', '-b', 'clean', 'main')
    const clean = e.commit({ 'src/d.ts': 'export const d = 2\n' }, 'clean change')
    const ok = stamp(e, dir, clean)
    expect(ok.code, ok.out + ok.err).toBe(0)
    expect(stamped(e, clean)).not.toBe('')
  })

  it('reads the remote from REMOTE or --remote', () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    expect(stamp(e, dir, tip, '', { REMOTE: 'nope' }).code).toBe(1)
    expect(allStamps(e)).toBe('')
    e.git(e.dev, 'remote', 'add', 'other', e.remote)
    const r = stamp(e, dir, tip, '', { REMOTE: 'nope' }, ['--remote', 'other'])
    expect(r.code, r.err).toBe(0)
    expect(stamped(e, tip)).not.toBe('')
  })

  it("is accepted by gate-push.sh's own stamp_ok, and a lightweight tag at the same name is not", () => {
    const e = setup()
    const dir = fixture(e)
    const tip = branchTip(e)
    expect(stamp(e, dir, tip).code).toBe(0)
    // stamp_ok lifted out of gate-push.sh (the file is a script, not a library), run in a clone with REMOTE=origin
    const src = readFileSync(GATE_PUSH, 'utf8')
    const start = src.indexOf('stamp_ok() {')
    const end = src.indexOf('\n}\n', start) + 3
    expect(start).toBeGreaterThan(0)
    const fn = src.slice(start, end)
    const check = (cwd: string, sha: string) =>
      spawnSync('bash', ['-c', `REMOTE=origin\n${fn}\nstamp_ok ${sha}`], { cwd, env: e.env, encoding: 'utf8' })
    const ok = check(e.owner, tip)
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    const other = e.git(e.dev, 'rev-parse', 'HEAD~1')
    e.git(e.dev, 'push', '-q', 'origin', `${other}:refs/personal-ok/${other}`)
    const light = check(e.owner, other)
    expect(light.status).toBe(1)
    expect(light.stdout).toContain('not an annotated tag')
  })
})
