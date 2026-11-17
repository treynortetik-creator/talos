// File names that git would print quoted (a non-ASCII letter, a tab), or that a shell or a tool can take for something else (a
// space, a name starting with "-"), on every part of the push path that reads names from git: the gate's plan and its second
// count (scripts/gate.sh), the race and rebase-clean decisions and the handoff check when landing (gate-push.sh), the hook's
// handoff check (pre-push.sh), and the personal-data scans (check-no-personal.sh, check-ref-personal.sh, personal-watch.sh).
// Read without -z, git prints such a name as a C string ("apps/bridge/src/\303\251.ts"), no rule matches it, and the file is
// skipped without a word; xargs without -0 splits a path at its space. Each case runs with core.quotePath true and false (it is
// the user's setting, and the result must not depend on it).
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { gateTestEnv } from './gate-test-env'
import { FAKE, hits, noValue, RULE, s12, watch, setup as watchSetup } from './personal-watch-fixture'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
vi.setConfig({ testTimeout: 90_000 })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}, 60_000) // many temp trees: the default 10 s ran out under a busy gate
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
/** A global git config with core.quotePath set as given: every git the scripts run reads it. */
const quoteConfig = (on: boolean) => {
  const f = join(tmp('qp-'), 'gitconfig')
  writeFileSync(f, `[core]\n\tquotePath = ${on}\n`)
  return f
}
const QUOTE = [true, false]
const put = (root: string, f: string, t = 'x\n') => {
  mkdirSync(dirname(join(root, f)), { recursive: true })
  writeFileSync(join(root, f), t)
}
// a value the generic list flags, built at run time so this file holds nothing the scan would flag
const LEAK = ['jo.smith', '@', 'gmail.com'].join('')

// the odd names, each in a place where the gate has a rule for it
const ACCENT_BRIDGE = 'apps/bridge/src/é.ts' // anything under apps/bridge/: the whole bridge suite
const ACCENT_WEB = 'apps/web/src/lib/naïve.ts' // a Vitest module, and the web smoke set
const SPACED_SCRIPT = 'scripts/my dir/tool.sh' // its folder is listed by a test in that folder (scripts/my dir/l.test.ts)
const TAB_WEB = 'apps/web/src/tab\there.ts' // a Vitest module
const TAB_SCRIPT = 'scripts/x\ty.sh' // named by a test
const DASH_SCRIPT = '-x.sh' // named by a test (as grep's first argument, it is the options -x and -.)
const DASH_DOC = '-notes.md' // a doc named by a test

describe('gate.sh: the plan and its second count take every name, whatever core.quotePath says', () => {
  function repo(quote: boolean) {
    const T = tmp('gate-paths-')
    const env = gateTestEnv({
      GIT_CONFIG_GLOBAL: quoteConfig(quote),
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    })
    const git = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
      return r.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    mkdirSync(join(T, 'scripts'))
    cpSync(join(here, 'gate.sh'), join(T, 'scripts/gate.sh'))
    cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
    cpSync(join(here, 'talos-machine.sh'), join(T, 'scripts/talos-machine.sh'))
    put(T, 'apps/bridge/src/notify.ts')
    put(T, 'apps/web/playwright.config.ts', 'export default {}\n')
    put(T, 'apps/web/test/threads/threads.spec.ts') // one of the smoke set
    put(T, 'apps/web/src/a.ts')
    // the tests that reach the odd names
    put(T, 'scripts/my dir/l.test.ts', "const files = readdirSync(join(ROOT, 'scripts/my dir'))\n")
    put(T, 'scripts/lead.test.ts', `const s = '${DASH_SCRIPT}'\n`)
    put(T, 'scripts/notes.test.ts', `const d = '${DASH_DOC}'\n`)
    put(T, 'scripts/tab.test.ts', "const s = 'x\ty.sh'\n")
    put(T, 'scripts/decoy.test.ts', "const e = ''\n") // matched by a name pattern built from an empty file name
    // a folder with a regex character in its name is that folder only: its own listing test, never one for scripts/v1x0
    put(T, 'scripts/v1.0/l.test.ts', "const files = readdirSync('scripts/v1.0')\n")
    put(T, 'scripts/v1x0.test.ts', "const files = readdirSync('scripts/v1x0')\n")
    git('add', '-A')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    for (const f of [
      ACCENT_BRIDGE,
      ACCENT_WEB,
      SPACED_SCRIPT,
      TAB_WEB,
      TAB_SCRIPT,
      DASH_SCRIPT,
      DASH_DOC,
      'scripts/v1.0/t.sh',
    ]) {
      put(T, f, 'y\n')
    }
    git('add', '-A')
    git('commit', '-qm', 'change')
    const gate = (...a: string[]) => spawnSync('bash', ['scripts/gate.sh', ...a], { cwd: T, env, encoding: 'utf8' })
    return { T, git, gate, base }
  }

  it.each(QUOTE)('core.quotePath=%s: every odd name plans its suites, and the second count agrees', (quote) => {
    const r = repo(quote)
    const p = r.gate('--plan', '--base', r.base)
    expect(p.stderr).not.toContain('plan-check')
    expect(p.status, p.stderr).toBe(0)
    expect(p.stdout.trim().split('\n')).toEqual([
      'typecheck',
      'lint',
      'personal',
      'size',
      'vitest',
      `\t${ACCENT_WEB}`,
      `\t${TAB_WEB}`,
      '\tscripts/lead.test.ts', // names -x.sh
      '\tscripts/my dir/l.test.ts', // lists scripts/my dir
      '\tscripts/notes.test.ts', // names -notes.md
      '\tscripts/tab.test.ts', // names x<TAB>y.sh
      '\tscripts/v1.0/l.test.ts', // lists scripts/v1.0 (and scripts/v1x0.test.ts is not here)
      'bun-all', // apps/bridge/src/é.ts
      'web-specs',
      '\ttest/threads/threads.spec.ts', // apps/web/src/lib/naïve.ts and the tab one: the smoke set
    ])
    expect(p.stderr).toContain('scripts/my dir/l.test.ts <- scripts/my dir (lists it)')
  })

  it.each(QUOTE)('core.quotePath=%s: the same odd names uncommitted and untracked plan the same', (quote) => {
    const r = repo(quote)
    const head = r.git('rev-parse', 'HEAD')
    const committed = r.gate('--plan', '--base', r.base).stdout
    r.git('reset', '-q', '--soft', r.base) // staged now, not committed
    expect(r.gate('--plan', '--base', r.base).stdout).toBe(committed)
    r.git('reset', '-q') // untracked now
    const untracked = r.gate('--plan', '--base', r.base)
    expect(untracked.status, untracked.stderr).toBe(0)
    expect(untracked.stdout).toBe(committed)
    r.git('reset', '-q', '--hard', head)
  })
})

