// The second count: the suites this change needs, from git and the files, by plan_suites' rules written again here (no shared
// code, no bash). stdin: the plan the gate made, NUL-separated NAME<US>value records. Prints "plan-check: ok" when they agree;
// otherwise each difference on stderr, and exit 1. Names are handled as bytes (latin1), as bash does.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const base = process.argv[1]
const B = (s) => Buffer.from(s, 'latin1')
const die = (m) => {
  process.stderr.write(`plan-check: ${m}\n`)
  process.exit(1)
}
const git = (...a) => {
  const r = spawnSync('git', a, { maxBuffer: 1 << 30 })
  if (r.status !== 0) die(`git ${a[0]} ${a[1] || ''} failed, so the change cannot be counted`)
  return r.stdout.toString('latin1')
}
const exists = (p) => fs.existsSync(B(p))
const isDir = (p) => {
  try {
    return fs.statSync(B(p)).isDirectory()
  } catch {
    return false
  }
}
const read = (p) => {
  try {
    return fs.readFileSync(B(p)).toString('latin1')
  } catch {
    return null
  }
}
// a bash case pattern: * and ? match anything, / included
const glob = (...ps) => {
  const re = new RegExp(
    `^(${ps
      .map((p) =>
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.'),
      )
      .join('|')})$`,
    's',
  )
  return (s) => re.test(s)
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const sorted = (a) => [...new Set(a)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))

const ROOTS = [
  'packages/protocol',
  'packages/testkit',
  'packages/integrations',
  'apps/relay',
  'apps/web',
  'apps/mobile',
  'scripts',
]
// grep -r: recursion that follows no link, files named *.test.ts
const grepTree = (roots) => {
  const out = []
  const walk = (d) => {
    let es
    try {
      es = fs.readdirSync(B(d), { withFileTypes: true, encoding: 'buffer' })
    } catch {
      return
    }
    for (const e of es) {
      const name = e.name.toString('latin1')
      const p = `${d}/${name}`
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && name.endsWith('.test.ts')) out.push(p)
    }
  }
  for (const r of roots) if (isDir(r)) walk(r)
  return out
}
// find, pruning node_modules, regular files named *.test.ts or *.test.tsx
const findPool = (roots) => {
  const out = []
  const walk = (d) => {
    let es
    try {
      es = fs.readdirSync(B(d), { withFileTypes: true, encoding: 'buffer' })
    } catch {
      return
    }
    for (const e of es) {
      const name = e.name.toString('latin1')
      if (name === 'node_modules') continue
      const p = `${d}/${name}`
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && (name.endsWith('.test.ts') || name.endsWith('.test.tsx'))) out.push(p)
    }
  }
  for (const r of roots) if (isDir(r)) walk(r)
  return out
}
const cache = new Map()
const text = (p) => {
  if (!cache.has(p)) cache.set(p, read(p) ?? '')
  return cache.get(p)
}

