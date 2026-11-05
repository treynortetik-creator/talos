// `talos-app rollback` and the record of healthy starts it depends on. Real git in a throwaway repository; pnpm is a
// recorder. Nothing here touches the checkout this test runs from or any installed Talos.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { Duplex } from 'node:stream'
import { loadExampleConfig } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { GOOD_STARTS_KEEP, readGoodStarts, recordHealthyStart } from '../src/good-starts.ts'
import { createLogger } from '../src/log.ts'
import { DEFAULT_ASK_RULES, planAskRules } from '../src/permission/ask-rules.ts'
import { lostFields } from '../src/rollback.ts'
import { REPO_DIR } from '../src/version.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@e.x', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** A checkout on `main` with a first commit; `commit(name)` adds one more and returns its full sha. */
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'talos-rb-')))
  sh(dir, 'init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'apps', 'bridge', 'src'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'bridge', 'package.json'), '{"name":"x","version":"0.0.0"}')
  writeFileSync(join(dir, 'apps', 'bridge', 'src', 'version.ts'), '// stand-in')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'one')
  const head = () => sh(dir, 'rev-parse', 'HEAD')
  const commit = (name: string) => {
    writeFileSync(join(dir, name), name)
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-q', '-m', name)
    return head()
  }
  return { dir, head, commit, short: (s = head()) => s.slice(0, 7) }
}

const goodFile = (home: string) => join(home, 'good-starts.json')
const entry = (repo: string, commit: string, at = '2026-01-01T00:00:00.000Z') => ({ commit, repo, recorded_at: at })
const writeRecord = (home: string, starts: unknown[]) =>
  writeFileSync(goodFile(home), JSON.stringify({ v: 1, starts }), { mode: 0o600 })