// gate-push.sh and the hook, from a clone with a bare origin and another machine (a cut-down gate-push.test.ts setup)
function pushSetup(quote: boolean) {
  const T = tmp('gp-paths-')
  const clone = join(T, 'clone')
  const other = join(T, 'other')
  const list = join(T, 'private-list.txt')
  writeFileSync(list, '# none\n')
  const env = gateTestEnv({
    TALOS_MACHINE: 'cyclops',
    TALOS_CI_CACHE: join(T, 'cache'),
    GIT_CONFIG_GLOBAL: quoteConfig(quote),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  })
  const ok = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const scripts = (dir: string) => {
    for (const f of [
      'pre-push.sh',
      'gate.sh',
      'gate-push.sh',
      'talos-machine.sh',
      'path-fold.sh',
      'install-hooks.sh',
      'check-no-personal.sh',
      'denylist.generic.txt',
      'gate-inputs.txt',
      'gate-wide-inputs.txt',
    ]) {
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      cpSync(join(here, f), join(dir, 'scripts', f))
    }
    cpSync(join(here, 'gate'), join(dir, 'scripts/gate'), { recursive: true })
    cpSync(join(repoRoot, '.githooks'), join(dir, '.githooks'), { recursive: true })
  }
  mkdirSync(clone)
  ok(clone, 'init', '-q', '-b', 'main')
  scripts(clone)
  put(clone, 'apps/web/src/a.ts')
  put(clone, 'docs/a.md')
  put(clone, '.gitignore', 'node_modules\n')
  ok(clone, 'add', '-A')
  ok(clone, 'commit', '-qm', 'base')
  const origin = join(T, 'origin.git')
  ok(T, 'clone', '-q', '--bare', clone, origin)
  ok(clone, 'remote', 'add', 'origin', origin)
  ok(clone, 'fetch', '-q', 'origin')
  ok(clone, 'branch', '-q', '--set-upstream-to=origin/main', 'main')
  ok(T, 'clone', '-q', origin, other)
  const change = (dir: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) put(dir, f, t)
    ok(dir, 'add', '-A')
    ok(dir, 'commit', '-qm', 'change')
  }
  /** this change in the clone, then `files` pushed to main by the other machine, and the clone rebased onto it */
  const raced = (mine: Record<string, string>, theirs: Record<string, string>) => {
    change(clone, mine)
    const old = ok(clone, 'rev-parse', 'HEAD~1')
    change(other, theirs)
    ok(other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    ok(clone, 'fetch', '-q', 'origin')
    const now = ok(clone, 'rev-parse', 'origin/main')
    ok(clone, 'rebase', '-q', now)
    return { old, now }
  }
  const print = (name: string, old: string, now: string) =>
    spawnSync('bash', ['scripts/gate-push.sh'], {
      cwd: clone,
      env: { ...env, [name]: `${old},${now}` },
      encoding: 'utf8',
    })
  return { T, clone, other, list, env, ok, scripts, change, raced, print }
}

