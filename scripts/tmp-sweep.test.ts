// scripts/tmp-sweep.sh: the gate removes test folders that killed runs left directly in its $TMPDIR, once they are a day old.
// That $TMPDIR may be the machine's shared one, also the live Talos app's, so only names on the allowlist
// (scripts/tmp-sweep-prefixes.txt) go: never a fresh one, never another name, never what a link points at, never anything below
// the top level. And the list cannot fall behind the tests: a test that makes a folder in the temp folder under a new prefix
// fails here until the prefix is listed, swept or not.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const SWEEP = join(here, 'tmp-sweep.sh')
const LIST = readFileSync(join(here, 'tmp-sweep-prefixes.txt'), 'utf8')
  .split('\n')
  .filter((l) => l !== '' && !l.startsWith('#'))
const SWEPT = LIST.filter((l) => !l.startsWith('!'))
const NOT_SWEPT = LIST.filter((l) => l.startsWith('!')).map((l) => l.slice(1))
/** The live app's and other tools' own folders in the temp folder: never test leftovers, never swept. */
const LIVE = [
  'talos-codex-',
  'talos-explain-',
  'talos-restore-',
  'talos-undo-',
  'talos-sandbox-',
  'talos-ci-',
  'talos-render',
  'talos-fake-tools-',
  'talos-chronos-pycache-',
  // the repo's own tools' scratch (the pre-push hook, release and TestFlight scripts, the personal check, capture scripts)
  'talos-pre-push.',
  'talos-testflight.',
  'talos-release.',
  'talos-ref-personal.',
  'talos-kc-probe.',
  'talos-capture-',
  'talos-rev-xss-',
]
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', d]) // a folder the sweep left at mode 000
    rmSync(d, { recursive: true, force: true })
  }
})

const HOUR = 60 * 60 * 1000
const twoDaysAgo = new Date(Date.now() - 48 * HOUR)
const old = (p: string) => utimesSync(p, twoDaysAgo, twoDaysAgo)

function sweep(tmp: string) {
  return spawnSync(BASH, [SWEEP], { env: { PATH: process.env.PATH ?? '', TMPDIR: tmp }, encoding: 'utf8' })
}
/** A fake $TMPDIR, and `dir(name, age)` to put a folder with something inside in it, `age` 'old' (two days), 'new' or hours. */
function fakeTmp() {
  const T = mkdtempSync(join(tmpdir(), 'sweep-'))
  dirs.push(T)
  const tmp = join(T, 'tmp')
  mkdirSync(tmp)
  const dir = (n: string, age: 'old' | 'new' | number) => {
    mkdirSync(join(tmp, n, 'sub'), { recursive: true })
    writeFileSync(join(tmp, n, 'sub', 'f'), 'x')
    if (age === 'old') old(join(tmp, n))
    else if (typeof age === 'number') {
      const at = new Date(Date.now() - age * HOUR)
      utimesSync(join(tmp, n), at, at)
    }
  }
  return { T, tmp, dir }
}

