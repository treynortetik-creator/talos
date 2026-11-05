// The size rules, run inside `pnpm test`: AGENTS.md past its limit fails. A new production file past 1,000 lines, a new function
// past 300, or an addition to the closed list of those already over (scripts/size-budget.json) prints a warning and never fails.
// scripts/size-report.ts is the one definition of a line and of which files count.
// Nothing here reads a clock or compares against a time: sizes are counted, never timed.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type Budget,
  buildReport,
  checkBudget,
  compareToList,
  countChars,
  countLines,
  formatListStatus,
  groupOf,
  loadBudget,
  measureFunctions,
  ROOT,
  refreshBudget,
} from './size-report.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A scratch repo layout: { 'apps/web/src/a.ts': 'text' | { lines: n } }. Not a git checkout unless `git` is true. */
function scratch(files: Record<string, string | { lines: number }>, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'talos-size-'))
  made.push(dir)
  for (const [p, v] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), typeof v === 'string' ? v : 'x\n'.repeat(v.lines))
  }
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
/** A budget whose recorded count and totals match its lists, unless the test overrides them. */
const budget = (over: Partial<Budget> = {}): Budget => {
  const filesOverLimit = over.filesOverLimit ?? {}
  const functionsOverLimit = over.functionsOverLimit ?? {}
  return {
    fileLines: 1000,
    functionLines: 300,
    agentsChars: 12000,
    filesListedCount: Object.keys(filesOverLimit).length,
    filesListedLines: total(filesOverLimit),
    functionsListedCount: Object.keys(functionsOverLimit).length,
    functionsListedLines: total(functionsOverLimit),
    ...over,
    filesOverLimit,
    functionsOverLimit,
  }
}

const agentsOk0 = 'short\n'
const fnOfLines = (name: string, n: number) => `export function ${name}() {\n${'  void 0\n'.repeat(n - 2)}}\n`

describe("today's tree against the budget", () => {
  const root = ROOT
  const b = loadBudget(root)
  const agents = existsSync(join(root, 'AGENTS.md')) ? readFileSync(join(root, 'AGENTS.md'), 'utf8') : undefined

  it('passes when AGENTS.md fits, and prints every new file or function over the limit instead of failing on it', () => {
    const r = checkBudget(buildReport(root), b, agents)
    expect(r.failures).toEqual([])
    for (const w of r.warnings) console.warn(`size warning: ${w}`)
  })

  it('keeps the limits at the values the rules document (1,000 lines, 300 lines, 12,000 characters)', () => {
    expect([b.fileLines, b.functionLines, b.agentsChars]).toEqual([1000, 300, 12000])
  })
})