describe('gate-push.sh: the race decisions and the landing check read every name', () => {
  it.each(QUOTE)(
    'core.quotePath=%s: a new main commit to a gate input with a tab in its folder is a gate input',
    (quote) => {
      const r = pushSetup(quote)
      const { old, now } = r.raced({ 'apps/web/src/b.ts': 'y\n' }, { 'apps/x\ty/package.json': '{}\n' })
      const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
      expect(p.stdout).toContain('apps/x\ty/package.json, a gate-wide input')
      expect(p.stdout).toContain('rc=1')
    },
  )

  it.each(QUOTE)(
    'core.quotePath=%s: the same file on both sides, by an accented and a tab name, is the same file',
    (quote) => {
      for (const f of ['apps/web/src/é.ts', 'apps/web/src/a\tb.ts']) {
        const r = pushSetup(quote)
        put(r.clone, f, Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'))
        r.ok(r.clone, 'add', '-A')
        r.ok(r.clone, 'commit', '-qm', 'shared')
        r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
        r.ok(r.other, 'pull', '-q')
        const lines = (x: string) =>
          Array.from({ length: 12 }, (_, i) =>
            (i === 0 && x === 'mine') || (i === 11 && x === 'theirs') ? x : `line ${i}`,
          ).join('\n')
        const { old, now } = r.raced({ [f]: lines('mine') }, { [f]: lines('theirs') })
        const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
        expect(p.stdout, f).toContain(`changes ${f}, a file of this change`)
      }
    },
  )

  it.each(QUOTE)(
    'core.quotePath=%s: an e2e-only change with a tab name is e2e-only; words with a tab name are words',
    (quote) => {
      const r = pushSetup(quote)
      r.change(r.clone, { 'e2e/playwright.config.ts': 'export default {}\n' })
      r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
      r.ok(r.other, 'pull', '-q')
      const { old, now } = r.raced({ 'e2e/harness/a\tb.ts': 'y\n' }, { 'apps/windows/é\tx.ps1': 'x\n' })
      const p = r.print('GATE_PUSH_PRINT_RACE', old, now)
      expect(p.stdout.trim()).toBe('cheap')
      const w = pushSetup(quote)
      w.ok(w.other, 'pull', '-q')
      const m = w.raced({ 'docs/mine é.md': 'y\n' }, { 'docs/their\tnews.md': 'x\n' })
      expect(w.print('GATE_PUSH_PRINT_RACE', m.old, m.now).stdout.trim()).toBe('cheap')
    },
  )

  it.each(QUOTE)(
    'core.quotePath=%s: landing a handoff that changes a package.json under an odd folder is refused',
    (quote) => {
      for (const f of ['apps/é/package.json', 'apps/x\ty/package.json']) {
        const r = pushSetup(quote)
        r.change(r.other, { [f]: '{}\n' })
        r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/handoff/hestia/odd')
        const p = spawnSync('bash', ['scripts/gate.sh', '--push', '--from', 'origin/handoff/hestia/odd'], {
          cwd: r.clone,
          env: { ...r.env, CHECK_EXTRA_RULES: r.list },
          encoding: 'utf8',
        })
        expect(p.status, f).not.toBe(0)
        expect(p.stderr, f).toContain('changes the push path')
      }
    },
  )
})

describe('pre-push.sh: a handoff that changes the push path under an odd folder is refused', () => {
  it.each(QUOTE)('core.quotePath=%s', (quote) => {
    for (const f of ['apps/é/package.json', 'apps/x\ty/package.json', 'apps/x\ty/tsconfig.json']) {
      const r = pushSetup(quote)
      r.scripts(r.other)
      spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.other, env: r.env, encoding: 'utf8' })
      r.change(r.other, { [f]: '{}\n' })
      const p = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/handoff/hestia/odd'], {
        cwd: r.other,
        env: { ...r.env, CHECK_EXTRA_RULES: r.list },
        encoding: 'utf8',
      })
      expect(p.status, `${f}: ${p.stderr}`).not.toBe(0)
      expect(p.stderr, f).toContain('a handoff may not change the push path')
    }
  })

  it('a handoff with a newline in a file name cannot be read as lines: refused, never let through', () => {
    const r = pushSetup(true)
    r.scripts(r.other)
    spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.other, env: r.env, encoding: 'utf8' })
    r.change(r.other, { 'apps/x\ny/vite.a\nb.ts': 'x\n' })
    const p = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/handoff/hestia/nl'], {
      cwd: r.other,
      env: { ...r.env, CHECK_EXTRA_RULES: r.list },
      encoding: 'utf8',
    })
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('holds a newline')
  })

  it.each(QUOTE)(
    'core.quotePath=%s: a pushed name with a backslash or a * is that file only, not a pattern',
    (quote) => {
      const DISK = "the files on disk aren't what you are pushing"
      for (const f of ['apps/web/src/a\\b.ts', 'apps/web/src/a*.ts']) {
        const push = (edit: string) => {
          const r = pushSetup(quote)
          spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.clone, env: r.env, encoding: 'utf8' })
          // siblings the name would match as a pattern
          r.change(r.clone, { 'apps/web/src/ab.ts': 'x\n', 'apps/web/src/axb.ts': 'x\n' })
          r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
          r.change(r.clone, { [f]: 'pushed\n' })
          put(r.clone, edit, 'edited after the commit\n')
          return spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], {
            cwd: r.clone,
            env: { ...r.env, CHECK_EXTRA_RULES: r.list },
            encoding: 'utf8',
          })
        }
        const own = push(f) // the pushed file itself edited on disk: refused
        expect(own.status, `${f}: ${own.stderr}`).not.toBe(0)
        expect(own.stderr, f).toContain(DISK)
        // only a sibling edited (not part of this push): not this check's business (the gate goes on, and stops later here for
        // want of node_modules)
        expect(push('apps/web/src/axb.ts').stderr, f).not.toContain(DISK)
      }
    },
  )
})

describe('gate-push.sh: a new main commit with a newline in a file name', () => {
  it('fails the rebase-clean pass closed', () => {
    const r = pushSetup(true)
    const { old, now } = r.raced({ 'apps/web/src/b.ts': 'y\n' }, { 'apps/x\ny/vite.a\nb.ts': 'x\n' })
    const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
    expect(p.stdout).toContain('cannot list the new commits')
    expect(p.stdout).toContain('rc=1')
    expect(r.print('GATE_PUSH_PRINT_RACE', old, now).stdout.trim()).toBe('full')
  })
})

// the personal-data scans: a planted hit inside each odd name is found and named
const ODD = [ACCENT_BRIDGE, ACCENT_WEB, 'scripts/my dir/l.test.ts', TAB_WEB, DASH_DOC]

describe('check-no-personal.sh (the gate personal step) scans every odd name in a git checkout', () => {
  it.each(QUOTE)('core.quotePath=%s', (quote) => {
    const T = tmp('cnp-paths-')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: quoteConfig(quote), GIT_CONFIG_SYSTEM: '/dev/null' }
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: T, env })
    mkdirSync(join(T, 'scripts'))
    for (const f of ['check-no-personal.sh', 'denylist.generic.txt']) cpSync(join(here, f), join(T, 'scripts', f))
    for (const f of ODD) put(T, f, `one\nmail ${LEAK}\n`)
    spawnSync('git', ['add', '-A'], { cwd: T, env }) // tracked: listed by git ls-files
    put(T, 'docs/untracked é.md', `one\nmail ${LEAK}\n`) // untracked: listed too
    const r = spawnSync('bash', ['scripts/check-no-personal.sh'], { cwd: T, env, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(1)
    for (const f of [...ODD, 'docs/untracked é.md']) expect(r.stderr, f).toContain(`${f}:2`)
    expect(r.stderr).not.toContain(LEAK)
  })
})