describe('tmp-sweep.sh', () => {
  it('removes only old entries whose name starts with a listed prefix, directly in $TMPDIR, and never follows a link', () => {
    const { T, tmp, dir } = fakeTmp()
    const outside = join(T, 'outside')
    mkdirSync(join(outside, 'keep'), { recursive: true })
    writeFileSync(join(outside, 'keep', 'data'), 'x')
    // old and listed, every prefix on the list: these go
    for (const p of SWEPT) dir(`${p}aaaaaa`, 'old')
    dir('talos-apps-30h', 30) // a day and a quarter: past the day
    writeFileSync(join(tmp, 'talos-crash-file'), 'x') // a file goes as well as a folder
    old(join(tmp, 'talos-crash-file'))
    // a locked-down test left a folder at mode 000 inside: it still goes
    dir('talos-hook-LOCKED', 'old')
    chmodSync(join(tmp, 'talos-hook-LOCKED', 'sub'), 0o000)
    old(join(tmp, 'talos-hook-LOCKED'))
    const removed = SWEPT.length + 3
    // fresh and listed: stay
    dir('talos-e2e-apps-bbbbbb', 'new')
    dir('tbrun-bbbbbb', 'new')
    dir('talos-apps-bbbbbb', 12) // half a day: not yet
    // old, a name not on the list: stay. A talos- name that is not a listed test prefix is no exception.
    const kept = ['other-cccccc', 'hb-cccccc', 'xtalos-bridge-test-c', 'Talos-bridge-test-c', 'talos-new-tool-cccccc']
    kept.push(`${NOT_SWEPT[0]}cccccc`) // made by a test, but listed as not swept
    for (const n of kept) dir(n, 'old')
    // a listed name one level down, in an old folder that is not listed: stays
    dir('other-eeeeee/talos-bridge-test-inner', 'old')
    old(join(tmp, 'other-eeeeee'))
    // an old link with a listed name, pointing outside: neither the link nor what it points at is touched
    symlinkSync(outside, join(tmp, 'talos-bridge-test-link'))
    lutimesSync(join(tmp, 'talos-bridge-test-link'), twoDaysAgo, twoDaysAgo)

    const r = sweep(tmp)
    expect(r.status, r.stderr).toBe(0)
    expect(readdirSync(tmp).sort()).toEqual(
      [
        'talos-e2e-apps-bbbbbb',
        'tbrun-bbbbbb',
        'talos-apps-bbbbbb',
        ...kept,
        'other-eeeeee',
        'talos-bridge-test-link',
      ].sort(),
    )
    expect(existsSync(join(tmp, 'other-eeeeee', 'talos-bridge-test-inner', 'sub', 'f'))).toBe(true)
    expect(existsSync(join(outside, 'keep', 'data'))).toBe(true)
    expect(r.stderr.trim().split('\n')).toEqual([
      `gate: removed ${removed} test folders older than a day from ${realpathSync(tmp)}`,
    ])
  })

  it("never removes the live app's or other tools' own folders, however old", () => {
    const { tmp, dir } = fakeTmp()
    const live = LIVE.map((p) => (/[-.]$/.test(p) ? `${p}AbC123` : p))
    for (const n of live) dir(n, 'old')
    expect(sweep(tmp).stderr).toContain('removed 0 test folders')
    expect(readdirSync(tmp).sort()).toEqual([...live].sort())
    // and no listed prefix could ever match one of their names
    for (const p of SWEPT) for (const l of LIVE) expect(l.startsWith(p) || p.startsWith(l), `${p} and ${l}`).toBe(false)
  })

  it('an empty or missing $TMPDIR is no error, and says 0', () => {
    const { tmp } = fakeTmp()
    const r = sweep(tmp)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('removed 0 test folders')
    expect(sweep(join(tmp, 'missing')).status).toBe(0)
  })
})