describe('AGENTS.md', () => {
  const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')

  it('is under 12,000 characters', () => {
    expect(countChars(text)).toBeLessThanOrEqual(12000)
  })

  it('points only at files and folders that exist', () => {
    const noFences = text.replace(/```[\s\S]*?```/g, '')
    const spans = [...noFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '')
    const links = [...noFences.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1] ?? '')
    const words = [...spans.flatMap((s) => s.split(/\s+/)), ...links]
    const KNOWN = /\.(ts|tsx|md|json|sh|yaml|yml|example|css|swift)$/
    const candidates = words
      .map((w) => w.replace(/[,.;:]+$/, ''))
      .filter((w) => !w.startsWith('/') && !w.startsWith('-') && !/^https?:/.test(w) && !w.includes('*'))
      .filter((w) => w.includes('/') || KNOWN.test(w))
      .filter((w) => !/^\w+@/.test(w) && !/^[\w.]+\.com$/.test(w))
    expect(candidates.length).toBeGreaterThan(20) // the scan found the real references; an empty scan would prove nothing
    const missing: string[] = []
    for (const c of candidates) {
      // `{a,b}` expands; `<name>` stands for any folder name, so only the part before it is checked.
      const variants = /\{([^}]+)\}/.test(c)
        ? (/\{([^}]+)\}/.exec(c)?.[1] ?? '').split(',').map((x) => c.replace(/\{[^}]+\}/, x))
        : [c]
      for (const v of variants) {
        const cut = v.includes('<') ? v.slice(0, v.indexOf('<')) : v
        const p = cut.replace(/\/\*\*$/, '').replace(/\/$/, '')
        if (!existsSync(join(ROOT, p))) missing.push(c)
      }
    }
    expect(missing).toEqual([])
  })

  it('carries the eight contribution rules, numbered, in the "Rules for every change" section', () => {
    const section = /## Rules for every change([\s\S]*?)\n## /.exec(text)?.[1] ?? ''
    const nums = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('ties every `pnpm <script>` in its fenced commands to a script in package.json, and lists the Vitest projects that exist', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '').join('\n')
    const used = [...fenced.matchAll(/^pnpm (?!install)([\w:-]+)/gm)].map((m) => m[1] ?? '')
    const inline = [...text.matchAll(/`pnpm ([\w:-]+)`/g)].map((m) => m[1] ?? '')
    expect(used.length).toBeGreaterThan(3)
    expect([...used, ...inline].filter((n) => pkg.scripts[n] === undefined && n !== 'install')).toEqual([])
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
    const projects = [...config.matchAll(/name: '([\w-]+)'/g)].map((m) => m[1] ?? '')
    const line = /pnpm test +# Vitest: ([^\n]+)/.exec(text)?.[1] ?? ''
    const named = line.split(',').map((x) => x.trim())
    expect(projects.filter((p) => !named.includes(p))).toEqual([])
  })

  it('states the size rules as they behave: a closed list, TypeScript-only functions, growth printed by the report', () => {
    expect(text).toContain('The list is closed.')
    expect(text).toMatch(/functions are measured for TypeScript only/)
    expect(text).toContain('node scripts/size-report.ts --refresh-budget')
    expect(text).toContain('prints growth')
    const out = spawnSync(process.execPath, [join(ROOT, 'scripts/size-report.ts'), '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(out.status).toBe(0) // the flag the text names is one the script reads
    expect(readFileSync(join(ROOT, 'scripts/size-report.ts'), 'utf8')).toContain("includes('--refresh-budget')")
  })

  it('does not say the relay list covers every variable, or that .env.example is names only', () => {
    expect(text).not.toMatch(/Every environment variable/)
    expect(text).not.toMatch(/lists names only/)
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
    expect(example).toMatch(/^PUBLIC_ORIGIN=https:/m) // it carries placeholder values, so "names only" would be false
  })

  it('names the symbols it points at where it says they are', () => {
    const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8')
    expect(rd('apps/bridge/src/bridge.ts')).toContain('export const INSTRUCTIONS')
    expect(rd('packages/protocol/src/models.ts')).toContain('export const AGENT_CARD_KINDS')
    expect(rd('packages/protocol/src/models.ts')).toContain('export const BRIDGE_ONLY_CARD_KINDS')
    expect(rd('packages/protocol/src/http.ts')).toContain('export const ROUTE_LIST')
  })

  it('does not tell a newcomer to start in the original build spec, and points at the docs that matter', () => {
    expect(text).toContain('The original build spec is not part of this repository')
    for (const doc of ['SECURITY.md', 'PROTOCOL.md', 'voice.md']) expect(text).toContain(`docs/${doc}`)
  })
})

describe('ARCHITECTURE.md', () => {
  it('lists every workspace package folder and the two parts that are not packages', () => {
    const arch = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8')
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '**/package.json'], {
      cwd: ROOT,
    }).toString()
    const dirs = out
      .split('\n')
      .filter((p) => p && !p.includes('node_modules') && !p.startsWith('third_party/') && p !== 'package.json')
      .map((p) => dirname(p))
    expect(dirs.length).toBeGreaterThan(5)
    const absent = [...dirs, 'apps/desktop', 'plugins/talos-app-mod'].filter((d) => !arch.includes(`\`${d}\``))
    expect(absent).toEqual([])
  })

  it('names no build package or paths that are gone', () => {
    const arch = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8')
    expect(arch).not.toMatch(/\bWP\d/)
    const paths = [...arch.matchAll(/`((?:apps|packages|plugins|e2e)\/[\w./{},*-]+)`/g)].map((m) => m[1] ?? '')
    const gone = paths.filter((p) => !p.includes('{') && !p.includes('*')).filter((p) => !existsSync(join(ROOT, p)))
    expect(gone).toEqual([])
  })
})

