// scripts/publish-public.sh: the fresh public snapshot up to the push and never past it. Each test builds a small source
// repository holding copies of the scripts (they find each other next to themselves) and a local bare "public" repository,
// so nothing here touches a real remote. The private list is a rule file in the source's scripts/ folder, never tracked.
// gate-reads: scripts/publish-public.sh scripts/export-public.sh scripts/check-no-personal.sh scripts/denylist.generic.txt
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = ['publish-public.sh', 'export-public.sh', 'check-no-personal.sh', 'denylist.generic.txt']
const env = gateTestEnv({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
})
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
// A private-list term assembled at run time, so this file itself carries nothing a list would flag
const SECRET = ['Quill', 'mark', 'Labs'].join('')

function world(opts: { privateList?: boolean; sourceExtra?: Record<string, string>; emptyPublic?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pubpub-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'scripts'), { recursive: true })
  for (const s of SCRIPTS) writeFileSync(join(src, 'scripts', s), readFileSync(join(here, s)))
  put(src, '.gitignore', 'scripts/personal-denylist.txt\n')
  put(src, 'README.md', '# Talos\n')
  put(src, 'apps/web/new.ts', 'export const x = 1\n')
  put(src, 'docs/SPEC.md', 'private spec\n') // in export-public.sh's EXCLUDE: never published
  put(src, 'docs/audits/a.md', 'an internal audit\n') // excluded too
  for (const [p, t] of Object.entries(opts.sourceExtra ?? {})) put(src, p, t)
  if (opts.privateList !== false) put(src, 'scripts/personal-denylist.txt', `!^third_party/\t-\t${SECRET}\n`)
  git(root, 'init', '-q', '-b', 'main', src)
  git(src, 'add', '-A')
  git(src, 'commit', '-q', '-m', 'source')
  // its origin: the script publishes only a clean HEAD equal to origin/main
  git(root, 'clone', '-q', '--bare', src, join(root, 'src.git'))
  git(src, 'remote', 'add', 'origin', join(root, 'src.git'))
  git(src, 'fetch', '-q', 'origin')
  // the public repository as it was: an old file that the new snapshot no longer has, and a README that changes
  const bare = join(root, 'public.git')
  if (opts.emptyPublic) {
    git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  } else {
    const seed = join(root, 'seed')
    mkdirSync(seed)
    git(root, 'init', '-q', '-b', 'main', seed)
    put(seed, 'README.md', '# Talos (old)\n')
    put(seed, 'old/gone.ts', 'export {}\n')
    spawnSync('git', ['-c', 'user.name=Snapshot Bot', '-c', 'user.email=snap@example.org', 'add', '-A'], {
      cwd: seed,
      env,
    })
    const c = spawnSync(
      'git',
      ['-c', 'user.name=Snapshot Bot', '-c', 'user.email=snap@example.org', 'commit', '-q', '-m', 'snapshot 11/09'],
      { cwd: seed, env },
    )
    if (c.status !== 0) throw new Error(String(c.stderr))
    git(root, 'clone', '-q', '--bare', seed, bare)
  }
  return { root, src, bare, work: join(root, 'work') }
}
const publish = (
  w: ReturnType<typeof world>,
  o: {
    work?: string
    url?: string
    checkout?: string
    extraEnv?: Record<string, string>
  } = {},
) => {
  const checkout = o.checkout ?? w.src
  return spawnSync('bash', [join(checkout, 'scripts', 'publish-public.sh'), o.url ?? w.bare, o.work ?? w.work], {
    cwd: checkout,
    env: { ...env, ...o.extraEnv },
    encoding: 'utf8',
  })
}