describe('tmp-sweep-prefixes.txt', () => {
  it('holds only plain prefixes ending in "-", each once', () => {
    // a swept one is at least four characters (the sweep skips shorter ones) and ends in "-"
    for (const p of SWEPT) expect(p, p).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{2,}-$/)
    for (const p of NOT_SWEPT) expect(p, p).toMatch(/^[A-Za-z0-9][A-Za-z0-9._ -]+$/)
    expect(new Set(LIST).size).toBe(LIST.length)
    expect(SWEPT.filter((p) => NOT_SWEPT.includes(p))).toEqual([])
  })

  // The tests whose runner puts their folders straight in $TMPDIR, with no run folder around them: e2e (Playwright), the bridge
  // contract tests (Vitest, own config), the Mac app's Swift tests (TestTemp.base) and the test shell scripts. The bridge's bun
  // tests and the root Vitest projects make theirs inside the run folder (tbrun-, talos-vitest-run-), which is listed.
  const SCOPE =
    /^(e2e\/.*\.ts|apps\/bridge\/test-contract\/.*\.ts|apps\/desktop\/Tests\/.*\.swift|(apps\/desktop\/scripts|kit\/scripts|scripts)\/([^/]*-test|test-[^/]*)\.sh)$/
  const MADE = [
    // join(tmpdir(), 'prefix-…'), join(process.env.X ?? tmpdir(), `prefix-${…}`)
    /join\(\s*(?:process\.env\.\w+\s*\?\?\s*)?(?:os\.)?tmpdir\(\)\s*,\s*['"`]([A-Za-z0-9._ -]+?)(?=\$\{|['"`])/g,
    // Swift: TestTemp.base + "prefix-\(…)", (TestTemp.base as NSString).appendingPathComponent("prefix-…"), TestTemp.url…
    /(?:TestTemp\.base\)?\s*\+\s*|TestTemp\.base as NSString\)\.appendingPathComponent\(|(?:TestTemp\.url|temporaryDirectory)\.(?:appendingPathComponent\(|appending\(path:\s*)|NSTemporaryDirectory\(\)\s*\+\s*)"\/?([A-Za-z0-9._ -]+?)(?=\\\(|")/g,
    // shell: mktemp -d "${TMPDIR:-/tmp}/prefix.XXXXXX"
    /\$\{TMPDIR:-\/tmp\}\/([A-Za-z0-9._ -]+?)(?=X{3,}|\$|")/g,
  ]

  // A name built from a variable right on the temp folder, which the patterns above cannot read: each such place is listed here
  // with the prefixes its callers pass, and those must be on the list too. A new one fails until it is added.
  const BUILT = [
    /join\(\s*(?:process\.env\.\w+\s*\?\?\s*)?(?:os\.)?tmpdir\(\)\s*,\s*[^'"`\s)]/,
    /`\$\{(?:os\.)?tmpdir\(\)\}\//,
    /(?:TestTemp\.base\)?\s*\+\s*|TestTemp\.base as NSString\)\.appendingPathComponent\(|(?:TestTemp\.url|temporaryDirectory)\.(?:appendingPathComponent\(|appending\(path:\s*)|NSTemporaryDirectory\(\)\s*\+\s*)"\/?\\\(/,
    /\$\{TMPDIR:-\/tmp\}\/\$/,
  ]
  const BUILT_KNOWN: Record<string, string[]> = {
    // scratchBun("old-bun") and scratchBun("new-bun")
    'apps/desktop/Tests/TalosDesktopIntegrationTests/WorkerUpdateRestartTests.swift': ['old-bun-', 'new-bun-'],
  }

  it('knows every place a test builds a temp folder name from a variable', () => {
    const found: string[] = []
    for (const f of execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')) {
      if (!SCOPE.test(f)) continue
      if (BUILT.some((rx) => rx.test(readFileSync(join(ROOT, f), 'utf8')))) found.push(f)
    }
    expect(found.sort()).toEqual(Object.keys(BUILT_KNOWN).sort())
    for (const ps of Object.values(BUILT_KNOWN))
      for (const p of ps) expect(SWEPT.includes(p) || NOT_SWEPT.includes(p), p).toBe(true)
  })

  it('names every prefix a test makes directly in the temp folder, as swept or as "!" not swept', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => SCOPE.test(f))
    expect(files.length).toBeGreaterThan(100) // the scope still finds the Swift tests
    const missing = new Set<string>()
    let seen = 0
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      for (const rx of MADE)
        for (const m of text.matchAll(rx)) {
          seen++
          if (!SWEPT.includes(m[1]) && !NOT_SWEPT.includes(m[1])) missing.add(`${m[1]} (${f})`)
        }
    }
    expect(seen).toBeGreaterThan(50) // the patterns still match how the tests make their folders
    expect([...missing], 'add each to scripts/tmp-sweep-prefixes.txt (or give the test a listed talos- name)').toEqual(
      [],
    )
  })
})