describe('check-ref-personal.sh and personal-watch.sh find a hit in every odd name', () => {
  // as check-ref-personal.sh shows a name: a tab as %09 (so path:line can be split)
  const shown = (f: string) => f.replace(/\t/g, '%09')

  it.each(QUOTE)('core.quotePath=%s', (quote) => {
    const e = watchSetup()
    const env = { GIT_CONFIG_GLOBAL: quoteConfig(quote) }
    expect(watch(e, [], env).code).toBe(0) // the first pass takes main as it is
    const files: Record<string, string> = {}
    for (const f of ODD) files[f] = `one\nmail ${LEAK}\n`
    files['docs/private é.md'] = `x\ny\n${FAKE}\n` // the private list too
    const sha = e.commit(files)
    e.push()
    const ref = spawnSync('bash', [join(e.owner, 'scripts', 'check-ref-personal.sh'), sha, `${sha}~1`], {
      cwd: e.dev,
      env: { ...e.env, ...env },
      encoding: 'utf8',
    })
    expect(ref.status, ref.stderr).toBe(1)
    for (const f of ODD) expect(ref.stdout, f).toContain(`${s12(sha)} ${shown(f)}:2 [denylist.generic.txt rule line`)
    expect(ref.stdout).toContain(`${s12(sha)} docs/private é.md:3 ${RULE}`)
    const w = watch(e, [], env)
    expect(w.code).toBe(1)
    const seen = hits(w.out)
    for (const f of ODD)
      expect(
        seen.some((l) => l.includes(` ${s12(sha)} ${shown(f)}:2 `)),
        f,
      ).toBe(true)
    expect(seen.some((l) => l.includes(` docs/private é.md:3 ${RULE}`))).toBe(true)
    noValue(ref.stdout + ref.stderr + w.out + w.err)
    expect(ref.stdout + w.out).not.toContain(LEAK)
  })
})

// ---- the one list (scripts/gate-inputs.txt), matched as a Mac's disk matches names (scripts/path-fold.sh) -------------------
// A handoff is landed by another machine's gate, so a handoff that changes anything that gate sources, runs or reads its verdict
// from is refused: by the hook when pushed, by gate.sh --push --from when landed. APFS takes "Scripts/x.sh", a Kelvin-sign
// "pac<U+212A>age.json" and a long-s "<U+017F>cripts/" for scripts/x.sh, package.json and scripts/: on the landing Mac, checking out
// such a NEW name writes over the gate's own file. Names are put into commits with git's plumbing (no disk folding on the way in).
const KELVIN = 'K'
const LONG_S = 'ſ'
/** A commit of `files` on top of `parent` in `dir`, by plumbing: the names go in exactly as given, whatever the disk folds. */
function plumb(
  r: ReturnType<typeof pushSetup>,
  dir: string,
  parent: string,
  files: Record<string, string>,
  msg = 'plumbed',
) {
  const index = join(tmp('idx-'), 'index')
  const env = { ...r.env, GIT_INDEX_FILE: index }
  const g = (a: string[], input?: string) => {
    const p = spawnSync('git', ['-c', 'core.precomposeUnicode=false', ...a], { cwd: dir, env, encoding: 'utf8', input })
    if (p.status !== 0) throw new Error(`git ${a.join(' ')}: ${p.stderr}`)
    return p.stdout.trim()
  }
  g(['read-tree', parent])
  for (const [f, t] of Object.entries(files)) {
    const blob = g(['hash-object', '-w', '--stdin'], t)
    g(['update-index', '--add', '--cacheinfo', `100644,${blob},${f}`])
  }
  return g(['commit-tree', g(['write-tree']), '-p', parent, '-m', msg])
}
/** `files` as a handoff branch on origin, pushed past the hook (the landing machine's check is what is under test) */
const handoffOf = (r: ReturnType<typeof pushSetup>, files: Record<string, string>, msg?: string) => {
  const sha = plumb(r, r.clone, r.ok(r.clone, 'rev-parse', 'origin/main'), files, msg)
  r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', `${sha}:refs/heads/handoff/hestia/h`)
}
const land = (r: ReturnType<typeof pushSetup>) =>
  spawnSync('bash', ['scripts/gate.sh', '--push', '--from', 'origin/handoff/hestia/h'], {
    cwd: r.clone,
    env: { ...r.env, CHECK_EXTRA_RULES: r.list },
    encoding: 'utf8',
  })
/** `files` pushed as a handoff from the other machine, through its installed pre-push hook */
const hookPush = (r: ReturnType<typeof pushSetup>, files: Record<string, string>) => {
  r.scripts(r.other)
  spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.other, env: r.env, encoding: 'utf8' })
  const sha = plumb(r, r.other, r.ok(r.other, 'rev-parse', 'origin/main'), files)
  return spawnSync('git', ['push', '-q', 'origin', `${sha}:refs/heads/handoff/hestia/h`], {
    cwd: r.other,
    env: { ...r.env, CHECK_EXTRA_RULES: r.list },
    encoding: 'utf8',
  })
}
// what the gate sources or runs that the old five-name check missed, and the lookalikes a Mac's disk folds into a gate input
// the documented way to land a change to the push path (docs/CI-MACHINES.md, "A change to the push path from a slow machine")
const ROUTE =
  'Push a plain branch instead; the landing machine reads the scripts/ diff itself and lands it by cherry-pick (that read is the trust step).'
