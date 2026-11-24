// The pre-push hook's rule for refs/fleet/*: a status line is a parentless commit with ONE regular file (headline, or roster for
// refs/fleet/_roster), pushed alone, every line 1-160 printable ASCII, personal-data clean. Accepted pushes never start the gate.
// The real hook, a temp clone and a temp bare origin; scripts/gate.sh is a stand-in that writes down that it was called.
// gate-reads: scripts/pre-push.sh scripts/check-no-personal.sh
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('TALOS_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fleet',
  GIT_AUTHOR_EMAIL: 'fleet@example.com',
  GIT_COMMITTER_NAME: 'fleet',
  GIT_COMMITTER_EMAIL: 'fleet@example.com',
}

function setup() {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'ppf-')))
  dirs.push(T)
  const clone = join(T, 'clone')
  const origin = join(T, 'origin.git')
  const calls = join(T, 'calls.log')
  const run = (cwd: string, args: string[], input?: string, e: Record<string, string> = {}) =>
    spawnSync('git', args, { cwd, env: { ...env, CALLS: calls, ...e }, encoding: 'utf8', input })
  const ok = (cwd: string, args: string[], input?: string) => {
    const r = run(cwd, args, input)
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  mkdirSync(clone)
  ok(clone, ['init', '-q', '-b', 'main'])
  mkdirSync(join(clone, 'scripts'))
  for (const f of [
    'pre-push.sh',
    'check-no-personal.sh',
    'denylist.generic.txt',
    'verified-trailer.sh',
    'fleet-state-push.sh',
  ])
    cpSync(join(here, f), join(clone, 'scripts', f))
  writeFileSync(join(clone, 'scripts/gate.sh'), '#!/bin/sh\necho "gate $*" >> "$CALLS"\nexit 1\n')
  cpSync(join(repoRoot, '.githooks'), join(clone, '.githooks'), { recursive: true })
  ok(clone, ['config', 'core.hooksPath', join(clone, '.githooks')])
  writeFileSync(join(clone, 'README.md'), 'x\n')
  ok(clone, ['add', '-A'])
  ok(clone, ['commit', '-qm', 'base'])
  ok(T, ['init', '-q', '--bare', '-b', 'main', origin])
  ok(clone, ['remote', 'add', 'origin', origin])
  ok(clone, ['push', '-q', '--no-verify', 'origin', 'main'])

  /** A commit holding exactly `files` (a value that is an object is a subfolder), with optional parents. */
  const mk = (files: Record<string, string | Record<string, string>>, parents: string[] = []) => {
    const entries = Object.entries(files).map(([name, v]) => {
      if (typeof v === 'string') return `100644 blob ${ok(clone, ['hash-object', '-w', '--stdin'], v)}\t${name}`
      const inner = Object.entries(v)
        .map(([n, c]) => `100644 blob ${ok(clone, ['hash-object', '-w', '--stdin'], c)}\t${n}`)
        .join('\n')
      return `040000 tree ${ok(clone, ['mktree'], `${inner}\n`)}\t${name}`
    })
    const tree = ok(clone, ['mktree'], entries.length ? `${entries.join('\n')}\n` : '')
    return ok(clone, ['commit-tree', tree, '-m', 'fleet status', ...parents.flatMap((p) => ['-p', p])])
  }
  const push = (...specs: string[]) => {
    rmSync(calls, { force: true })
    const r = run(clone, ['push', '--force', '-q', 'origin', ...specs])
    return { code: r.status, err: r.stderr, gateCalled: existsSync(calls) }
  }
  const refs = () => ok(origin, ['for-each-ref', '--format=%(refname)', 'refs/fleet/'])
  return { T, clone, origin, ok, run, mk, push, refs }
}