describe('publish-public.sh', () => {
  it('stages the export over the public tree, says what changes, and stops before the commit and the push', () => {
    const w = world()
    const before = git(w.root, '--git-dir', w.bare, 'rev-parse', 'main')
    const r = publish(w)
    const out = `${r.stdout}${r.stderr}`
    expect(r.status, out).toBe(0)
    expect(out).toContain('added 6, changed 1, removed 1')
    expect(out).toMatch(/removed:\n {5}old\/gone\.ts/)
    // every new file, under its top-level folder with a count, and all of it before the push commands
    expect(out).toContain('NEW since the last public snapshot, by top-level folder (6 files):')
    expect(out).toMatch(/ {5}apps\/ {2}1 new\n {7}apps\/web\/new\.ts\n/)
    expect(out).toMatch(/ {5}scripts\/ {2}4 new\n( {7}scripts\/\S+\n){4}/)
    expect(out).toMatch(/ {5}\(top level\) {2}1 new\n {7}\.gitignore\n/)
    expect(out.indexOf('NEW since')).toBeLessThan(out.indexOf('push origin HEAD'))
    expect(out).not.toMatch(/ {7}README\.md/) // changed, not new
    expect(out).toContain('NOT committed, NOT pushed')
    // the commit will carry the last snapshot's identity, set in the clone, never this machine's
    expect(out).toContain('the commit will be by: Snapshot Bot <snap@example.org>')
    expect(git(join(w.work, 'public'), 'config', '--local', 'user.email')).toBe('snap@example.org')
    expect(out).toContain('push origin HEAD')
    // staged in the clone, with the excluded paths left out
    const staged = git(join(w.work, 'public'), 'diff', '--cached', '--name-only').split('\n')
    expect(staged).toContain('apps/web/new.ts')
    expect(staged).toContain('old/gone.ts')
    expect(existsSync(join(w.work, 'public', 'docs', 'SPEC.md'))).toBe(false)
    expect(existsSync(join(w.work, 'public', 'docs', 'audits'))).toBe(false)
    expect(existsSync(join(w.work, 'public', 'scripts', 'personal-denylist.txt'))).toBe(false)
    // nothing committed in the clone, nothing reached the public repository
    expect(git(join(w.work, 'public'), 'log', '--oneline').split('\n')).toHaveLength(1)
    expect(git(w.root, '--git-dir', w.bare, 'rev-parse', 'main')).toBe(before)
    // the snapshot commit names its private source in a trailer, whatever message it is given (one already there is replaced)
    const source = git(w.src, 'rev-parse', 'HEAD')
    expect(out).toContain(`Talos-Source: ${source}`)
    git(
      join(w.work, 'public'),
      'commit',
      '-q',
      '-m',
      'snapshot 11/14\n\nTalos-Source: 0000000000000000000000000000000000000000',
    )
    expect(git(join(w.work, 'public'), 'log', '-1', '--format=%(trailers:key=Talos-Source,valueonly)')).toBe(source)
  })

  it('refuses to start without the private list: nothing exported, nothing cloned', () => {
    const w = world({ privateList: false })
    const r = publish(w)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('no private list')
    expect(existsSync(w.work)).toBe(false)
  })

  it('a private-list hit in the checkout stops it before the export, and never prints the term', () => {
    const w = world({
      sourceExtra: { 'docs/note.md': `built for ${SECRET}\n` },
    })
    const r = publish(w)
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('found something in this checkout')
    expect(`${r.stdout}${r.stderr}`).not.toContain(SECRET)
    expect(existsSync(join(w.work, 'export'))).toBe(false)
  })

  it('a generic-rule hit (a live relay host) stops it too', () => {
    const host = ['talos', '-fern.up.', 'railway', '.app'].join('')
    const w = world({
      sourceExtra: { 'apps/x/test.ps1': `$u = 'https://${host}'\n` },
    })
    const r = publish(w)
    expect(r.status).toBe(1)
    expect(existsSync(join(w.work, 'public'))).toBe(false)
  })

  it('a work folder that is not empty is refused', () => {
    const w = world()
    put(w.work, 'leftover.txt', 'x\n')
    const r = publish(w)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('is not empty')
  })

  it('publishes only HEAD == origin/main: a local commit on top is refused', () => {
    const w = world()
    put(w.src, 'apps/web/later.ts', 'export const y = 2\n')
    git(w.src, 'add', '-A')
    git(w.src, 'commit', '-q', '-m', 'not on origin')
    const r = publish(w)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('HEAD is not origin/main')
    expect(existsSync(w.work)).toBe(false)
  })

  describe('HEAD at origin/green instead of main (a snapshot needs no landing freeze)', () => {
    const SIX = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
    const passed = (job: string) =>
      job === 'check' ? 'passed on delphi' : `skipped: no ${job} inputs changed since abc1234`
    // main moves on one commit past HEAD (c1); returns c1, c2 and a fake gh that answers statuses[sha] and logs every call
    function moved(statuses: Record<string, Array<[string, string, string]>>) {
      const w = world()
      const c1 = git(w.src, 'rev-parse', 'HEAD')
      put(w.src, 'apps/web/later.ts', 'export const y = 2\n')
      git(w.src, 'add', '-A')
      git(w.src, 'commit', '-q', '-m', 'later')
      const c2 = git(w.src, 'rev-parse', 'HEAD')
      git(w.src, 'push', '-q', 'origin', 'HEAD:main')
      git(w.src, 'checkout', '-q', '--detach', c1)
      const bin = join(w.root, 'bin')
      mkdirSync(bin)
      for (const [sha, rows] of Object.entries(statuses))
        writeFileSync(join(w.root, `status-${sha}`), `${rows.map((r) => r.join('\t')).join('\n')}\n`)
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh\necho "$*" >> "${w.root}/gh-calls"\ns="\${3#*/commits/}"; s="\${s%%/statuses*}"\ncat "${w.root}/status-$s" 2>/dev/null\nexit 0\n`,
      )
      chmodSync(join(bin, 'gh'), 0o755)
      const extraEnv = {
        PATH: `${bin}:${process.env.PATH}`,
        PUBLISH_CI_REPO: 'owner/repo',
      }
      return {
        w,
        c1,
        c2,
        extraEnv,
        ghCalled: () => existsSync(join(w.root, 'gh-calls')),
      }
    }
    const six = (over: Record<string, [string, string]> = {}): Array<[string, string, string]> =>
      SIX.map((j) => [`local-ci/${j}`, ...(over[j] ?? ['success', passed(j)])] as [string, string, string])
    const setGreen = (w: ReturnType<typeof world>, sha: string) =>
      git(w.root, '--git-dir', join(w.root, 'src.git'), 'update-ref', 'refs/heads/green', sha)

    it('HEAD == green, on main, six successes (newest first; an older failure is ignored): accepted', () => {
      const m = moved({})
      writeFileSync(
        join(m.w.root, `status-${m.c1}`),
        // newest first: the older failed check run comes after the success and does not count
        `${[...six(), ['local-ci/check', 'failure', 'failed on delphi']].map((r) => r.join('\t')).join('\n')}\n`,
      )
      setGreen(m.w, m.c1)
      const r = publish(m.w, { extraEnv: m.extraEnv })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      expect(r.stdout).toContain(`Talos-Source: ${m.c1}`)
    })

    it('an ancestor of main that is not green is refused, without reading statuses', () => {
      const m = moved({ x: [] })
      setGreen(m.w, m.c2) // green is elsewhere (main's head)
      const r = publish(m.w, { extraEnv: m.extraEnv })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('HEAD is not origin/main or origin/green')
      expect(m.ghCalled()).toBe(false)
      expect(existsSync(m.w.work)).toBe(false)
    })

    it('no green branch at all is refused', () => {
      const m = moved({})
      const r = publish(m.w, { extraEnv: m.extraEnv })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('HEAD is not origin/main or origin/green')
    })

    it('green with a missing, failed, pending or skipped-check status is refused, naming the job', () => {
      const cases: Array<[string, Array<[string, string, string]>, string]> = [
        ['missing', six().filter((r) => r[0] !== 'local-ci/mobile'), 'no local-ci/mobile status'],
        ['failed', six({ image: ['failure', 'failed on delphi'] }), 'local-ci/image is failure'],
        ['pending', six({ mod: ['pending', 'running'] }), 'local-ci/mod is pending'],
        [
          'a check that was skipped',
          six({
            check: ['success', 'skipped: no check inputs changed since abc1234'],
          }),
          'local-ci/check was skipped',
        ],
        ['an odd description', six({ browser: ['success', 'looks fine to me'] }), 'local-ci/browser says'],
      ]
      for (const [name, rows, why] of cases) {
        const m = moved({})
        writeFileSync(join(m.w.root, `status-${m.c1}`), `${rows.map((r) => r.join('\t')).join('\n')}\n`)
        setGreen(m.w, m.c1)
        const r = publish(m.w, { extraEnv: m.extraEnv })
        expect(r.status, name).toBe(2)
        expect(r.stderr, name).toContain('not six-green')
        expect(r.stderr, name).toContain(why)
        expect(existsSync(m.w.work), name).toBe(false)
      }
    })

    it('statuses that cannot be read are refused, not read as green', () => {
      const m = moved({})
      setGreen(m.w, m.c1)
      writeFileSync(join(m.w.root, 'bin', 'gh'), '#!/bin/sh\nexit 1\n')
      const r = publish(m.w, { extraEnv: m.extraEnv })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('could not read the CI statuses')
    })

    it('a commit that is not on main is refused even when green is there and all six look green', () => {
      const w = world()
      const main = git(w.src, 'rev-parse', 'HEAD')
      git(w.src, 'checkout', '-q', '-b', 'side')
      put(w.src, 'apps/web/side.ts', 'export const z = 3\n')
      git(w.src, 'add', '-A')
      git(w.src, 'commit', '-q', '-m', 'side')
      const side = git(w.src, 'rev-parse', 'HEAD')
      git(w.src, 'push', '-q', 'origin', 'side')
      git(w.root, '--git-dir', join(w.root, 'src.git'), 'update-ref', 'refs/heads/green', side)
      const bin = join(w.root, 'bin')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh\necho "$*" >> "${w.root}/gh-calls"\nprintf '${six()
          .map((r) => r.join('\\t'))
          .join('\\n')}\\n'\n`,
      )
      chmodSync(join(bin, 'gh'), 0o755)
      expect(main).not.toBe(side)
      const r = publish(w, {
        extraEnv: {
          PATH: `${bin}:${process.env.PATH}`,
          PUBLISH_CI_REPO: 'owner/repo',
        },
      })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('is not on origin/main')
      expect(existsSync(w.work)).toBe(false)
      expect(existsSync(join(w.root, 'gh-calls'))).toBe(false)
    })

    it('a local tag named origin/main does not stand in for the fetched main', () => {
      const w = world()
      git(w.src, 'checkout', '-q', '-b', 'side')
      put(w.src, 'apps/web/side.ts', 'export const z = 3\n')
      git(w.src, 'add', '-A')
      git(w.src, 'commit', '-q', '-m', 'side')
      git(w.src, 'tag', 'origin/main', 'HEAD')
      const bin = join(w.root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho x >> "${w.root}/gh-calls"\nexit 1\n`)
      chmodSync(join(bin, 'gh'), 0o755)
      const r = publish(w, { extraEnv: { PATH: `${bin}:${process.env.PATH}`, PUBLISH_CI_REPO: 'owner/repo' } })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('HEAD is not origin/main or origin/green')
      expect(existsSync(w.work)).toBe(false)
    })

    it('HEAD == origin/main still works with no green branch and no gh call', () => {
      const w = world()
      const bin = join(w.root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho x >> "${w.root}/gh-calls"\nexit 1\n`)
      chmodSync(join(bin, 'gh'), 0o755)
      const r = publish(w, {
        extraEnv: { PATH: `${bin}:${process.env.PATH}` },
      })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      expect(existsSync(join(w.root, 'gh-calls'))).toBe(false)
    })
  })

  it('refuses the private repository itself as the target, and a work folder inside the checkout', () => {
    const w = world()
    const own = publish(w, { url: join(w.root, 'src.git') })
    expect(own.status).toBe(2)
    expect(own.stderr).toContain('is this private repository')
    const inside = publish(w, { work: join(w.src, 'out') })
    expect(inside.status).toBe(2)
    expect(inside.stderr).toContain('is inside this checkout')
    expect(existsSync(join(w.src, 'out'))).toBe(false)
    // another spelling of the private repository's URL: caught after the clone, by its commit
    const spelled = publish(w, {
      url: `file://${join(w.root, 'src.git')}`,
      work: join(w.root, 'w2'),
    })
    expect(spelled.status).toBe(2)
    expect(spelled.stderr).toContain("holds this checkout's commit")
    // a .. in the folder, and identity variables in the shell
    const dots = publish(w, { work: `${w.root}/nope/../src/out` })
    expect(dots.status).toBe(2)
    const ident = publish(w, {
      work: join(w.root, 'w3'),
      extraEnv: { GIT_AUTHOR_NAME: 'Someone' },
    })
    expect(ident.status).toBe(2)
    expect(ident.stderr).toContain('GIT_AUTHOR_NAME is set')
  })

  it('an empty public repository needs PUBLISH_AUTHOR for the commit identity', () => {
    const w = world({ emptyPublic: true })
    const r = publish(w)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('PUBLISH_AUTHOR')
    const w2 = world({ emptyPublic: true })
    const ok = publish(w2, {
      extraEnv: {
        PUBLISH_AUTHOR: 'Talos Maintainers <maintainers@example.org>',
      },
    })
    expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0)
    expect(ok.stdout).toContain('added 7, changed 0, removed 0')
    expect(git(join(w2.work, 'public'), 'config', '--local', 'user.name')).toBe('Talos Maintainers')
  })

  it("from a worktree: the main checkout's private list and private docs are used; PUBLISH_PRIVATE_LIST names one", () => {
    // a private doc whose Appendix P line also appears in the source: only the main checkout knows the doc
    const line = ['the quiet ', 'workshop on ', 'the north road'].join('')
    const w = world({ sourceExtra: { 'docs/note.md': `${line}\n` } })
    const doc = join(w.root, 'private.md')
    writeFileSync(doc, `# private\n## Appendix P\n- ${line}\n`)
    writeFileSync(join(w.src, 'scripts', 'private-docs.txt'), `${doc}\n`)
    const wt = join(w.root, 'wt')
    git(w.src, 'worktree', 'add', '-q', '--detach', wt)
    const r = publish(w, { checkout: wt })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('[private-doc]')
    expect(`${r.stdout}${r.stderr}`).not.toContain(line)
    // the list named outright, from a checkout with none beside the script or in the main checkout
    const w2 = world({
      privateList: false,
      sourceExtra: { 'docs/note.md': `built for ${SECRET}\n` },
    })
    const named = join(w2.root, 'list.txt')
    writeFileSync(named, `!^third_party/\t-\t${SECRET}\n`)
    const r2 = publish(w2, { extraEnv: { PUBLISH_PRIVATE_LIST: named } })
    expect(r2.status).toBe(1)
    expect(`${r2.stdout}${r2.stderr}`).toContain('found something in this checkout')
  })
})