describe('what counts as a line', () => {
  it('counts physical lines the way wc -l and an editor do', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('\n\n')).toBe(2)
    expect(countLines('a\r\nb\r\n')).toBe(2)
  })

  it('matches wc -l on a real file in this repo', () => {
    const f = 'scripts/size-report.ts'
    const wc = Number(execFileSync('wc', ['-l', f], { cwd: ROOT }).toString().trim().split(/\s+/)[0])
    expect(countLines(readFileSync(join(ROOT, f), 'utf8'))).toBe(wc)
  })

  it('sorts paths into the groups the report prints', () => {
    expect(groupOf('apps/web/src/lib/socketClient.ts')).toBe('core')
    expect(groupOf('apps/web/test/a.test.tsx')).toBe('tests')
    expect(groupOf('apps/bridge/test-contract/a.contract.vitest.ts')).toBe('tests')
    expect(groupOf('packages/testkit/src/fake-relay.ts')).toBe('testkit')
    expect(groupOf('apps/desktop/Sources/TalosDesktop/A.swift')).toBe('desktop')
    expect(groupOf('apps/desktop/Tests/TalosDesktopCoreTests/A.swift')).toBe('tests')
    expect(groupOf('docs/SPEC.md')).toBe('docs')
  })

  it('keeps production paths that merely contain a test-like word in production, and anchors real test folders', () => {
    // names that look like tests but are screens, resources or app code
    expect(groupOf('apps/web/src/features/review-queue.tsx')).toBe('core')
    expect(groupOf('apps/web/src/features/test/Panel.tsx')).toBe('core')
    expect(groupOf('apps/desktop/Sources/TalosDesktop/SelfTest.swift')).toBe('desktop')
    expect(groupOf('apps/bridge/src/e2e/runner.ts')).toBe('core')
    expect(groupOf('apps/bridge/scripts/review-capture-memory-xss.ts')).toBe('core')
    // real test locations, at the depths the repo uses
    expect(groupOf('apps/web/test/review/review-fixes.test.tsx')).toBe('tests')
    expect(groupOf('apps/bridge/test-contract/a.ts')).toBe('tests')
    expect(groupOf('plugins/talos-app-mod/tests/talos-mod.test.ts')).toBe('tests')
    expect(groupOf('e2e/tests/flow.ts')).toBe('tests')
    expect(groupOf('apps/mobile/ios/TalosShareCore/Tests/TalosShareCoreTests/A.swift')).toBe('tests')
    expect(groupOf('scripts/size-budget.test.ts')).toBe('tests')
  })

  it('skips art, vendored code and captured fixtures only at their real locations', () => {
    const dir = scratch({
      'assets/mascot/big.ts': { lines: 1500 },
      'third_party/x/big.ts': { lines: 1500 },
      'packages/testkit/fixtures/captured/big.json': { lines: 1500 },
      'apps/web/src/assets/Icons.tsx': { lines: 1500 },
      'apps/web/src/fixtures/Gallery.tsx': { lines: 1500 },
      'apps/web/src/captured/Frame.ts': { lines: 1500 },
    })
    const counted = buildReport(dir).files.map((f) => f.path)
    expect(counted).toEqual([
      'apps/web/src/assets/Icons.tsx',
      'apps/web/src/captured/Frame.ts',
      'apps/web/src/fixtures/Gallery.tsx',
    ])
  })
})