describe('pre-push hook: refs/fleet/*', () => {
  it('accepts a good headline and a good roster, and never starts the gate', () => {
    const r = setup()
    const a = r.push(`${r.mk({ headline: 'building the thing\n' })}:refs/fleet/work`)
    expect(a.code, a.err).toBe(0)
    expect(a.gateCalled).toBe(false)
    const b = r.push(`${r.mk({ roster: 'work w1\nhome\natlas\n' })}:refs/fleet/_roster`)
    expect(b.code, b.err).toBe(0)
    expect(b.gateCalled).toBe(false)
    expect(r.refs().split('\n').sort()).toEqual(['refs/fleet/_roster', 'refs/fleet/work'])
  })

  it('accepts a delete of a fleet ref when it is the only ref in the push', () => {
    const r = setup()
    expect(r.push(`${r.mk({ headline: 'one\n' })}:refs/fleet/work`).code).toBe(0)
    const d = r.push(':refs/fleet/work')
    expect(d.code, d.err).toBe(0)
    expect(d.gateCalled).toBe(false)
    expect(r.refs()).toBe('')
  })

  it.each([
    ['an extra file in the tree', (r: ReturnType<typeof setup>) => r.mk({ headline: 'a\n', other: 'b\n' })],
    ['a subfolder holding the headline', (r: ReturnType<typeof setup>) => r.mk({ dir: { headline: 'a\n' } })],
    ['a file with the wrong name', (r: ReturnType<typeof setup>) => r.mk({ roster: 'a\n' })],
    [
      'a commit with a parent',
      (r: ReturnType<typeof setup>) => r.mk({ headline: 'a\n' }, [r.ok(r.clone, ['rev-parse', 'HEAD'])]),
    ],
    ['161 characters', (r: ReturnType<typeof setup>) => r.mk({ headline: `${'a'.repeat(161)}\n` })],
    ['two lines in a headline', (r: ReturnType<typeof setup>) => r.mk({ headline: 'one\ntwo\n' })],
    ['an empty headline', (r: ReturnType<typeof setup>) => r.mk({ headline: '' })],
    ['a control character', (r: ReturnType<typeof setup>) => r.mk({ headline: 'bell\u0007\n' })],
    ['a non-ASCII character', (r: ReturnType<typeof setup>) => r.mk({ headline: 'café\n' })],
  ])('refuses %s, and the gate is not the answer', (_n, build) => {
    const r = setup()
    const p = r.push(`${build(r)}:refs/fleet/work`)
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('pre-push: REFUSED')
    expect(p.gateCalled).toBe(false)
    expect(r.refs()).toBe('')
  })

  it('refuses a roster line of 161 characters and an empty line in the middle', () => {
    const r = setup()
    expect(r.push(`${r.mk({ roster: `work\n${'a'.repeat(161)}\n` })}:refs/fleet/_roster`).code).not.toBe(0)
    expect(r.push(`${r.mk({ roster: 'work\n\nhome\n' })}:refs/fleet/_roster`).code).not.toBe(0)
    expect(r.refs()).toBe('')
  })

  it('refuses a second ref in the same push: fleet + branch, fleet + fleet, fleet + delete', () => {
    const r = setup()
    const good = r.mk({ headline: 'a\n' })
    const fb = r.push(`${good}:refs/fleet/work`, 'HEAD:refs/heads/feat')
    expect(fb.code).not.toBe(0)
    expect(fb.err).toContain('pre-push: REFUSED')
    const ff = r.push(`${good}:refs/fleet/work`, `${good}:refs/fleet/home`)
    expect(ff.code).not.toBe(0)
    expect(r.refs()).toBe('')
    expect(r.ok(r.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n')).toEqual([
      'refs/heads/main',
    ])
    expect(r.push(`${good}:refs/fleet/work`).code).toBe(0)
    expect(r.push(':refs/fleet/work', `${good}:refs/fleet/home`).code).not.toBe(0)
    expect(r.refs()).toBe('refs/fleet/work')
  })

  it.each([
    'refs/fleet/Work',
    'refs/fleet/a_b',
    'refs/fleet/x/y',
    'refs/fleet/1abc',
    'refs/fleet/../x',
    'refs/fleet/A B',
  ])('refuses the name %s', (ref) => {
    const r = setup()
    const p = r.push(`${r.mk({ headline: 'a\n' })}:${ref}`)
    expect(p.code).not.toBe(0)
    expect(p.gateCalled).toBe(false)
    expect(r.refs()).toBe('')
  })

  it('refuses a line that the personal-data check refuses (the private list included)', () => {
    const r = setup()
    writeFileSync(join(r.clone, 'scripts/personal-denylist.txt'), '.*\t-\tzq-private-hit-for-the-test\n')
    const p = r.push(`${r.mk({ headline: 'about zq-private-hit-for-the-test\n' })}:refs/fleet/work`)
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('personal-data check failed')
    expect(p.gateCalled).toBe(false)
    const mail = r.push(`${r.mk({ headline: `${['jo.smith', '@', 'gmail.com'].join('')}\n` })}:refs/fleet/work`)
    expect(mail.code).not.toBe(0)
    expect(r.refs()).toBe('')
  })

  it('a non-fleet push still goes to the gate', () => {
    const r = setup()
    const p = r.push('HEAD:refs/heads/feat')
    expect(p.gateCalled).toBe(true)
    expect(p.code).not.toBe(0)
  })
})