// -z: a name exactly as it is, never git's quoted C string (whatever core.quotePath says)
const changed = sorted(
  [
    ...git('diff', '-z', '--name-only', '--no-renames', base, 'HEAD').split('\0'),
    ...git('diff', '-z', '--name-only', '--no-renames', 'HEAD').split('\0'),
    ...git('ls-files', '-z', '--others', '--exclude-standard').split('\0'),
  ].filter((f) => f !== ''),
)
const listers = grepTree([...ROOTS, 'apps/bridge/test']).filter((t) =>
  /readdirSync|globSync|readdir\(|ls-files|ls-tree|write-tree/.test(text(t)),
)
const pool = findPool([...ROOTS, 'apps/bridge/test'])
// the guards over test files: each line of exactly "// gate-reads: <pattern>..." (lines split at \n alone, as grep and sed do)
const guards = grepTree([...ROOTS, 'apps/bridge/test'])
  .map((t) => [
    t,
    text(t)
      .split('\n')
      .filter((l) => l.startsWith('// gate-reads:'))
      .flatMap((l) => l.slice('// gate-reads:'.length).split(/[ \t]+/))
      .filter((p) => p !== ''),
  ])
  .filter(([, ps]) => ps.length)
const guardsReading = (f) => guards.filter(([, ps]) => glob(...ps)(f)).map(([t]) => t)
const scriptTests = grepTree(ROOTS)
const bridgeTests = grepTree(['apps/bridge/test'])

const SMOKE =
  'threads/threads.spec.ts threads/message-row.spec.ts composer/send-leaves-no-text.spec.ts home/home.spec.ts settings/settings-home.spec.ts session/session.spec.ts fake-mode.spec.ts'.split(
    ' ',
  )
const smoke = () => SMOKE.filter((t) => exists(`apps/web/test/${t}`)).map((t) => `test/${t}`)
const specsIn = (...ds) => {
  const out = []
  for (const d of ds) {
    let names = []
    try {
      names = fs.readdirSync(B(`apps/web/test/${d}`), { encoding: 'buffer' }).map((n) => n.toString('latin1'))
    } catch {}
    for (const n of names)
      if (!n.startsWith('.') && n.endsWith('.spec.ts') && exists(`apps/web/test/${d}/${n}`)) out.push(`test/${d}/${n}`)
  }
  return out
}
const first = (s) => s.split('/')[0]
// webOwn is web_own_specs_for's twin
const webOwn = (f) => {
  if (glob('apps/web/test/*.spec.ts')(f)) return exists(f) ? [f.slice('apps/web/'.length)] : []
  if (glob('apps/web/test/helpers/*', 'apps/web/test/*.test.ts', 'apps/web/test/*.test.tsx')(f)) return []
  if (glob('apps/web/test/*/*')(f)) return specsIn(first(f.slice('apps/web/test/'.length)))
  if (glob('apps/web/src/*.test.ts', 'apps/web/src/*.test.tsx')(f)) return []
  if (glob('apps/web/src/features/*/*')(f)) return specsIn(first(f.slice('apps/web/src/features/'.length)))
  return []
}
const webFor = (f) => {
  if (glob('apps/web/src/*.test.ts', 'apps/web/src/*.test.tsx')(f)) return []
  if (glob('apps/web/test/helpers/*')(f)) return smoke()
  if (glob('apps/web/test/*.spec.ts')(f)) return exists(f) ? [f.slice('apps/web/'.length)] : []
  if (glob('apps/web/test/*.test.ts', 'apps/web/test/*.test.tsx')(f)) return []
  if (glob('apps/web/test/*/*')(f)) return [...specsIn(first(f.slice('apps/web/test/'.length))), ...smoke()]
  if (glob('apps/web/src/features/*/*')(f)) {
    const x = first(f.slice('apps/web/src/features/'.length))
    const out = specsIn(x)
    return out.length ? out : smoke()
  }
  if (f === 'apps/web/src/Shell.tsx') return [...specsIn('shell'), ...smoke()]
  if (glob('apps/web/src/theme/*')(f)) return [...specsIn('themes'), ...smoke()]
  if (
    glob(
      'apps/web/src/features/*',
      'apps/web/src/ui/*',
      'apps/web/src/lib/*',
      'apps/web/src/App.tsx',
      'apps/web/src/main.tsx',
      'apps/web/src/sw.ts',
      'apps/web/public/*',
      'apps/web/index.html',
      'apps/web/vite.config.ts',
      'apps/web/vite.brand.ts',
      'apps/web/playwright.config.ts',
      'apps/web/package.json',
      'apps/web/tsconfig.json',
      'apps/web/src/*',
    )(f)
  )
    return smoke()
  return []
}
const namers = (f) => {
  if (!pool.length) return []
  const name = f.slice(f.lastIndexOf('/') + 1)
  const a = new RegExp(`(^|[^A-Za-z0-9_.-])${esc(f)}($|[^A-Za-z0-9_-])`, 'm')
  const b = new RegExp(`['"\`/]${esc(name)}['"\`]`)
  return pool.filter((t) => a.test(text(t)) || b.test(text(t)))
}
const folderListers = (f) => {
  const out = []
  if (!listers.length) return out
  for (let d = f; ; ) {
    const i = d.lastIndexOf('/')
    if (i <= 0) break
    d = d.slice(0, i)
    if (!d.includes('/') && d !== 'kit') continue
    const re = new RegExp(`['"]${esc(d)}/?['"]`) // the folder as literal text
    for (const t of listers) if (re.test(text(t))) out.push(t)
  }
  return out
}

const BRIDGE_TEST = glob('apps/bridge/test/*.test.ts')
const BRIDGE_ALL = glob(
  'apps/bridge/*',
  'packages/protocol/src/*',
  'packages/testkit/src/*',
  'packages/protocol/fixtures/*',
  'packages/protocol/test/support/*',
  'packages/testkit/fixtures/*',
  'apps/desktop/Tests/*',
  'apps/desktop/Resources/*',
  'apps/desktop/Sources/*',
  'plugins/talos-app-mod/*',
  'third_party/chronos/*',
  'kit/*',
  'examples/*',
  'docs/SETUP.md',
)
const PAIRING = glob(
  'apps/bridge/src/enroll*.ts',
  'apps/bridge/src/enrollment.ts',
  'apps/bridge/src/devices.ts',
  'apps/bridge/src/cli-main.ts',
  'apps/bridge/src/cli.ts',
  'apps/bridge/src/relay-http.ts',
  'apps/web/src/features/auth/*',
  'apps/web/src/lib/deviceKey.ts',
  'apps/relay/src/auth/*',
  'packages/protocol/src/enroll.ts',
  'packages/protocol/src/device-proof.ts',
)
const CODE = glob('*.ts', '*.tsx', '*.mts', '*.js', '*.mjs', '*.json', '*.sh', '*.py')
const OLD_PATHS = glob(
  'packages/protocol/src/*',
  'apps/relay/src/*',
  'apps/relay/migrations/*',
  'apps/relay/package.json',
  'apps/bridge/src/handshake.ts',
  'apps/bridge/src/relay-client.ts',
  'apps/bridge/src/bridge.ts',
  'apps/bridge/src/frames-out.ts',
  'e2e/tests/old-client/*',
  'e2e/harness/*',
  'scripts/old-client.sh',
  'scripts/web-bundle-manifest.mjs',
)
const want = { VIT: [], BUN: [], E2E: [], VPROJ: [], WEB: [], WEBKIT: [], BUN_ALL: ['0'], E2E_ALL: ['0'], OLD: ['0'] }
const folder = []
for (const f of changed) {
  if (BRIDGE_TEST(f)) {
    if (!exists(f)) want.BUN_ALL = ['1']
  } else if (BRIDGE_ALL(f)) want.BUN_ALL = ['1']
  if (PAIRING(f) && isDir('e2e'))
    want.E2E.push('tests/01-enroll.spec.ts', 'tests/08-devices.spec.ts', 'tests/12-device-proof.spec.ts')
  if (!exists(f)) {
    if (f.startsWith('apps/web/')) want.VPROJ.push('web')
    else if (f.startsWith('apps/relay/')) want.VPROJ.push('relay')
    else if (f.startsWith('apps/mobile/')) want.VPROJ.push('mobile')
  }
  if (!CODE(f) && !f.startsWith('e2e/')) folder.push(...namers(f))
  else if (glob('*.test.ts', '*.test.tsx', '*.spec.ts', 'install.sh')(f)) folder.push(...namers(f)) // a test file, and install.sh, are read by name too
  folder.push(...guardsReading(f))
  want.WEB.push(...webFor(f))
  want.WEBKIT.push(...webOwn(f))
  if (!exists(f)) continue
  if (f.startsWith('kit/') || glob('*.sh', '*.py')(f)) folder.push(...folderListers(f))
  if (OLD_PATHS(f)) want.OLD = ['1']
  if (glob('e2e/tests/*.spec.ts', 'e2e/tests/*/*.spec.ts')(f)) {
    want.E2E.push(f.slice('e2e/'.length))
    continue
  }
  if (f.startsWith('e2e/')) {
    if (glob('*.ts', '*.json', '*.mjs', '*.js')(f)) want.E2E_ALL = ['1']
    continue
  }
  if (!CODE(f)) continue
  if (BRIDGE_TEST(f)) want.BUN.push(f)
  if (glob('*.sh', '*.py')(f)) {
    const name = f.slice(f.lastIndexOf('/') + 1)
    want.VIT.push(...scriptTests.filter((t) => text(t).includes(name)))
    want.BUN.push(...bridgeTests.filter((t) => text(t).includes(name)))
  } else if (f.startsWith('apps/bridge/')) {
  } else if (f.endsWith('.json')) {
    if (!glob('*/package.json', '*/tsconfig*.json')(f) && first(f) === 'scripts') want.VIT.push(f)
  } else if (ROOTS.some((r) => f.startsWith(`${r}/`))) want.VIT.push(f)
}
for (const t of folder) (t.startsWith('apps/bridge/') ? want.BUN : want.VIT).push(t)
for (const k of ['VIT', 'BUN', 'E2E', 'VPROJ', 'WEB', 'WEBKIT']) want[k] = sorted(want[k])
const max = /^[0-9]+$/.test(process.env.WEB_SPECS_MAX || '') ? Number(process.env.WEB_SPECS_MAX) : 40
if (want.WEB.length > max) {
  want.WEB = sorted(smoke())
  want.WEBKIT = []
}

// the installer's core tests again with a corepack pnpm first on PATH: whenever the plan runs the root installer's test
want.COREPACK = [want.VIT.includes('scripts/root-install.test.ts') ? '1' : '0']

// --fast: fastPlan (scripts/gate-fast.sh, FAST_CHECK_JS, run ahead of this script) gives the bridge tests and the change's own browser specs, or
// null for the full gate. Without that file both counts say full.
want.FAST = ['0']
if (process.argv[2] === '1' && typeof fastPlan === 'function') {
  const fast = fastPlan({
    base,
    changed,
    want,
    text,
    exists,
    glob,
    sorted,
    B,
    fs,
    spawnSync,
    bridgeTests,
    BRIDGE_TEST,
    BRIDGE_ALL,
  })
  if (fast)
    Object.assign(want, {
      FAST: ['1'],
      BUN: fast.bun,
      BUN_ALL: ['0'],
      E2E: [],
      E2E_ALL: ['0'],
      OLD: ['0'],
      WEB: fast.web,
      WEBKIT: fast.webkit,
    })
}

const got = {
  VIT: [],
  BUN: [],
  E2E: [],
  VPROJ: [],
  WEB: [],
  WEBKIT: [],
  BUN_ALL: [],
  E2E_ALL: [],
  OLD: [],
  FAST: [],
  COREPACK: [],
}
for (const rec of fs.readFileSync(0).toString('latin1').split('\0')) {
  if (rec === '') continue
  const i = rec.indexOf('\x1f')
  const k = rec.slice(0, i)
  if (!(k in got)) die(`the gate sent an unknown list (${k})`)
  got[k].push(rec.slice(i + 1))
}
let bad = 0
for (const k of Object.keys(want)) {
  const g = new Set(got[k])
  const w = new Set(want[k])
  const say = (m) => {
    process.stderr.write(`plan-check: ${k} ${m}\n`)
    bad++
  }
  for (const x of want[k]) if (!g.has(x)) say(`is missing ${x}`)
  for (const x of got[k]) if (!w.has(x)) say(`has ${x}, which the second count does not`)
  if (got[k].length !== g.size) say('lists a path twice')
}
if (bad) process.exit(1)
process.stdout.write('plan-check: ok\n')