function harness(
  repoDir: string,
  home: string,
  pnpmCode = 0,
  answer = 'y',
  tamper?: (cmd: string[], cwd: string) => void,
) {
  const calls: string[][] = []
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const deps = {
    rollback: {
      repoDir,
      run: (cmd: string[], cwd: string) => {
        calls.push(cmd)
        // git and the settings check are real; pnpm is a recorder
        if (cmd[0] !== 'pnpm') {
          const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
          tamper?.(cmd, cwd)
          return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}`.trim() }
        }
        return { code: pnpmCode, out: pnpmCode ? 'ERR_PNPM_OUTDATED_LOCKFILE' : '' }
      },
    },
  }
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    prompt: async (q: string) => {
      asked.push(q)
      return answer
    },
    sleep: async () => {},
    now: () => Date.now(),
  }
  const runRaw = (...args: string[]) => runCli(['rollback', ...args], io, { TALOS_APP_HOME: home }, deps)
  // most tests are about what happens after the owner agreed
  const run = (...args: string[]) => runRaw('--yes', ...args)
  return { calls, out, err, asked, run, runRaw, deps, text: () => out.join('\n') }
}

/** Every file under a folder with a hash of its bytes and its mtime, so a rewrite of identical bytes still shows. */
function snapshot(dir: string): Record<string, string> {
  const seen: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else seen[relative(dir, p)] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}@${st.mtimeMs}`
    }
  }
  walk(dir)
  return seen
}

describe('recording a healthy start', () => {
  test('writes the full commit, newest first, and a commit that starts again moves to the front', () => {
    const w = world()
    const first = w.head()
    const second = w.commit('two')
    const home = tempHome()
    const at = (n: number) => () => `2026-01-0${n}T00:00:00.000Z`
    sh(w.dir, 'checkout', '-q', first)
    expect(
      recordHealthyStart({ file: goodFile(home), repoDir: w.dir, started: first.slice(0, 7), now: at(1) }),
    ).toEqual({
      ok: true,
    })
    sh(w.dir, 'checkout', '-q', second)
    recordHealthyStart({ file: goodFile(home), repoDir: w.dir, started: second.slice(0, 7), now: at(2) })
    sh(w.dir, 'checkout', '-q', first)
    recordHealthyStart({ file: goodFile(home), repoDir: w.dir, started: first.slice(0, 7), now: at(3) })
    expect(readGoodStarts(goodFile(home))).toEqual([entry(w.dir, first, at(3)()), entry(w.dir, second, at(2)())])
    expect((statSync(goodFile(home)).mode & 0o777).toString(8)).toBe('600')
  })

  test('keeps only the newest few', () => {
    const w = world()
    const home = tempHome()
    for (let i = 0; i < GOOD_STARTS_KEEP + 3; i++) {
      const sha = w.commit(`c${i}`)
      recordHealthyStart({
        file: goodFile(home),
        repoDir: w.dir,
        started: sha.slice(0, 7),
        now: () => `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
    }
    const kept = readGoodStarts(goodFile(home))
    expect(kept).toHaveLength(GOOD_STARTS_KEEP)
    expect(kept[0]?.commit).toBe(w.head())
  })

  test('records nothing when the running code is not a commit: edited files, a moved checkout, or no git commit known', () => {
    const w = world()
    const started = w.head().slice(0, 7)
    const home = tempHome()
    writeFileSync(join(w.dir, 'apps', 'bridge', 'package.json'), '{"edited":true}')
    const dirty = recordHealthyStart({ file: goodFile(home), repoDir: w.dir, started })
    expect(dirty.ok).toBe(false)
    sh(w.dir, 'checkout', '-q', '--', '.')
    w.commit('two') // a pull landed after this process started
    expect(recordHealthyStart({ file: goodFile(home), repoDir: w.dir, started }).ok).toBe(false)
    expect(recordHealthyStart({ file: goodFile(home), repoDir: w.dir, started: undefined }).ok).toBe(false)
    expect(existsSync(goodFile(home))).toBe(false)
  })

  test('a file that is torn, the wrong version, or carries a value that is not a full commit id reads as empty entries', () => {
    const home = tempHome()
    writeFileSync(goodFile(home), '{"v":1,"starts":[')
    expect(readGoodStarts(goodFile(home))).toEqual([])
    writeFileSync(goodFile(home), JSON.stringify({ v: 2, starts: [entry('/r', 'a'.repeat(40))] }))
    expect(readGoodStarts(goodFile(home))).toEqual([])
    // a value git would read as an option must never reach `git checkout`
    writeRecord(home, [entry('/r', '--orphan=x'), entry('/r', 'abc1234'), entry('/r', 'b'.repeat(40))])
    expect(readGoodStarts(goodFile(home)).map((s) => s.commit)).toEqual(['b'.repeat(40)])
    // the time is printed to the terminal: anything but a plain timestamp (escape codes, say) is dropped
    writeRecord(home, [entry('/r', 'c'.repeat(40), '\u001b[2Jhello'), entry('/r', 'd'.repeat(40))])
    expect(readGoodStarts(goodFile(home)).map((s) => s.commit)).toEqual(['d'.repeat(40)])
  })
})

describe('talos-app rollback', () => {
  test('goes to the newest healthy version that is not the current one, installs, and leaves the branch where it was', async () => {
    const w = world()
    const good1 = w.head()
    const good2 = w.commit('two')
    const broken = w.commit('three') // never started cleanly: not in the record
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good2), entry(w.dir, good1)])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(0)
    expect(w.head()).toBe(good2)
    expect(sh(w.dir, 'rev-parse', 'main')).toBe(broken) // nothing was thrown away
    const checkout = h.calls.findIndex((c) => c[0] === 'git' && c.includes('checkout'))
    const install = h.calls.findIndex((c) => c.join(' ') === 'pnpm install --frozen-lockfile')
    expect(checkout).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(checkout)
    const text = h.text()
    expect(text).toContain(`${w.short(broken)} -> ${w.short(good2)}`)
    expect(text).toContain('Restart the agent')
    expect(text).toContain('git switch main')
    // going forward installs packages before the new code runs, and a commit made here belongs to no branch
    expect(text.indexOf('pnpm install --frozen-lockfile')).toBeGreaterThan(text.indexOf('git switch main'))
    expect(text.indexOf('talos-app update')).toBeGreaterThan(text.indexOf('pnpm install --frozen-lockfile'))
    expect(text).toContain('git switch -c')
    expect(text).toContain(home) // says where the untouched data is
    // git and pnpm only: no kill, no push, no reset
    expect(h.calls.every((c) => c[0] === 'git' || c[0] === 'pnpm')).toBe(true)
    expect(h.calls.some((c) => c.includes('reset') || c.includes('push') || c.includes('clean'))).toBe(false)
  })

  test('a version that started cleanly but misbehaves is skipped too: the newest record that differs from HEAD wins', async () => {
    const w = world()
    const good1 = w.head()
    const good2 = w.commit('two')
    const misbehaves = w.commit('three')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, misbehaves), entry(w.dir, good2), entry(w.dir, good1)])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(0)
    expect(w.head()).toBe(good2)
  })

  test('refuses when tracked files are edited or staged, and discards nothing', async () => {
    const w = world()
    const good = w.head()
    w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    const file = join(w.dir, 'apps', 'bridge', 'package.json')
    writeFileSync(file, '{"my":"unsaved work"}')
    const head = w.head()
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('changes that are not committed')
    expect(readFileSync(file, 'utf8')).toBe('{"my":"unsaved work"}')
    expect(w.head()).toBe(head)
    expect(h.calls.some((c) => c.includes('checkout'))).toBe(false)
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
    // staged only (a new file that was `git add`ed) counts as work too
    sh(w.dir, 'checkout', '-q', '--', '.')
    writeFileSync(join(w.dir, 'new.ts'), 'x')
    sh(w.dir, 'add', 'new.ts')
    const again = harness(w.dir, home)
    expect(await again.run()).toBe(1)
    expect(existsSync(join(w.dir, 'new.ts'))).toBe(true)
  })

  test('does not touch the data folder: same files, same bytes, same times, nothing added', async () => {
    const w = world()
    const good = w.head()
    w.commit('two')
    const home = tempHome()
    mkdirSync(join(home, 'media'))
    writeFileSync(join(home, 'history.sqlite'), 'rows')
    writeFileSync(join(home, 'bridge.key'), 'secret')
    writeFileSync(join(home, 'bridge.env'), 'TALOS_APP_RELAY_URL=https://relay.example.com\n')
    writeFileSync(join(home, 'devices.json'), '{}')
    writeFileSync(join(home, 'media', 'a.png'), 'png')
    writeRecord(home, [entry(w.dir, good)])
    const before = snapshot(home)
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(0)
    expect(snapshot(home)).toEqual(before)
  })

  test('says so and changes nothing when no earlier healthy version is recorded', async () => {
    const w = world()
    w.commit('two')
    const home = tempHome()
    const head = w.head()
    const none = harness(w.dir, home)
    expect(await none.run()).toBe(1)
    expect(none.err.join('\n')).toContain('no earlier version')
    // only the current version on record: still nothing to go back to
    writeRecord(home, [entry(w.dir, head)])
    const same = harness(w.dir, home)
    expect(await same.run()).toBe(1)
    expect(w.head()).toBe(head)
    expect(none.calls.concat(same.calls).some((c) => c.includes('checkout') || c[0] === 'pnpm')).toBe(false)
  })

  test('skips a record that git no longer has and one that belongs to another checkout', async () => {
    const w = world()
    const good = w.head()
    const other = w.commit('two') // valid in this repository, but recorded by a different folder
    w.commit('three')
    const home = tempHome()
    writeRecord(home, [
      entry(w.dir, 'f'.repeat(40)), // gone
      entry(join(w.dir, 'elsewhere'), other), // someone else's
      entry(w.dir, good),
    ])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(0)
    expect(w.head()).toBe(good)
  })

  test('--dry-run says what it would do and runs no checkout or install', async () => {
    const w = world()
    const good = w.head()
    const broken = w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    const h = harness(w.dir, home)
    expect(await h.run('--dry-run')).toBe(0)
    expect(w.head()).toBe(broken)
    expect(h.text()).toContain(`${w.short(broken)} -> ${w.short(good)}`)
    expect(h.text()).toContain('nothing was changed')
    expect(h.calls.some((c) => c.includes('checkout') || c[0] === 'pnpm')).toBe(false)
  })

  test('a failed install is reported honestly: the code is already back, and the message says what to run', async () => {
    const w = world()
    const good = w.head()
    w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    const h = harness(w.dir, home, 1)
    expect(await h.run()).toBe(1)
    expect(w.head()).toBe(good)
    expect(h.err.join('\n')).toContain(`pnpm install --frozen-lockfile`)
    expect(h.err.join('\n')).toContain(w.short(good))
    expect(h.err.join('\n')).toContain('do not run rollback again')
  })

  test('refuses a folder that is not its own checkout', async () => {
    const w = world()
    const home = tempHome()
    const sub = join(w.dir, 'apps', 'bridge', 'src')
    const h = harness(sub, home) // a subfolder: git's top level is not the folder given
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('not running from its own git checkout')
  })
})

describe('rollback gives honest reasons and never harms the checkout', () => {
  test('records that exist but are not in this history (a local rebase) say so, not that nothing is recorded', async () => {
    const w = world()
    const base = w.head()
    sh(w.dir, 'checkout', '-q', '-b', 'side')
    const side = w.commit('side')
    sh(w.dir, 'checkout', '-q', 'main')
    w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, side)])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    const msg = h.err.join('\n')
    expect(msg).toContain('none is in the history')
    expect(msg).toContain('rebased')
    expect(msg).not.toContain('no earlier version')
    expect(w.head()).not.toBe(base)
  })

  test('refuses, changing nothing, when the older version tracks a path where an ignored file sits', async () => {
    const w = world()
    const old = w.commit('settings.cfg') // the older version tracks settings.cfg
    sh(w.dir, 'rm', '-q', 'settings.cfg')
    writeFileSync(join(w.dir, '.gitignore'), 'settings.cfg\n')
    sh(w.dir, 'add', '.')
    sh(w.dir, 'commit', '-q', '-m', 'ignore it')
    writeFileSync(join(w.dir, 'settings.cfg'), 'mine, never committed')
    const head = w.head()
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('settings.cfg')
    expect(readFileSync(join(w.dir, 'settings.cfg'), 'utf8')).toBe('mine, never committed')
    expect(w.head()).toBe(head)
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
  })

  // The older version tracks `tracked`; the newer one removed them and ignores `ignoredPaths`, where the owner has `mine`.
  const blocked = async (name: string, setup: (dir: string) => void, expectNamed: string) => {
    test(`refuses, changing nothing, when ${name}`, async () => {
      const w = world()
      setup(w.dir)
      const old = w.head()
      sh(w.dir, 'rm', '-rq', '--', ...sh(w.dir, 'ls-files', '-z', '--', ':!apps').split('\0').filter(Boolean))
      writeFileSync(join(w.dir, '.gitignore'), 'data\ncafé.cfg\nlink2\n')
      sh(w.dir, 'add', '.')
      sh(w.dir, 'commit', '-q', '-m', 'drop and ignore')
      const head = w.head()
      writeFileSync(join(w.dir, 'café.cfg'), 'mine')
      writeFileSync(join(w.dir, 'data'), 'mine')
      symlinkSync('nowhere', join(w.dir, 'link2'))
      const home = tempHome()
      writeRecord(home, [entry(w.dir, old)])
      const h = harness(w.dir, home)
      expect(await h.run()).toBe(1)
      expect(h.err.join('\n')).toContain(expectNamed)
      expect(readFileSync(join(w.dir, 'café.cfg'), 'utf8')).toBe('mine')
      expect(readFileSync(join(w.dir, 'data'), 'utf8')).toBe('mine')
      expect(readlinkSync(join(w.dir, 'link2'))).toBe('nowhere')
      expect(w.head()).toBe(head)
      expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
    })
  }
  const track = (dir: string, rel: string, text = 'old') => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
    sh(dir, 'add', '-f', '--', rel)
    sh(dir, 'commit', '-q', '-m', rel)
  }
  blocked(
    'an ignored file with a non-ASCII name sits where the older version tracks one',
    (d) => track(d, 'café.cfg'),
    'caf',
  )
  blocked(
    'an ignored FILE sits where the older version tracks a folder of that name',
    (d) => track(d, 'data/x.json'),
    'data',
  )
  blocked(
    'an ignored dangling symlink sits at a tracked path',
    (d) => {
      symlinkSync('elsewhere', join(d, 'link2'))
      sh(d, 'add', '-f', 'link2')
      sh(d, 'commit', '-q', '-m', 'link')
    },
    'link2',
  )

  test('a file that is not ignored, only untracked, is not called ignored in the refusal', async () => {
    const w = world()
    track(w.dir, 'extra.cfg')
    const old = w.head()
    sh(w.dir, 'rm', '-q', 'extra.cfg')
    sh(w.dir, 'commit', '-q', '-m', 'drop')
    writeFileSync(join(w.dir, 'extra.cfg'), 'mine')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    const msg = h.err.join('\n')
    expect(msg).toContain('extra.cfg')
    expect(msg).not.toContain('git ignores')
    expect(msg).toContain('Nothing was changed')
    expect(readFileSync(join(w.dir, 'extra.cfg'), 'utf8')).toBe('mine')
  })

  test('a case-only rename between the two versions is not refused (APFS sees the new name as the old file)', async () => {
    const w = world()
    track(w.dir, 'Readme.md')
    const old = w.head()
    sh(w.dir, 'mv', 'Readme.md', 'README.tmp')
    sh(w.dir, 'mv', 'README.tmp', 'README.md')
    sh(w.dir, 'commit', '-q', '-m', 'rename')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(0)
    expect(w.head()).toBe(old)
  })

  describe('putting the checkout back after a refused settings check', () => {
    const refusing = () => {
      const w = world()
      const loader = (known: string[]) => {
        writeFileSync(
          join(w.dir, 'apps', 'bridge', 'src', 'config-file.ts'),
          `// ${w.head()}
export function parseConfig(v: Record<string, unknown>) {
  const config: Record<string, unknown> = {}
  for (const k of ${JSON.stringify(known)}) if (k in v) config[k] = v[k]
  return { ok: true, config }
}
`,
        )
        sh(w.dir, 'add', '.')
        sh(w.dir, 'commit', '-q', '-m', 'loader')
        return w.head()
      }
      const old = loader(['version'])
      const now = loader(['version', 'extra'])
      const home = tempHome()
      writeRecord(home, [entry(w.dir, old)])
      writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, extra: 1 }), { mode: 0o600 })
      return { w, old, now, home }
    }

    test('from a detached HEAD it returns to that commit, still detached', async () => {
      const { w, now, home } = refusing()
      sh(w.dir, 'checkout', '-q', '--detach', now)
      const h = harness(w.dir, home)
      expect(await h.run()).toBe(1)
      expect(w.head()).toBe(now)
      expect(sh(w.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('')
      expect(h.err.join('\n')).toContain('Put the checkout back')
    })

    test('a tag named like the branch does not make it detach', async () => {
      const { w, now, home } = refusing()
      sh(w.dir, 'tag', 'main', w.head()) // `main` is now both a branch and a tag
      const h = harness(w.dir, home)
      expect(await h.run()).toBe(1)
      expect(w.head()).toBe(now)
      expect(sh(w.dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    })

    test('when git cannot put it back, the message gives the command that does', async () => {
      const { w, now, home } = refusing()
      const h = harness(w.dir, home, 0, 'y', (cmd) => {
        // after the move to the older version, git is left unable to write its index
        if (cmd.includes('--detach') && !cmd.includes(now)) writeFileSync(join(w.dir, '.git', 'index.lock'), '')
      })
      expect(await h.run()).toBe(1)
      const msg = h.err.join('\n')
      expect(msg).toContain('Could not put the checkout back')
      expect(msg).toContain('git switch main')
      expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
    })
  })
})

describe('rollback walks strictly back', () => {
  test('repeated rollbacks go back one version at a time, reach the oldest, and never return to what they left', async () => {
    const w = world()
    const c = w.head()
    const b = w.commit('b')
    const a = w.commit('a') // newest, and the one that is broken
    const home = tempHome()
    writeRecord(home, [entry(w.dir, a), entry(w.dir, b), entry(w.dir, c)])
    expect(await harness(w.dir, home).run()).toBe(0)
    expect(w.head()).toBe(b)
    expect(await harness(w.dir, home).run()).toBe(0)
    expect(w.head()).toBe(c)
    const last = harness(w.dir, home)
    expect(await last.run()).toBe(1)
    expect(last.err.join('\n')).toContain('no earlier version')
    expect(w.head()).toBe(c)
  })

  test('after a failed install the next run does not land on the version that was left', async () => {
    const w = world()
    const c = w.head()
    const b = w.commit('b')
    const a = w.commit('a')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, a), entry(w.dir, b), entry(w.dir, c)])
    expect(await harness(w.dir, home, 1).run()).toBe(1)
    expect(w.head()).toBe(b)
    expect(await harness(w.dir, home).run()).toBe(0)
    expect(w.head()).toBe(c)
  })

  test('never moves forward: a record newer than the current version is not a way back', async () => {
    const w = world()
    const older = w.head()
    const newer = w.commit('newer')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, newer)])
    sh(w.dir, 'checkout', '-q', '--detach', older)
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(w.head()).toBe(older)
    expect(h.calls.some((c) => c.includes('checkout') || c[0] === 'pnpm')).toBe(false)
  })
})

describe('rollback refuses while git is in the middle of something', () => {
  const markers: Array<[string, (dir: string) => void]> = [
    ['a rebase (rebase-merge)', (d) => mkdirSync(join(d, '.git', 'rebase-merge'))],
    ['a rebase (rebase-apply)', (d) => mkdirSync(join(d, '.git', 'rebase-apply'))],
    ['a cherry-pick', (d) => writeFileSync(join(d, '.git', 'CHERRY_PICK_HEAD'), 'x')],
    ['a revert', (d) => writeFileSync(join(d, '.git', 'REVERT_HEAD'), 'x')],
    ['a cherry-pick or revert sequence', (d) => mkdirSync(join(d, '.git', 'sequencer'))],
    ['a bisect', (d) => void sh(d, 'bisect', 'start')],
    [
      'a merge',
      (d) => {
        const here = sh(d, 'rev-parse', 'HEAD')
        sh(d, 'checkout', '-q', '-b', 'side', 'HEAD~1')
        writeFileSync(join(d, 'side'), 's')
        sh(d, 'add', '.')
        sh(d, 'commit', '-q', '-m', 'side')
        sh(d, 'checkout', '-q', 'main')
        sh(d, 'merge', '-q', '-s', 'ours', '--no-commit', 'side') // a clean tree with MERGE_HEAD set
        expect(sh(d, 'rev-parse', 'HEAD')).toBe(here)
      },
    ],
  ]
  for (const [name, start] of markers) {
    test(`${name}: nothing is changed`, async () => {
      const w = world()
      const good = w.head()
      w.commit('two')
      const home = tempHome()
      writeRecord(home, [entry(w.dir, good)])
      start(w.dir)
      const before = sh(w.dir, 'status', '--porcelain=v2', '--branch')
      const h = harness(w.dir, home)
      expect(await h.run()).toBe(1)
      expect(h.err.join('\n')).toContain('in progress')
      expect(sh(w.dir, 'status', '--porcelain=v2', '--branch')).toBe(before)
      expect(h.calls.some((c) => c.includes('checkout') || c[0] === 'pnpm')).toBe(false)
    })
  }
})

describe('rollback asks first', () => {
  // Claude Code matches a rule against the command text: `*` is any run of characters (docs/CLAUDE-CODE.md C3.1).
  const asks = (cmd: string) =>
    DEFAULT_ASK_RULES.some((rule) => {
      const inner = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? ''
      return new RegExp(
        `^${inner
          .split('*')
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ).test(cmd)
    })

  test('the ask rules list it, so an agent running it reaches the owner as a card, however the command is spelled', () => {
    for (const cmd of [
      'talos-app rollback',
      'talos-app rollback --yes',
      '/home/alex/.local/bin/talos-app rollback --yes',
      'bun run /home/alex/talos/apps/bridge/src/cli.ts rollback --yes',
      'bun run apps/bridge/src/cli.ts rollback --dry-run',
      'bun /home/alex/talos/apps/bridge/src/cli.ts rollback',
      'bun run /home/alex/talos/apps/bridge/src/cli.ts  rollback --yes',
      'bun run /home/alex/talos/apps/bridge/src/cli.ts "rollback" --yes',
      "talos-app 'rollback' --yes",
      'talos-app  rollback --yes',
      '"talos-app" rollback --yes',
      "'talos-app' rollback --yes",
      'bun run "/home/alex/my repo/apps/bridge/src/cli.ts" rollback --yes',
      "bun run '/home/alex/my repo/apps/bridge/src/cli.ts' rollback --yes",
      'pnpm cli rollback --yes',
      'bun run cli -- rollback --yes',
      'pnpm cli -- rollback --yes',
      'bun apps/bridge/src/cli.ts -- rollback --yes',
      'talos-app -- rollback --yes',
      'talos-app\trollback',
      'talos-app   rollback',
      '"talos-app" "rollback"',
      'bun run --cwd /home/alex/talos/apps/bridge --silent cli rollback --yes',
      'cd /home/alex/talos && talos-app rollback --yes',
      'talos-app "rollback" --yes',
      'talos rollback --yes',
      'talos rollback',
      '/home/alex/.local/bin/talos rollback --yes',
      'bun run /home/alex/talos/apps/bridge/src/talos.ts rollback --yes',
      'bun run apps/bridge/src/talos.ts rollback --dry-run',
      'bun /home/alex/talos/apps/bridge/src/talos.ts  rollback',
      'bun run "/home/alex/my repo/apps/bridge/src/talos.ts" rollback --yes',
      "bun run '/home/alex/my repo/apps/bridge/src/talos.ts' rollback --yes",
      'bun apps/bridge/src/talos.ts -- rollback --yes',
      '"talos" rollback --yes',
      "talos 'rollback' --yes",
      'talos\trollback',
      'talos -- rollback --yes',
      'cd /home/alex/talos && talos rollback --yes',
    ])
      expect(asks(cmd), cmd).toBe(true)
    expect(asks('talos-app status')).toBe(false)
    expect(asks('git log --grep rollback')).toBe(false)
  })

  test('an install made before `talos` existed gets the missing rules from install-ask-rules, and nothing it had is dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-askrules-'))
    const file = join(dir, 'settings.json')
    const old = DEFAULT_ASK_RULES.filter((r) => !/talos(\.ts)?[ "'\t]/.test(r) || r.includes('talos-app'))
    expect(old.length).toBeLessThan(DEFAULT_ASK_RULES.length)
    writeFileSync(file, JSON.stringify({ permissions: { ask: [...old, 'Bash(my own rule)'] } }))
    const plan = planAskRules(file)
    expect(plan.added).toContain('Bash(*talos rollback*)')
    expect(plan.added).toContain('Bash(*talos.ts rollback*)')
    expect(plan.added.every((r) => !old.includes(r))).toBe(true)
    expect(JSON.stringify(plan.next)).toContain('Bash(my own rule)')
  })

  test('it does not ask on commands that only mention the program and the word somewhere', () => {
    for (const cmd of [
      'git add apps/bridge/src/cli.ts apps/bridge/src/rollback.ts',
      'git -C /home/alex/talos-app log -- apps/bridge/src/rollback.ts',
      'git commit -m "talos-app now has a rollback hint"',
      'pnpm cli status --note rollback',
      'talos-app status --after rollback',
      'git add apps/bridge/src/talos.ts apps/bridge/src/rollback.ts',
      'talos status --after rollback',
      'talos commands --json',
      'bun run apps/bridge/src/talos.ts doctor --json',
      'git add apps/bridge/src/Talos.ts apps/bridge/src/rollback.ts',
      'talos    status --after rollback',
      'talos -- status rollback',
      'echo rollback',
      'cat rollback.txt',
      'git log --grep rollback',
    ])
      expect(asks(cmd), cmd).toBe(false)
  })

  test('without --yes it asks, and anything but yes (an empty answer is what a run with no terminal gets) changes nothing', async () => {
    const w = world()
    const good = w.head()
    const bad = w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    for (const answer of ['', 'n', 'no', 'maybe']) {
      const h = harness(w.dir, home, 0, answer)
      expect(await h.runRaw()).toBe(1)
      expect(h.asked).toHaveLength(1)
      expect(h.asked[0]).toContain(`${w.short(bad)} -> ${w.short(good)}`)
      expect(h.err.join('\n')).toContain('nothing was changed')
      expect(h.calls.some((c) => c.includes('checkout') || c[0] === 'pnpm')).toBe(false)
    }
    expect(w.head()).toBe(bad)
    const yes = harness(w.dir, home, 0, 'y')
    expect(await yes.runRaw()).toBe(0)
    expect(w.head()).toBe(good)
  })

  test('--yes does not ask, and --dry-run does not ask either', async () => {
    const w = world()
    const good = w.head()
    w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    const dry = harness(w.dir, home, 0, 'n')
    expect(await dry.runRaw('--dry-run')).toBe(0)
    expect(dry.asked).toHaveLength(0)
    const yes = harness(w.dir, home, 0, 'n')
    expect(await yes.run()).toBe(0)
    expect(yes.asked).toHaveLength(0)
  })
})

describe('rollback checks that git finished', () => {
  test('a checkout that exits 0 but leaves edited files stops before the install and says so', async () => {
    const w = world()
    const good = w.head()
    w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    const h = harness(w.dir, home, 0, 'y', (cmd, cwd) => {
      if (cmd.includes('checkout')) writeFileSync(join(cwd, 'apps', 'bridge', 'package.json'), '{"half":"done"}')
    })
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('did not finish')
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
    expect(h.text()).not.toContain('rolled back')
  })

  test('a checkout that exits 0 but is not on the target stops before the install', async () => {
    const w = world()
    const good = w.head()
    w.commit('two')
    const home = tempHome()
    writeRecord(home, [entry(w.dir, good)])
    const h = harness(w.dir, home, 0, 'y', (cmd, cwd) => {
      if (cmd.includes('checkout')) sh(cwd, 'checkout', '-q', 'main')
    })
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('did not finish')
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
  })
})

describe('rollback checks that the older code can use the settings', () => {
  /** Commits a stand-in for the settings loader: it keeps only `known` top-level keys and accepts only `versions`. */
  const loader = (w: ReturnType<typeof world>, known: string[], versions: number[]) => {
    writeFileSync(
      join(w.dir, 'apps', 'bridge', 'src', 'config-file.ts'),
      `// ${w.head()}
export function parseConfig(v: Record<string, unknown>) {
  if (!${JSON.stringify(versions)}.includes(v.version as number)) return { ok: false, message: 'config.json invalid at version' }
  const config: Record<string, unknown> = {}
  for (const k of ${JSON.stringify(known)}) if (k in v) config[k] = v[k]
  return { ok: true, config }
}
`,
    )
    sh(w.dir, 'add', '.')
    sh(w.dir, 'commit', '-q', '-m', 'loader')
    return w.head()
  }
  const settings = (home: string, v: Record<string, unknown>) =>
    writeFileSync(join(home, 'config.json'), JSON.stringify(v), { mode: 0o600 })

  test('refuses a target that would erase a setting on its first write, puts the checkout back, and installs nothing', async () => {
    const w = world()
    const old = loader(w, ['version', 'rev'], [1])
    const now = loader(w, ['version', 'rev', 'extra'], [1])
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    settings(home, { version: 1, rev: 1, extra: { keep: true } })
    const before = readFileSync(join(home, 'config.json'), 'utf8')
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('extra')
    expect(h.err.join('\n')).toContain('erase')
    expect(w.head()).toBe(now)
    expect(sh(w.dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main') // back on the branch it started on
    expect(sh(w.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(before)
  })

  test('refuses a target that cannot read the settings at all (a newer settings version)', async () => {
    const w = world()
    const old = loader(w, ['version', 'rev'], [1])
    const now = loader(w, ['version', 'rev'], [1, 2])
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    settings(home, { version: 2, rev: 1 })
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('config.json invalid at version')
    expect(w.head()).toBe(now)
  })

  test('a setting the current code already drops is not the rollback’s fault', async () => {
    const w = world()
    const old = loader(w, ['version', 'rev'], [1])
    loader(w, ['version', 'rev'], [1])
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    settings(home, { version: 1, rev: 1, stale: true })
    expect(await harness(w.dir, home).run()).toBe(0)
    expect(w.head()).toBe(old)
  })

  test('--skip-data-check goes anyway, and says what was skipped', async () => {
    const w = world()
    const old = loader(w, ['version', 'rev'], [1])
    loader(w, ['version', 'rev', 'extra'], [1])
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    settings(home, { version: 1, rev: 1, extra: 1 })
    const h = harness(w.dir, home)
    expect(await h.run('--skip-data-check')).toBe(0)
    expect(w.head()).toBe(old)
  })

  test('a settings file that is not valid JSON is refused with that cause, not the runtime banner', async () => {
    const w = world()
    const old = loader(w, ['version', 'rev'], [1])
    loader(w, ['version', 'rev'], [1])
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    writeFileSync(join(home, 'config.json'), '{not json')
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('JSON')
    expect(h.err.join('\n')).not.toContain('Bun v')
    expect(sh(w.dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  test('refuses when the check itself cannot run, rather than guessing', async () => {
    const w = world()
    const old = w.head() // this version has no loader file to ask
    loader(w, ['version', 'rev'], [1])
    const home = tempHome()
    writeRecord(home, [entry(w.dir, old)])
    settings(home, { version: 1, rev: 1 })
    const h = harness(w.dir, home)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('could not check')
    expect(sh(w.dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
  })

  test('with the real settings loader: a field it does not know is reported, and a version it refuses is too', async () => {
    const home = tempHome()
    const file = join(home, 'config.json')
    const good = loadExampleConfig('default')
    writeFileSync(file, JSON.stringify(good))
    const run = (cmd: string[], cwd: string) => {
      const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
      return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}`.trim() }
    }
    const base = lostFields(REPO_DIR, file, run) // the example file carries a couple of fields today's loader already drops
    expect(base.ok).toBe(true)
    writeFileSync(file, JSON.stringify({ ...good, zz_from_a_newer_version: { a: [1] } }))
    const more = lostFields(REPO_DIR, file, run)
    if (!base.ok || !more.ok) throw new Error('the loader did not run')
    expect(more.lost.filter((p) => !base.lost.includes(p))).toEqual(['zz_from_a_newer_version'])
    writeFileSync(file, JSON.stringify({ ...good, version: 99 }))
    expect(lostFields(REPO_DIR, file, run).ok).toBe(false) // a version it refuses is reported, not guessed
  })
})

describe('rollback loads when the rest of the CLI cannot', () => {
  test('a checkout whose packages are missing: rollback itself loads; the settings check names its real cause, and --skip-data-check is the way through', () => {
    const fx = realpathSync(mkdtempSync(join(tmpdir(), 'talos-rb-cli-')))
    const bridge = join(fx, 'apps', 'bridge')
    mkdirSync(bridge, { recursive: true })
    cpSync(join(import.meta.dir, '..', 'src'), join(bridge, 'src'), { recursive: true })
    cpSync(join(import.meta.dir, '..', 'package.json'), join(bridge, 'package.json'))
    sh(fx, 'init', '-q', '-b', 'main')
    sh(fx, 'add', '.')
    sh(fx, 'commit', '-q', '-m', 'good')
    const good = sh(fx, 'rev-parse', 'HEAD')
    // the new version needs a package that was never installed
    writeFileSync(join(bridge, 'src', 'cli-main.ts'), "import 'a-package-that-is-not-installed-xyz'\n")
    sh(fx, 'add', '.')
    sh(fx, 'commit', '-q', '-m', 'needs a new package')
    const bad = sh(fx, 'rev-parse', 'HEAD')
    const home = tempHome()
    writeRecord(home, [entry(fx, good)])
    const cli = (...a: string[]) =>
      Bun.spawnSync([process.execPath, '--no-env-file', 'run', join(bridge, 'src', 'cli.ts'), ...a], {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? '', HOME: home, TALOS_APP_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const other = cli('status') // control: the rest of the CLI really is broken here
    expect(other.exitCode).not.toBe(0)
    expect(other.stderr.toString()).toContain('a-package-that-is-not-installed-xyz')
    const r = cli('rollback', '--dry-run')
    expect(r.stderr.toString()).toBe('')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString()).toContain(`${bad.slice(0, 7)} -> ${good.slice(0, 7)}`)

    // A real run with settings present: the check needs the packages, so it cannot run and the default refuses. It says why
    // (the missing package, not the runtime's banner) and puts the checkout back.
    writeFileSync(join(home, 'config.json'), '{}')
    const stubs = join(fx, '..', `${fx.split('/').pop()}-bin`)
    mkdirSync(stubs, { recursive: true })
    writeFileSync(join(stubs, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const withStub = (...a: string[]) =>
      Bun.spawnSync([process.execPath, '--no-env-file', 'run', join(bridge, 'src', 'cli.ts'), ...a], {
        cwd: tmpdir(),
        env: { PATH: `${stubs}:${process.env.PATH ?? ''}`, HOME: home, TALOS_APP_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const refused = withStub('rollback', '--yes')
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.toString()).toContain('@talos-app/protocol')
    expect(refused.stderr.toString()).not.toContain('Bun v')
    expect(refused.stderr.toString()).toContain('--skip-data-check')
    expect(sh(fx, 'rev-parse', 'HEAD')).toBe(bad)
    const through = withStub('rollback', '--yes', '--skip-data-check')
    expect(through.stderr.toString()).toBe('')
    expect(through.exitCode).toBe(0)
    expect(sh(fx, 'rev-parse', 'HEAD')).toBe(good)
  })
})

describe('the bridge notes a healthy start', () => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.stop()
    h = undefined
  })

  test('once, when the relay says ready, and not again on a reconnect', async () => {
    let calls = 0
    h = await startHarness({ startBridge: false, bridge: { random: () => 0, onHealthyStart: () => void calls++ } })
    h.bridge.start()
    expect(calls).toBe(0) // started, but the relay has not answered
    await waitFor(() => calls === 1, 3000, 'the healthy start')
    h.relay.dropBridge()
    await waitFor(() => h?.bridge.client?.connected === false, 3000, 'disconnected')
    await waitFor(() => h?.bridge.client?.connected === true, 8000, 'connected again')
    expect(calls).toBe(1)
  })

  test('a relay that takes the connection but never says ready records nothing', async () => {
    const held: Duplex[] = []
    const server = createServer()
    const upgraded = new Promise<void>((resolve) => {
      server.on('upgrade', (_req, socket) => {
        held.push(socket)
        resolve()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      let calls = 0
      h = await startHarness({
        startBridge: false,
        env: { TALOS_APP_RELAY_URL: `http://127.0.0.1:${port}` },
        bridge: { onHealthyStart: () => void calls++ },
      })
      h.bridge.start()
      await upgraded // the bridge is connected and waiting for ready
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) // let anything scheduled at start run
      expect(calls).toBe(0)
    } finally {
      for (const s of held) s.destroy()
      server.close()
    }
  })

  test('a start whose ready work throws is not recorded', async () => {
    let calls = 0
    h = await startHarness({ startBridge: false, bridge: { random: () => 0, onHealthyStart: () => void calls++ } })
    const bridge = h.bridge
    bridge.ctx.schedules = {
      onReady() {
        throw new Error('this version breaks right after ready')
      },
      stop() {},
      idle: async () => {},
    } as never
    bridge.start()
    // onReady stamps last_connect_at before it reaches the schedules; it is synchronous, so once the stamp is there it has run or thrown
    await waitFor(() => bridge.ctx.store.kvGet('last_connect_at') !== undefined, 3000, 'ready handled')
    expect(calls).toBe(0)
  })

  test('a recorder that throws is logged and does not stop the bridge from connecting', async () => {
    const lines: string[] = []
    h = await startHarness({
      bridge: {
        random: () => 0,
        logger: createLogger(null, 'info', (l) => lines.push(l)),
        onHealthyStart: () => {
          throw new Error('disk full')
        },
      },
    })
    await waitFor(() => h?.bridge.client?.connected === true, 3000, 'connected')
    await waitFor(() => lines.some((l) => l.includes('healthy start not recorded')), 3000, 'the warning')
    expect(lines.join('')).toContain('disk full')
  })
})

describe('rollback never starts by itself', () => {
  // The owner asks by typing the command. If the bridge, the supervisor hook or any other module imported the command,
  // it could be called with nobody asking. The places allowed to load it are the CLI's command switch and the two program entries.
  test('only the CLI dispatchers (talos-app and talos) load the rollback command', () => {
    const src = join(import.meta.dir, '..', 'src')
    const importers: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (name.endsWith('.ts') && /['"]\.{1,2}\/(.*\/)?rollback\.ts['"]/.test(readFileSync(p, 'utf8')))
          importers.push(relative(src, p))
      }
    }
    walk(src)
    expect(importers.sort()).toEqual(['cli-main.ts', 'cli.ts', 'talos.ts'])
  })
})