const SOURCED = ['scripts/talos-machine.sh', 'scripts/heavy-lock.sh', 'scripts/old-client.sh']
const LOOKALIKES = [
  `apps/new/pac${KELVIN}age.json`,
  `apps/new/package.j${LONG_S}on`,
  `.githoo${KELVIN}s/pre-push`,
  '.gitHooks/pre-push', // ASCII case
  `${LONG_S}cripts/gate.sh`,
  'Scripts/x.sh',
]

describe('a handoff that changes a gate input (scripts/gate-inputs.txt, folded) is refused', () => {
  it('landing: the scripts gate.sh sources and runs (talos-machine.sh, heavy-lock.sh, old-client.sh)', () => {
    for (const f of SOURCED) {
      const r = pushSetup(true)
      handoffOf(r, { [f]: 'echo handed\n' })
      const p = land(r)
      expect(p.status, `${f}: ${p.stderr}`).not.toBe(0)
      expect(p.stderr, f).toContain(`changes the push path (${f}, a gate input`)
      expect(p.stderr, f).toContain(ROUTE)
    }
  })

  it('the hook: the same scripts', () => {
    for (const f of SOURCED) {
      const p = hookPush(pushSetup(true), { [f]: 'echo handed\n' })
      expect(p.status, `${f}: ${p.stderr}`).not.toBe(0)
      expect(p.stderr, f).toContain(`a handoff may not change the push path (${f}, a gate input`)
      expect(p.stderr, f).toContain(ROUTE)
    }
  })

  it('landing and the hook: Kelvin-sign, long-s and case lookalikes of package.json, .githooks/ and scripts/', () => {
    for (const f of LOOKALIKES) {
      const r = pushSetup(true)
      handoffOf(r, { [f]: '{}\n' })
      const p = land(r)
      expect(p.status, `${f}: ${p.stderr}`).not.toBe(0)
      expect(p.stderr, f).toContain('changes the push path')
      const h = hookPush(pushSetup(true), { [f]: '{}\n' })
      expect(h.status, `${f}: ${h.stderr}`).not.toBe(0)
      expect(h.stderr, f).toContain('a handoff may not change the push path')
    }
  })

  it('landing and the hook: a Swift package manifest or its resolved pins (a Swift suite on the landed tree runs them)', () => {
    for (const f of [
      'apps/desktop/Package.swift',
      'apps/mobile/ios/New/Package.swift',
      'apps/desktop/Package.resolved',
    ]) {
      const r = pushSetup(true)
      handoffOf(r, { [f]: '// swift-tools-version:5.9\n' })
      const p = land(r)
      expect(p.status, `${f}: ${p.stderr}`).not.toBe(0)
      expect(p.stderr, f).toContain(`changes the push path (${f}, a gate input`)
      const h = hookPush(pushSetup(true), { [f]: '// swift-tools-version:5.9\n' })
      expect(h.status, `${f}: ${h.stderr}`).not.toBe(0)
      expect(h.stderr, f).toContain('a handoff may not change the push path')
    }
  })

  it("landing prints the handoff's subject with its control characters (ESC included) made harmless", () => {
    const r = pushSetup(true)
    handoffOf(r, { 'apps/web/src/new.ts': 'x\n' }, 'subject \u001b]0;owned\u0007 \u001b[2Jcleared\ttab')
    const p = land(r)
    const line = p.stderr.split('\n').find((l) => l.includes('landing origin/handoff/hestia/h')) ?? ''
    expect(line, p.stderr).toContain('subject ?]0;owned? ?[2Jcleared?tab')
    // no control character anywhere in the output but newline and tab
    const controls = [...p.stderr].filter((c) => {
      const n = c.charCodeAt(0)
      return (n < 32 && c !== '\n' && c !== '\t') || n === 127
    })
    expect(controls).toEqual([])
  })

  it('a handoff of an ordinary file still lands as far as the gate (the check refuses only gate inputs)', () => {
    const r = pushSetup(true)
    handoffOf(r, { 'apps/web/src/new.ts': 'export const a = 1\n', [`apps/web/src/caf${'é'}.ts`]: 'x\n' })
    const p = land(r)
    expect(p.stderr).not.toContain('changes the push path')
    expect(p.stderr).toContain('landing origin/handoff/hestia/h')
    const h = hookPush(pushSetup(true), { 'apps/web/src/new.ts': 'export const a = 1\n' })
    expect(h.status, h.stderr).toBe(0)
  })

  it("landing reads main's list, never the handoff's: a handoff that empties the list is refused for that", () => {
    const r = pushSetup(true)
    handoffOf(r, { 'scripts/gate-inputs.txt': '^nothing$\n', 'apps/x/package.json': '{}\n' })
    const p = land(r)
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('changes the push path')
  })

  it('landing: a file name with a newline in the handoff is refused before anything is checked out', () => {
    const r = pushSetup(true)
    handoffOf(r, { 'apps/x\ny/a.ts': 'x\n' })
    const p = land(r)
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('holds a newline')
    expect(p.stderr).not.toContain('landing origin/handoff')
  })

  it('no node of the repo major: the hook refuses (never a pass for want of a matcher)', () => {
    const r = pushSetup(true)
    r.scripts(r.other)
    writeFileSync(join(r.other, '.nvmrc'), '7\n') // a major no machine has: path-fold.sh finds no node for it
    const p = hookPush(r, { 'apps/web/src/new.ts': 'x\n' })
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('could not be checked against the gate-inputs list')
  })
})