describe('the budget rules', () => {
  const agentsOk = 'short\n'

  it('warns on a new production file past 1,000 lines without failing, and is silent at exactly 1,000', () => {
    const ok = scratch({ 'apps/web/src/a.ts': { lines: 1000 } })
    expect(checkBudget(buildReport(ok), budget(), agentsOk).warnings).toEqual([])
    const bad = scratch({ 'apps/web/src/a.ts': { lines: 1001 } })
    const r = checkBudget(buildReport(bad), budget(), agentsOk)
    expect(r.failures).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('apps/web/src/a.ts has 1001 lines')
  })

  it('does not cap tests, docs, vendored code or captured fixtures', () => {
    const dir = scratch({
      'apps/web/test/huge.test.ts': { lines: 5000 },
      'docs/BIG.md': { lines: 5000 },
      'third_party/x/big.py': { lines: 5000 },
      'packages/testkit/fixtures/captured/a.json': { lines: 5000 },
      'apps/web/node_modules/p/index.js': { lines: 5000 },
    })
    expect(checkBudget(buildReport(dir), budget(), agentsOk).warnings).toEqual([])
  })

  it('lets a listed giant stay and even grow, and reports the growth without a warning', () => {
    const dir = scratch({ 'apps/web/src/big.ts': { lines: 1300 } })
    const r = checkBudget(buildReport(dir), budget({ filesOverLimit: { 'apps/web/src/big.ts': 1200 } }), agentsOk)
    expect(r.warnings).toEqual([])
    expect(r.growth).toEqual(['apps/web/src/big.ts grew from 1200 to 1300 lines'])
  })

  it('never warns on a listed file that shrank under the limit; it is reported as stale with the refresh command', () => {
    const dir = scratch({ 'apps/web/src/big.ts': { lines: 900 } })
    const b = budget({ filesOverLimit: { 'apps/web/src/big.ts': 1200 } })
    expect(checkBudget(buildReport(dir), b, agentsOk).warnings).toEqual([])
    const status = formatListStatus(buildReport(dir), b)
    expect(status).toContain('apps/web/src/big.ts is down to 900 lines')
    expect(status).toContain('node scripts/size-report.ts --refresh-budget')
  })

  it('a renamed giant warns as a new file, and the old entry is only reported as gone', () => {
    const dir = scratch({ 'apps/web/src/renamed.ts': { lines: 1200 } })
    const r = checkBudget(buildReport(dir), budget({ filesOverLimit: { 'apps/web/src/big.ts': 1200 } }), agentsOk)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('apps/web/src/renamed.ts has 1200 lines')
    expect(r.stale.join('\n')).toContain('apps/web/src/big.ts is on the big-file list')
  })

  it('merge skew: two PRs that trim and grow a still-over entry are quiet alone and when merged', () => {
    // The gap: refresh drops an entry taken to the limit or under, so another PR that then grows it makes main warn as new.
    // Main lists `grow` at 320 lines. PR A trims it to 310 and refreshes the list; PR B, branched earlier, adds 4 lines.
    // CI tests each head alone, so neither saw the other. The merged tree is the trimmed list plus B's lines.
    const base = budget({ functionsOverLimit: { 'apps/web/src/f.ts::grow': 320 } })
    const trimmed = scratch({ 'apps/web/src/f.ts': fnOfLines('grow', 310) })
    const listA = refreshBudget(buildReport(trimmed), base)
    expect(checkBudget(buildReport(trimmed), listA, agentsOk).warnings).toEqual([]) // PR A alone
    const grown = scratch({ 'apps/web/src/f.ts': fnOfLines('grow', 324) })
    expect(checkBudget(buildReport(grown), base, agentsOk).warnings).toEqual([]) // PR B alone
    const merged = scratch({ 'apps/web/src/f.ts': fnOfLines('grow', 314) })
    const r = checkBudget(buildReport(merged), listA, agentsOk) // main after both
    expect(r.warnings).toEqual([])
    expect(r.growth).toEqual(['apps/web/src/f.ts::grow grew from 310 to 314 lines'])
    // two PRs that each take a different listed file under the limit and refresh: still green when merged
    const two = budget({ filesOverLimit: { 'apps/web/src/a.ts': 1100, 'apps/web/src/b.ts': 1100 } })
    const bothShrunk = scratch({ 'apps/web/src/a.ts': { lines: 900 }, 'apps/web/src/b.ts': { lines: 900 } })
    expect(checkBudget(buildReport(bothShrunk), two, agentsOk).warnings).toEqual([])
  })

  it('refresh drops gone entries, lowers shrunk ones, never raises or adds, and keeps the recorded totals in step', () => {
    const dir = scratch({
      'apps/web/src/a.ts': { lines: 1500 }, // grew: stays at its recorded 1100
      'apps/web/src/b.ts': { lines: 1050 }, // shrunk, still over: lowered
      'apps/web/src/new.ts': { lines: 1300 }, // not listed: not added
      'apps/web/src/f.ts': fnOfLines('gone2', 50),
    })
    const before = budget({
      filesOverLimit: { 'apps/web/src/a.ts': 1100, 'apps/web/src/b.ts': 1200, 'apps/web/src/gone.ts': 1100 },
      functionsOverLimit: { 'apps/web/src/f.ts::gone': 400 },
    })
    const after = refreshBudget(buildReport(dir), before)
    expect(after.filesOverLimit).toEqual({ 'apps/web/src/a.ts': 1100, 'apps/web/src/b.ts': 1050 })
    expect(after.functionsOverLimit).toEqual({})
    expect([after.filesListedCount, after.filesListedLines]).toEqual([2, 2150])
    expect([after.functionsListedCount, after.functionsListedLines]).toEqual([0, 0])
  })

  it('refresh drops a listed file or function that is now at or under its limit, and the totals count what is left', () => {
    const dir = scratch({
      'apps/web/src/under.ts': { lines: 900 },
      'apps/web/src/at.ts': { lines: 1000 },
      'apps/web/src/over.ts': { lines: 1001 },
      'apps/web/src/f.ts': `${fnOfLines('small', 120)}${fnOfLines('edge', 300)}${fnOfLines('big', 301)}`,
    })
    const before = budget({
      filesOverLimit: { 'apps/web/src/under.ts': 1200, 'apps/web/src/at.ts': 1100, 'apps/web/src/over.ts': 1100 },
      functionsOverLimit: {
        'apps/web/src/f.ts::small': 400,
        'apps/web/src/f.ts::edge': 400,
        'apps/web/src/f.ts::big': 400,
      },
    })
    const report = buildReport(dir)
    const after = refreshBudget(report, before)
    expect(after.filesOverLimit).toEqual({ 'apps/web/src/over.ts': 1001 })
    expect(after.functionsOverLimit).toEqual({ 'apps/web/src/f.ts::big': 301 })
    expect([after.filesListedCount, after.filesListedLines]).toEqual([1, 1001])
    expect([after.functionsListedCount, after.functionsListedLines]).toEqual([1, 301])
    expect(compareToList(report, after).stale).toEqual([]) // nothing is left for a second refresh to drop
    expect(checkBudget(report, after, agentsOk).warnings).toEqual([])
  })

  it('the list is closed: a new entry, a raised value, or a hand-removed entry without the totals warns', () => {
    const dir = scratch({ 'apps/web/src/big.ts': { lines: 3000 } })
    const honest = budget({ filesOverLimit: {} })
    // an agent lists its own 3,000-line file in the JSON and nothing else
    const added = { ...honest, filesOverLimit: { 'apps/web/src/big.ts': 3000 } }
    const r = checkBudget(buildReport(dir), added, agentsOk)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('filesOverLimit holds 1 entries adding up to 3000 lines, but')
    expect(r.warnings[0]).toContain('The list is closed')
    // raising an existing value without touching the totals
    const raised = budget({ filesOverLimit: { 'apps/web/src/big.ts': 1500 } })
    const fails = checkBudget(
      buildReport(dir),
      { ...raised, filesOverLimit: { 'apps/web/src/big.ts': 3000 } },
      agentsOk,
    )
    expect(fails.warnings[0]).toContain('The list is closed')
    // same for functions
    const fnDir = scratch({ 'apps/web/src/f.ts': fnOfLines('big', 400) })
    const fnAdded = { ...budget(), functionsOverLimit: { 'apps/web/src/f.ts::big': 400 } }
    expect(checkBudget(buildReport(fnDir), fnAdded, agentsOk).warnings[0]).toContain(
      'functionsOverLimit holds 1 entries',
    )
    // removing an entry by hand leaves the totals above the list, so that is reported too (run the refresh command)
    const removed = { ...budget({ filesOverLimit: {} }), filesListedCount: 1, filesListedLines: 1200 }
    expect(checkBudget(buildReport(scratch({})), removed, agentsOk).warnings[0]).toContain('--refresh-budget')
  })

  it('compareToList says the same thing the report prints', () => {
    const dir = scratch({ 'apps/web/src/big.ts': { lines: 1300 }, 'apps/web/src/fresh.ts': { lines: 1200 } })
    const b = budget({ filesOverLimit: { 'apps/web/src/big.ts': 1200 } })
    const c = compareToList(buildReport(dir), b)
    expect(c.growth).toEqual(['apps/web/src/big.ts grew from 1200 to 1300 lines'])
    expect(c.newOver).toHaveLength(1)
    const text = formatListStatus(buildReport(dir), b)
    expect(text).toContain('Listed giants that grew')
    expect(text).toContain('apps/web/src/big.ts grew from 1200 to 1300 lines')
    expect(text).toContain('New and over the limit')
  })

  it('warns on a new function past 300 lines, is silent at exactly 300, and lets a listed one stay', () => {
    const at = scratch({ 'apps/web/src/f.ts': fnOfLines('fine', 300) })
    expect(checkBudget(buildReport(at), budget(), agentsOk).warnings).toEqual([])
    const over = scratch({ 'apps/web/src/f.ts': fnOfLines('tooBig', 301) })
    const r = checkBudget(buildReport(over), budget(), agentsOk)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('apps/web/src/f.ts::tooBig has 301 lines')
    const listed = checkBudget(
      buildReport(over),
      budget({ functionsOverLimit: { 'apps/web/src/f.ts::tooBig': 301 } }),
      agentsOk,
    )
    expect(listed.warnings).toEqual([])
  })

  it('never warns on a listed function that shrank or vanished; both are reported as stale', () => {
    const dir = scratch({ 'apps/web/src/f.ts': fnOfLines('tooBig', 120) })
    const shrunk = checkBudget(
      buildReport(dir),
      budget({ functionsOverLimit: { 'apps/web/src/f.ts::tooBig': 400 } }),
      agentsOk,
    )
    expect(shrunk.warnings).toEqual([])
    expect(shrunk.stale[0]).toContain('is down to 120 lines')
    const gone = checkBudget(
      buildReport(dir),
      budget({ functionsOverLimit: { 'apps/web/src/f.ts::other': 400 } }),
      agentsOk,
    )
    expect(gone.warnings).toEqual([])
    expect(gone.stale[0]).toContain('no longer exists under that name')
  })

  it('does not cap functions in tests or in the testkit', () => {
    const dir = scratch({
      'apps/web/test/t.test.ts': fnOfLines('suite', 900),
      'packages/testkit/src/contract/c.ts': fnOfLines('defineContract', 900),
    })
    expect(checkBudget(buildReport(dir), budget(), agentsOk).warnings).toEqual([])
  })

  it('fails when AGENTS.md is missing or past 12,000 characters, counting characters and not bytes', () => {
    const dir = scratch({ 'apps/web/src/a.ts': 'export {}\n' })
    expect(checkBudget(buildReport(dir), budget(), undefined).failures[0]).toContain('AGENTS.md is missing')
    expect(checkBudget(buildReport(dir), budget(), 'x'.repeat(12001)).failures[0]).toContain('12001 characters')
    expect(checkBudget(buildReport(dir), budget(), 'x'.repeat(12000)).failures).toEqual([])
    const accented = 'é'.repeat(12000) // 24,000 bytes, 12,000 characters
    expect(checkBudget(buildReport(dir), budget(), accented).failures).toEqual([])
    const emoji = '😀'.repeat(12001) // 2 UTF-16 units each; still 12,001 characters
    expect(checkBudget(buildReport(dir), budget(), emoji).failures[0]).toContain('12001 characters')
  })
})