describe('the rebase-clean pass matches names folded', () => {
  /** this change (mine) on top of a main that moved from old to now with `theirs`, all by plumbing */
  const racedPlumbed = (
    r: ReturnType<typeof pushSetup>,
    mine: Record<string, string>,
    theirs: Record<string, string>,
  ) => {
    const old = r.ok(r.clone, 'rev-parse', 'HEAD')
    const now = plumb(r, r.clone, old, theirs)
    r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', `${now}:refs/heads/main`)
    r.ok(r.clone, 'fetch', '-q', 'origin')
    r.ok(r.clone, 'update-ref', 'refs/heads/main', plumb(r, r.clone, now, mine))
    return { old, now }
  }

  it('a new main commit to Scripts/gate.sh (or a long-s scripts/) is a gate-wide input: the pass is refused', () => {
    for (const f of ['Scripts/gate.sh', `${LONG_S}cripts/gate.sh`, `apps/new/pac${KELVIN}age.json`]) {
      const r = pushSetup(true)
      const { old, now } = racedPlumbed(r, { 'apps/web/src/b.ts': 'y\n' }, { [f]: 'x\n' })
      const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
      expect(p.stdout, f).toContain(`changes ${f}, a gate-wide input`)
      expect(p.stdout, f).toContain('rc=1')
    }
  })

  it('a new main commit to another gate input spelled by folding (Scripts/x.sh) is not gate-wide: the pass', () => {
    const r = pushSetup(true)
    const { old, now } = racedPlumbed(r, { 'apps/web/src/b.ts': 'y\n' }, { 'Scripts/x.sh': 'x\n' })
    const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
    expect(p.stdout).toContain('rc=0')
  })

  it('an é composed (NFC) in this change and decomposed (NFD) in a new main commit is the same file', () => {
    const r = pushSetup(true)
    const nfc = 'apps/web/src/café.ts'
    const nfd = 'apps/web/src/café.ts'
    expect(nfc).not.toBe(nfd)
    const { old, now } = racedPlumbed(r, { [nfc]: 'mine\n' }, { [nfd]: 'theirs\n' })
    const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
    expect(p.stdout).toContain(`changes ${nfd}, a file of this change`)
    expect(p.stdout).toContain('rc=1')
  })

  it('a new main commit to an unrelated ordinary file still passes (the fold refuses only what it should)', () => {
    const r = pushSetup(true)
    const { old, now } = racedPlumbed(r, { 'apps/web/src/b.ts': 'y\n' }, { 'apps/web/src/c.ts': 'x\n' })
    const p = r.print('GATE_PUSH_PRINT_CLEAN', old, now)
    expect(p.stdout).toContain('none touching a file of this change or a gate-wide input')
    expect(p.stdout).toContain('rc=0')
  })
})

describe('gate.sh --plan: a changed file name with a newline is refused (Fable R1-4)', () => {
  it('refuses, naming the file, rather than planning it as two lines', () => {
    const T = tmp('gate-nl-')
    const env = gateTestEnv({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    })
    const git = (...a: string[]) => spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(T, 'scripts'))
    for (const f of ['gate.sh', 'talos-machine.sh']) cpSync(join(here, f), join(T, 'scripts', f))
    cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
    put(T, 'apps/web/src/a.ts')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD').stdout.trim()
    put(T, 'apps/web/src/c\nd.ts')
    git('add', '-A')
    git('commit', '-qm', 'change')
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base], { cwd: T, env, encoding: 'utf8' })
    expect(p.status, p.stdout).not.toBe(0)
    expect(p.stderr).toContain('a changed file name holds a newline (apps/web/src/c?d.ts)')
    expect(p.stdout).not.toContain('vitest')
  })
})

// ---- Fable R1: the check reads every commit, not the net diff; no merges; a belt after the rebase; no hooks while landing ----
// `git rebase` drops merge commits and replays the side commits, so a net diff (merge base .. tip) can hide a gate input that a
// side commit changes and the merge puts back: after the rebase the side commit's version is on disk, and the gate runs it.
/** a commit with this exact tree and these parents, in `dir` */
const commitTree = (r: ReturnType<typeof pushSetup>, dir: string, tree: string, parents: string[], msg = 'plumbed') =>
  r.ok(dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', msg)
const treeOf = (r: ReturnType<typeof pushSetup>, dir: string, c: string) => r.ok(dir, 'rev-parse', `${c}^{tree}`)
/** the handoff branch on origin at `sha`, pushed past the hook */
const handoffAt = (r: ReturnType<typeof pushSetup>, sha: string) =>
  r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', `${sha}:refs/heads/handoff/hestia/h`)
/** a handoff `build` makes on top of main in the other clone, pushed through its installed hook */
const hookPushBuilt = (r: ReturnType<typeof pushSetup>, build: (dir: string, base: string) => string) => {
  r.scripts(r.other)
  spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.other, env: r.env, encoding: 'utf8' })
  const sha = build(r.other, r.ok(r.other, 'rev-parse', 'origin/main'))
  return spawnSync('git', ['push', '-q', 'origin', `${sha}:refs/heads/handoff/hestia/h`], {
    cwd: r.other,
    env: { ...r.env, CHECK_EXTRA_RULES: r.list },
    encoding: 'utf8',
  })
}
// the builds, each on top of `base` in `dir`
const evilMerge = (marker: string) => (r: ReturnType<typeof pushSetup>, dir: string, base: string) => {
  const evil = `#!/usr/bin/env bash\necho ran > '${marker}'\nexit 0\n`
  const side = plumb(r, dir, base, { 'scripts/gate.sh': evil, 'apps/web/src/p.ts': 'export const p = 1\n' })
  // the merge's tree: the side commit's, with main's gate.sh put back byte for byte (its own blob, mode and all)
  const env = { ...r.env, GIT_INDEX_FILE: join(tmp('idx-'), 'index') }
  const g = (...a: string[]) => {
    const p = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' })
    if (p.status !== 0) throw new Error(`git ${a.join(' ')}: ${p.stderr}`)
    return p.stdout.trim()
  }
  g('read-tree', side)
  const [mode, , blob] = g('ls-tree', base, 'scripts/gate.sh').split(/\s+/)
  g('update-index', '--cacheinfo', `${mode},${blob},scripts/gate.sh`)
  const merged = g('write-tree')
  expect(g('diff-tree', '--name-only', '-r', base, merged)).toBe('apps/web/src/p.ts') // the net diff hides gate.sh
  return commitTree(r, dir, merged, [base, side], 'merge')
}
const plainMerge = (r: ReturnType<typeof pushSetup>, dir: string, base: string) => {
  const a = plumb(r, dir, base, { 'apps/web/src/a2.ts': 'x\n' })
  const b = plumb(r, dir, base, { 'apps/web/src/b2.ts': 'y\n' })
  const both = plumb(r, dir, a, { 'apps/web/src/b2.ts': 'y\n' })
  return commitTree(r, dir, treeOf(r, dir, both), [a, b], 'merge')
}
const transient = (r: ReturnType<typeof pushSetup>, dir: string, base: string) => {
  const added = plumb(r, dir, base, { '.githooks/post-commit': '#!/bin/sh\necho hi\n', 'apps/web/src/t.ts': 'x\n' })
  const keep = plumb(r, dir, base, { 'apps/web/src/t.ts': 'x\n' })
  return commitTree(r, dir, treeOf(r, dir, keep), [added], 'drop the hook again')
}

describe('Fable R1: a handoff is checked commit by commit, holds no merge, and lands with no hook run', () => {
  it('an evil merge (a side commit changes scripts/gate.sh, the merge puts it back) is refused at landing and by the hook', () => {
    const r = pushSetup(true)
    const marker = join(r.T, 'evil-gate-ran')
    // main moves on after the handoff's base, so the landing really rebases (on the base itself, git would keep the merge)
    r.change(r.other, { 'apps/web/src/m.ts': 'x\n' })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'fetch', '-q', 'origin')
    const main = r.ok(r.clone, 'rev-parse', 'origin/main')
    handoffAt(r, evilMerge(marker)(r, r.clone, r.ok(r.clone, 'rev-parse', `${main}~1`)))
    const p = land(r)
    expect(p.status, p.stderr).not.toBe(0)
    expect(existsSync(marker), 'the handoff gate.sh ran').toBe(false)
    r.ok(r.clone, 'fetch', '-q', 'origin')
    expect(r.ok(r.clone, 'rev-parse', 'origin/main')).toBe(main)
    const h2 = pushSetup(true)
    const h = hookPushBuilt(h2, (dir, base) => evilMerge(marker)(h2, dir, base))
    expect(h.status, h.stderr).not.toBe(0)
    expect(h.stderr).toContain('REFUSED')
  })

  it('a merge commit in a handoff is refused outright, even one that touches no gate input', () => {
    const r = pushSetup(true)
    handoffAt(r, plainMerge(r, r.clone, r.ok(r.clone, 'rev-parse', 'origin/main')))
    const p = land(r)
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('holds a merge commit')
    const h2 = pushSetup(true)
    const h = hookPushBuilt(h2, (dir, base) => plainMerge(h2, dir, base))
    expect(h.status, h.stderr).not.toBe(0)
    expect(h.stderr).toContain('holds a merge commit')
  })

  it('a gate input added and deleted again inside the handoff (net diff: nothing) is refused at landing and by the hook', () => {
    const r = pushSetup(true)
    handoffAt(r, transient(r, r.clone, r.ok(r.clone, 'rev-parse', 'origin/main')))
    const p = land(r)
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('changes the push path (.githooks/post-commit, a gate input')
    const h2 = pushSetup(true)
    const h = hookPushBuilt(h2, (dir, base) => transient(h2, dir, base))
    expect(h.status, h.stderr).not.toBe(0)
    expect(h.stderr).toContain('a handoff may not change the push path (.githooks/post-commit, a gate input')
  })

  it('the belt after the rebase: HEAD may differ from main in no gate input (folded), and may in anything else', () => {
    for (const [f, refused] of [
      ['scripts/x.sh', true],
      ['Scripts/y.sh', true],
      ['.gitattributes', true],
      ['apps/web/src/fine.ts', false],
    ] as const) {
      const r = pushSetup(true)
      const main = r.ok(r.clone, 'rev-parse', 'HEAD')
      r.ok(r.clone, 'update-ref', 'refs/heads/main', plumb(r, r.clone, main, { [f]: 'x\n' }))
      const p = spawnSync('bash', ['scripts/gate-push.sh'], {
        cwd: r.clone,
        env: { ...r.env, GATE_PUSH_PRINT_BELT: main },
        encoding: 'utf8',
      })
      expect(p.stdout, f).toContain(refused ? 'rc=1' : 'rc=0')
      if (refused) expect(p.stdout, f).toContain(`${f}, a gate input`)
    }
  })

  it('landing runs no git hook: the checkout and the rebase run with hooks off', () => {
    const r = pushSetup(true)
    const marker = join(r.T, 'hook-ran')
    // main carries hooks that would write the marker, and the landing clone runs hooks from .githooks
    for (const h of ['post-checkout', 'post-rewrite', 'post-merge', 'pre-rebase']) {
      put(r.other, `.githooks/${h}`, `#!/bin/sh\necho ${h} >> '${marker}'\n`)
      chmodSync(join(r.other, `.githooks/${h}`), 0o755)
    }
    r.ok(r.other, 'add', '-A')
    r.ok(r.other, 'commit', '-qm', 'hooks')
    put(r.other, 'apps/web/src/m.ts', 'x\n') // one more main commit after them, so the handoff below needs a real rebase
    r.ok(r.other, 'add', '-A')
    r.ok(r.other, 'commit', '-qm', 'more')
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q')
    expect(existsSync(marker), 'a hook ran before the test (the pull)').toBe(false)
    r.ok(r.clone, 'config', 'core.hooksPath', '.githooks')
    // a control: with these hooks, a plain checkout in this clone does run one
    r.ok(r.clone, 'checkout', '-q', '--detach', 'HEAD')
    expect(existsSync(marker), 'the control hook did not run').toBe(true)
    rmSync(marker)
    r.ok(r.clone, 'checkout', '-q', 'main')
    rmSync(marker)
    // the handoff is based on the main before the last commit (hooks in its tree too), so the landing really rebases it
    const old = r.ok(r.clone, 'rev-parse', 'HEAD~1')
    handoffAt(r, plumb(r, r.clone, old, { 'apps/web/src/landed.ts': 'x\n' }))
    const p = land(r)
    expect(p.stderr).toContain('landing origin/handoff/hestia/h')
    expect(
      existsSync(marker),
      `a hook ran while landing: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`,
    ).toBe(false)
  })
})