describe('function sizes', () => {
  it('names functions, methods, arrow constants and nested functions, and skips unnamed callbacks', () => {
    const src = [
      'export function top() {',
      '  const inner = () => {',
      '    return 1',
      '  }',
      '  setTimeout(() => {',
      '    void 0',
      '  }, 1)',
      '  return inner()',
      '}',
      'class Box {',
      '  run() {',
      '    return 2',
      '  }',
      '}',
      'export const arrow = async () => 3',
    ].join('\n')
    const got = Object.fromEntries(measureFunctions('p.ts', src).map((f) => [f.id, f.lines]))
    expect(got).toEqual({ 'p.ts::top': 9, 'p.ts::top>inner': 3, 'p.ts::Box.run': 3, 'p.ts::arrow': 1 })
  })

  it('names module-level functions that have no name of their own after their export or variable', () => {
    const body = (n: number) => `{\n${'  void 0\n'.repeat(n)}}`
    const src = (decl: string) => `${decl}\n`
    const cases: [string, string][] = [
      ['memo', `export const Card = memo((props: P) => ${body(4)})`],
      ['forwardRef', `export const Field = forwardRef<H, P>(function (props, ref) ${body(4)})`],
      ['default function', `export default function () ${body(4)}`],
      ['default arrow', `export default () => ${body(4)}`],
      ['default wrapped', `export default memo((p) => ${body(4)})`],
      ['cast', `export const handler = (() => ${body(4)}) as Handler`],
      ['satisfies', `export const other = (async () => ${body(4)}) satisfies Handler`],
    ]
    const names: Record<string, string> = {
      memo: 'Card',
      forwardRef: 'Field',
      'default function': 'default',
      'default arrow': 'default',
      'default wrapped': 'default',
      cast: 'handler',
      satisfies: 'other',
    }
    for (const [label, decl] of cases) {
      const got = measureFunctions('p.tsx', src(decl))
      expect(
        got.map((f) => f.id),
        label,
      ).toEqual([`p.tsx::${names[label]}`])
      expect(got[0]?.lines, label).toBe(6)
    }
    // a callback inside a named function stays part of that function, and a bare call at module level stays unnamed
    const nested = measureFunctions(
      'p.ts',
      `export function outer() {\n  const v = items.map(() => 1)\n  return v\n}\nsetup(() => {\n  void 0\n})\n`,
    )
    expect(nested.map((f) => f.id)).toEqual(['p.ts::outer'])
  })

  it('counts an unnamed export default function toward the 300-line limit', () => {
    const dir = scratch({
      'apps/web/src/Big.tsx': `export default memo((p: P) => {\n${'  void 0\n'.repeat(310)}})\n`,
    })
    const r = checkBudget(buildReport(dir), budget(), agentsOk0)
    expect(r.warnings.join('\n')).toContain('apps/web/src/Big.tsx::default has 312 lines')
  })

  it('measures TSX, and one unreadable file degrades only itself', () => {
    expect(measureFunctions('a.tsx', 'export const A = () => <div>\n  hi\n</div>\n').map((f) => f.lines)).toEqual([3])
    const dir = scratch({
      'apps/web/src/broken.ts': 'export function ((( { {{{ ]]]\n',
      'apps/web/src/ok.ts': fnOfLines('tooBig', 305),
    })
    const r = checkBudget(buildReport(dir), budget(), 'x')
    expect(r.warnings.join('\n')).toContain('apps/web/src/ok.ts::tooBig has 305 lines')
  })

  it('counts same-named functions in one file separately', () => {
    const src =
      'export function f() {\n}\nclass A {\n  f() {\n  }\n}\nfunction f2() {}\nclass B {\n  f() {}\n  f() {}\n}\n'
    const ids = measureFunctions('p.ts', src).map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('which files are looked at', () => {
  it('in a git checkout counts tracked files only: a file that is not added, or is ignored, is left out', () => {
    const dir = scratch(
      {
        '.gitignore': 'apps/web/src/ignored.ts\n',
        'apps/web/src/tracked.ts': { lines: 1100 },
        'apps/web/src/untracked.ts': { lines: 1100 },
        'apps/web/src/ignored.ts': { lines: 1100 },
        '.dd/Build/Generated.swift': { lines: 5000 }, // what the mobile CI job writes into the tree
      },
      true,
    )
    execFileSync('git', ['add', 'apps/web/src/tracked.ts'], { cwd: dir })
    const r = checkBudget(buildReport(dir), budget(), 'x')
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('apps/web/src/tracked.ts')
    expect(buildReport(dir).files.map((f) => f.path)).toEqual(['apps/web/src/tracked.ts'])
  })

  it('reads a file whose name has a space, a quote or a newline in it', () => {
    const dir = scratch(
      {
        'apps/web/src/a b.ts': { lines: 5 },
        'apps/web/src/q"uote.ts': { lines: 5 },
        'apps/web/src/n\nl.ts': { lines: 1100 },
      },
      true,
    )
    execFileSync('git', ['add', '-A'], { cwd: dir })
    const files = buildReport(dir).files.map((f) => f.path)
    expect(files).toContain('apps/web/src/a b.ts')
    expect(files).toContain('apps/web/src/q"uote.ts')
    expect(checkBudget(buildReport(dir), budget(), 'x').warnings[0]).toContain('has 1100 lines')
  })
})

describe('the budget file', () => {
  it('is refused loudly when malformed, never read as an empty budget', () => {
    const bad = scratch({ 'scripts/size-budget.json': '{"fileLines": 1000}' })
    expect(() => loadBudget(bad)).toThrow(/functionLines must be a positive integer/)
    const noTotals = scratch({
      'scripts/size-budget.json': JSON.stringify({
        fileLines: 1000,
        functionLines: 300,
        agentsChars: 12000,
        filesOverLimit: {},
        functionsOverLimit: {},
      }),
    })
    expect(() => loadBudget(noTotals)).toThrow(/filesListedCount must be a whole number/)
    const worse = scratch({
      'scripts/size-budget.json': JSON.stringify({ ...budget(), filesOverLimit: { 'a.ts': 'lots' } }),
    })
    expect(() => loadBudget(worse)).toThrow(/filesOverLimit\["a.ts"\]/)
    const missing = scratch({})
    expect(() => loadBudget(missing)).toThrow()
  })

  it('is accepted when well formed, extra keys included (a newer file does not break an older reader)', () => {
    const ok = scratch({ 'scripts/size-budget.json': JSON.stringify({ ...budget(), note: 'x' }) })
    expect(loadBudget(ok).fileLines).toBe(1000)
  })
})

describe('the size report script', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts/size-report.ts'), ...args], { cwd: ROOT, encoding: 'utf8' })

  it('prints the same counts the budget check uses, and exits 0', () => {
    const b = loadBudget(ROOT)
    const out = run()
    expect(out.status).toBe(0)
    expect(out.stdout).toContain(`Production files over 1,000 lines: ${Object.keys(b.filesOverLimit).length}`)
    expect(out.stdout).toContain(
      `Production TypeScript functions over 300 lines: ${Object.keys(b.functionsOverLimit).length}`,
    )
    expect(out.stdout).toMatch(/^core\s+\d+\s+[\d,]+$/m)
  })

  it('prints growth of a listed giant and stale entries, and exits 0 (a quiet-looking test warning is not the only place)', () => {
    const dir = scratch(
      {
        'apps/web/src/big.ts': { lines: 1300 },
        'apps/web/src/shrunk.ts': { lines: 400 },
        'scripts/size-budget.json': JSON.stringify(
          budget({ filesOverLimit: { 'apps/web/src/big.ts': 1200, 'apps/web/src/shrunk.ts': 1100 } }),
        ),
      },
      true,
    )
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts/size-report.ts'), readFileSync(join(ROOT, 'scripts/size-report.ts')))
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
    execFileSync('git', ['add', 'apps', 'scripts/size-budget.json', 'scripts/size-report.ts'], { cwd: dir })
    const out = spawnSync(process.execPath, [join(dir, 'scripts/size-report.ts')], { cwd: dir, encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('Listed giants that grew')
    expect(out.stdout).toContain('apps/web/src/big.ts grew from 1200 to 1300 lines')
    expect(out.stdout).toContain('apps/web/src/shrunk.ts is down to 400 lines')
    expect(out.stdout).toContain('--refresh-budget')
    // the refresh command rewrites the list in the scratch copy only
    const fix = spawnSync(process.execPath, [join(dir, 'scripts/size-report.ts'), '--refresh-budget'], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(fix.status).toBe(0)
    const after = JSON.parse(readFileSync(join(dir, 'scripts/size-budget.json'), 'utf8')) as Budget
    expect(after.filesOverLimit).toEqual({ 'apps/web/src/big.ts': 1200 }) // shrunk.ts is under the limit: dropped
    expect([after.filesListedCount, after.filesListedLines]).toEqual([1, 1200])
  })

  it('exits 1 and says why when the budget file is unreadable, never a clean report', () => {
    const dir = scratch({ 'apps/web/src/a.ts': { lines: 3 }, 'scripts/size-budget.json': '{"fileLines": 1}' }, true)
    writeFileSync(join(dir, 'scripts/size-report.ts'), readFileSync(join(ROOT, 'scripts/size-report.ts')))
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
    execFileSync('git', ['add', '-A'], { cwd: dir })
    const out = spawnSync(process.execPath, [join(dir, 'scripts/size-report.ts')], { cwd: dir, encoding: 'utf8' })
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('scripts/size-budget.json')
  })

  it('gives the same totals as JSON, from the same code', () => {
    const out = run('--json')
    expect(out.status).toBe(0)
    const json = JSON.parse(out.stdout) as { totals: Record<string, number>; filesOver1000: unknown[] }
    expect(json.totals.core).toBe(buildReport(ROOT).totals.core)
    expect(json.filesOver1000).toHaveLength(Object.keys(loadBudget(ROOT).filesOverLimit).length)
  })
})