// ---- a handoff force-pushed over its old ref after a rebase onto a newer main (Hestia, after d2cbda6b) ----------------------
// The hook used to read the handoff as <old ref>..<new tip>. After a rebase onto a main that gained a scripts/ commit, that range
// holds main's new commits too, so the push was refused for gate inputs the handoff never touched. The range is now
// <remote's main>..<new tip>: every commit the handoff has on top of main, each checked, and nothing main already has.
describe('pre-push.sh: a rebased handoff force-pushed over its old ref', () => {
  /** the other machine: hooks installed, `sha` pushed (forced) to the handoff ref through its hook */
  const forcePush = (r: ReturnType<typeof pushSetup>, sha: string) =>
    spawnSync('git', ['push', '-q', 'origin', `+${sha}:refs/heads/handoff/hestia/h`], {
      cwd: r.other,
      env: { ...r.env, CHECK_EXTRA_RULES: r.list },
      encoding: 'utf8',
    })
  /** the other machine's handoff on main (pushed through its hook), then main gains a scripts/ commit from the clone */
  const handedThenMainMoves = () => {
    const r = pushSetup(true)
    r.scripts(r.other)
    const inst = spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.other, env: r.env, encoding: 'utf8' })
    expect(inst.status, inst.stderr).toBe(0)
    const m0 = r.ok(r.other, 'rev-parse', 'origin/main')
    const h1 = plumb(r, r.other, m0, { 'apps/web/src/h.ts': 'export const h = 1\n' }, 'the handoff')
    const first = forcePush(r, h1)
    expect(first.status, first.stderr).toBe(0)
    r.change(r.clone, { 'scripts/gate-inputs.test.ts': '// main moved on\n' })
    r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.other, 'fetch', '-q', 'origin')
    const m1 = r.ok(r.other, 'rev-parse', 'origin/main')
    expect(m1).not.toBe(m0)
    return { r, m0, m1, h1 }
  }

  it("rebased onto the newer main and force-pushed: allowed (main's own scripts/ commit is not the handoff's)", () => {
    const { r, m1 } = handedThenMainMoves()
    const h2 = plumb(r, r.other, m1, { 'apps/web/src/h.ts': 'export const h = 1\n' }, 'the handoff')
    const p = forcePush(r, h2)
    expect(p.stderr).not.toContain('REFUSED')
    expect(p.status, p.stderr).toBe(0)
    expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/heads/handoff/hestia/h').split(/\s/)[0]).toBe(h2)
  })

  it('rebased the same way, but the handoff itself touches scripts/: refused', () => {
    const { r, m1 } = handedThenMainMoves()
    const h2 = plumb(r, r.other, m1, { 'apps/web/src/h.ts': 'export const h = 1\n', 'scripts/x.sh': 'echo x\n' })
    const p = forcePush(r, h2)
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('a handoff may not change the push path (scripts/x.sh, a gate input')
  })

  it('not rebased (still on the old main): every commit it has on top of main is checked, the old ref one included', () => {
    const { r, m0 } = handedThenMainMoves()
    // the old ref holds a gate-input commit that got onto origin past the hook; the new push only adds a plain commit on top of
    // it. Reading <old ref>..<new tip> would see the plain commit alone; every commit on top of main includes the bad one.
    const bad = plumb(r, r.other, m0, { 'scripts/y.sh': 'echo y\n' }, 'past the hook')
    r.ok(r.other, 'push', '-q', '--no-verify', '-f', 'origin', `${bad}:refs/heads/handoff/hestia/h`)
    const h2 = plumb(r, r.other, bad, { 'apps/web/src/h2.ts': 'x\n' })
    const p = forcePush(r, h2)
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('a handoff may not change the push path (scripts/y.sh, a gate input')
    // and a plain extension of a clean old-base handoff still goes through, its new commit checked
    const { r: r2, h1 } = handedThenMainMoves()
    const ok = forcePush(r2, plumb(r2, r2.other, h1, { 'apps/web/src/h3.ts': 'x\n' }))
    expect(ok.status, ok.stderr).toBe(0)
    const no = forcePush(r2, plumb(r2, r2.other, h1, { 'scripts/z.sh': 'echo z\n' }))
    expect(no.status, no.stderr).not.toBe(0)
    expect(no.stderr).toContain('a handoff may not change the push path (scripts/z.sh, a gate input')
  })

  it('a merge, force-pushed over the old ref on top of the newer main: still refused', () => {
    const { r, m1 } = handedThenMainMoves()
    const p = forcePush(r, plainMerge(r, r.other, m1))
    expect(p.status, p.stderr).not.toBe(0)
    expect(p.stderr).toContain('holds a merge commit')
  })
})
